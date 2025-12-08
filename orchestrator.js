/** @param {NS} ns */

import { getAllServers, categorizeServers } from "/utils/scanner.js";
import { tryNuke } from "/utils/nuker.js";

const WORKER_SCRIPTS = ["hack.js", "grow.js", "weaken.js"];
const SECURITY_THRESHOLD = 5;  // How much above min security before we prioritize weaken
const MONEY_THRESHOLD = 0.75;  // Grow until we have 75% of max money
const CYCLE_DELAY = 10000;     // 10 seconds between cycles
const MAX_ACTIVITY_LOG = 8;    // How many recent activities to show

// Persistent activity log (survives across cycles)
const activityLog = [];

/**
 * Parse command line arguments
 * @param {NS} ns
 * @returns {object} Parsed flags
 */
function parseArgs(ns) {
  const flags = {
    ignoreHome: false
  };
  
  for (const arg of ns.args) {
    if (arg === "-ignoreHome" || arg === "--ignoreHome") {
      flags.ignoreHome = true;
    }
  }
  
  return flags;
}

/**
 * Get states for all targets using prediction, sorted by profitability
 * @param {NS} ns
 * @param {string[]} targetServers
 * @param {string[]} runnerServers
 * @returns {object[]}
 */
function getAllTargetStates(ns, targetServers, runnerServers) {
  const states = [];
  const inFlightThreads = getInFlightThreads(ns, runnerServers);
  
  for (const target of targetServers) {
    // Only include targets we can actually hack
    if (ns.hasRootAccess(target)) {
      const state = assessTargetStateWithPrediction(ns, target, inFlightThreads);
      if (state.canHack) {
        states.push(state);
      }
    }
  }
  
  // Sort by profit score descending
  states.sort((a, b) => b.profitScore - a.profitScore);
  
  return states;
}

/**
 * Calculate available threads on a runner for a given script
 * @param {NS} ns
 * @param {string} runner
 * @param {string} scriptName
 * @returns {number}
 */
function calculateAvailableThreads(ns, runner, scriptName) {
  const maxRam = ns.getServerMaxRam(runner);
  const usedRam = ns.getServerUsedRam(runner);
  const scriptRam = ns.getScriptRam(scriptName);
  
  if (scriptRam === 0) return 0;
  
  return Math.floor((maxRam - usedRam) / scriptRam);
}

/**
 * Deploy worker scripts to all runner servers
 * @param {NS} ns
 * @param {string[]} runnerServers
 */
function deployWorkerScripts(ns, runnerServers) {
  for (const runner of runnerServers) {
    ns.scp(WORKER_SCRIPTS, runner, "home");
  }
}

/**
 * Add an entry to the activity log
 * @param {string} message
 */
function logActivity(message) {
  const timestamp = new Date().toLocaleTimeString();
  activityLog.unshift(`[${timestamp}] ${message}`);
  
  // Keep log size bounded
  while (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.pop();
  }
}

/**
 * Get currently running tasks aggregated by action+target
 * @param {NS} ns
 * @param {string[]} runnerServers
 * @returns {Map<string, number>} Map of "ACTION target" -> total threads
 */
function getRunningTasks(ns, runnerServers) {
  const tasks = new Map();
  
  for (const runner of runnerServers) {
    const processes = ns.ps(runner);
    
    for (const proc of processes) {
      if (!WORKER_SCRIPTS.includes(proc.filename)) continue;
      
      const action = proc.filename.replace('.js', '').toUpperCase();
      const target = proc.args[0];
      const key = `${action} ${target}`;
      
      tasks.set(key, (tasks.get(key) || 0) + proc.threads);
    }
  }
  
  return tasks;
}

/**
 * Get in-flight thread counts per target per action
 * @param {NS} ns
 * @param {string[]} runnerServers
 * @returns {Map<string, {hack: number, grow: number, weaken: number}>}
 */
function getInFlightThreads(ns, runnerServers) {
  const inFlight = new Map();
  
  for (const runner of runnerServers) {
    const processes = ns.ps(runner);
    
    for (const proc of processes) {
      if (!WORKER_SCRIPTS.includes(proc.filename)) continue;
      
      const action = proc.filename.replace('.js', '');
      const target = proc.args[0];
      
      if (!inFlight.has(target)) {
        inFlight.set(target, { hack: 0, grow: 0, weaken: 0 });
      }
      
      inFlight.get(target)[action] += proc.threads;
    }
  }
  
  return inFlight;
}

/**
 * Predict the state of a target after in-flight operations complete
 * @param {NS} ns
 * @param {string} target
 * @param {{hack: number, grow: number, weaken: number}} threads
 * @returns {{predictedMoney: number, predictedSecurity: number}}
 */
function predictTargetState(ns, target, threads) {
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  
  // Predict security changes
  // weaken reduces by 0.05 per thread
  // hack increases by 0.002 per thread
  // grow increases by 0.004 per thread
  const securityFromWeaken = threads.weaken * 0.05;
  const securityFromHack = threads.hack * 0.002;
  const securityFromGrow = threads.grow * 0.004;
  
  let predictedSecurity = currentSecurity - securityFromWeaken + securityFromHack + securityFromGrow;
  predictedSecurity = Math.max(minSecurity, predictedSecurity);
  
  // Predict money changes
  // This is trickier - grow multiplier depends on server and threads
  // hack steals a percentage based on hackAnalyze
  
  let predictedMoney = currentMoney;
  
  // Estimate hack effect (each thread steals hackAnalyze % of current money)
  if (threads.hack > 0) {
    const hackPercent = ns.hackAnalyze(target);
    const totalHackPercent = Math.min(1, hackPercent * threads.hack);
    predictedMoney *= (1 - totalHackPercent);
  }
  
  // Estimate grow effect
  // growthAnalyze is tricky - it takes (target, growthMultiplier, cores) and returns threads needed
  // We need to estimate the other direction: given threads, what's the multiplier?
  // Use a simpler approximation: grow roughly doubles money with ~25 threads at low security
  // The actual formula involves server growth rate and security level
  if (threads.grow > 0 && predictedMoney > 0) {
    // Approximate growth multiplier based on thread count
    // This is a simplification - actual growth depends on server growthRate and security
    const serverGrowth = ns.getServerGrowth(target);
    // Base formula approximation: each thread can multiply money by ~(1 + serverGrowth/100) at min security
    // At higher security, effectiveness is reduced
    const securityPenalty = 1 + (currentSecurity - minSecurity) * 0.02;
    const baseGrowthPerThread = 1 + (serverGrowth / 100) / securityPenalty;
    const growMultiplier = Math.pow(baseGrowthPerThread, threads.grow / 10);
    predictedMoney = Math.min(maxMoney, predictedMoney * growMultiplier);
  }
  
  return {
    predictedMoney: Math.max(0, predictedMoney),
    predictedSecurity
  };
}

/**
 * Assess target state using predicted values from in-flight operations
 * @param {NS} ns
 * @param {string} target
 * @param {Map<string, {hack: number, grow: number, weaken: number}>} inFlightThreads
 * @returns {object} Target state with priority based on predicted state
 */
function assessTargetStateWithPrediction(ns, target, inFlightThreads) {
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const hackChance = ns.hackAnalyzeChance(target);
  
  // Get in-flight threads for this target
  const threads = inFlightThreads.get(target) || { hack: 0, grow: 0, weaken: 0 };
  
  // Get predicted state after in-flight operations complete
  const { predictedMoney, predictedSecurity } = predictTargetState(ns, target, threads);
  
  const predictedMoneyPercent = maxMoney > 0 ? predictedMoney / maxMoney : 0;
  const predictedSecurityDelta = predictedSecurity - minSecurity;
  
  // Current state (for display)
  const currentMoneyPercent = maxMoney > 0 ? currentMoney / maxMoney : 0;
  const currentSecurityDelta = currentSecurity - minSecurity;
  
  // Determine priority based on PREDICTED state
  let priority;
  if (predictedSecurityDelta > SECURITY_THRESHOLD) {
    priority = "weaken";
  } else if (predictedMoneyPercent < MONEY_THRESHOLD) {
    priority = "grow";
  } else {
    priority = "hack";
  }
  
  // Calculate profitability score using predicted values
  const profitScore = maxMoney * hackChance * (1 - predictedSecurityDelta / 100);
  
  return {
    server: target,
    priority,
    // Current values (for display)
    moneyPercent: currentMoneyPercent,
    securityDelta: currentSecurityDelta,
    currentMoney,
    maxMoney,
    // Predicted values
    predictedMoneyPercent,
    predictedSecurityDelta,
    predictedMoney,
    predictedSecurity,
    // In-flight info
    inFlightThreads: threads,
    // Other
    hackChance,
    profitScore,
    canHack: ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(target)
  };
}

/**
 * Assign tasks to fill available RAM (does not kill running scripts)
 * @param {NS} ns
 * @param {object[]} targetStates
 * @param {string[]} runnerServers
 * @returns {object} Summary of new assignments
 */
function assignTasks(ns, targetStates, runnerServers) {
  const newAssignments = [];
  let newThreads = { hack: 0, grow: 0, weaken: 0 };
  
  // Assign tasks to available RAM on each runner
  for (const target of targetStates) {
    const scriptName = target.priority + ".js";
    const scriptRam = ns.getScriptRam(scriptName);
    
    if (scriptRam === 0) continue;
    
    for (const runner of runnerServers) {
      const availableRam = ns.getServerMaxRam(runner) - ns.getServerUsedRam(runner);
      const threads = Math.floor(availableRam / scriptRam);
      
      if (threads > 0) {
        const pid = ns.exec(scriptName, runner, threads, target.server);
        
        if (pid > 0) {
          newAssignments.push({
            script: scriptName,
            runner,
            threads,
            target: target.server,
            pid
          });
          
          newThreads[target.priority] += threads;
        }
      }
    }
  }
  
  // Log new assignments aggregated by action+target
  const aggregated = new Map();
  for (const a of newAssignments) {
    const action = a.script.replace('.js', '').toUpperCase();
    const key = `${action} ${a.target}`;
    aggregated.set(key, (aggregated.get(key) || 0) + a.threads);
  }
  
  for (const [key, threads] of aggregated) {
    logActivity(`Started ${key} (${threads}t)`);
  }
  
  return { newAssignments, newThreads };
}

/**
 * Print a status summary
 * @param {NS} ns
 * @param {object[]} targetStates
 * @param {string[]} runnerServers
 * @param {object} taskSummary
 * @param {boolean} includeHome
 */
function printStatus(ns, targetStates, runnerServers, taskSummary, includeHome) {
  ns.clearLog();
  
  ns.print("═══════════════════════════════════════════");
  ns.print("           DISTRIBUTED ORCHESTRATOR        ");
  ns.print("═══════════════════════════════════════════");
  ns.print("");
  
  // Runner summary
  let totalRam = 0;
  let usedRam = 0;
  for (const runner of runnerServers) {
    totalRam += ns.getServerMaxRam(runner);
    usedRam += ns.getServerUsedRam(runner);
  }
  const homeStatus = includeHome ? "" : " (home excluded)";
  ns.print(`🖥️  Runners: ${runnerServers.length}${homeStatus} | RAM: ${usedRam.toFixed(0)}/${totalRam.toFixed(0)} GB`);
  
  // Get all currently running tasks
  const runningTasks = getRunningTasks(ns, runnerServers);
  
  // Tally total threads by action type
  let totalByAction = { HACK: 0, GROW: 0, WEAKEN: 0 };
  for (const [key, threads] of runningTasks) {
    const action = key.split(' ')[0];
    totalByAction[action] = (totalByAction[action] || 0) + threads;
  }
  
  ns.print(`📊 Running: H:${totalByAction.HACK} G:${totalByAction.GROW} W:${totalByAction.WEAKEN}`);
  ns.print("");
  
  // Top targets with current priorities
  ns.print("─── TOP TARGETS (priority based on prediction) ───");
  const topTargets = targetStates.slice(0, 5);
  for (const t of topTargets) {
    const moneyStr = `${(t.moneyPercent * 100).toFixed(0)}%→${(t.predictedMoneyPercent * 100).toFixed(0)}%`;
    const secStr = `+${t.securityDelta.toFixed(1)}→${t.predictedSecurityDelta.toFixed(1)}`;
    const actionIcon = t.priority === "hack" ? "💰" : t.priority === "grow" ? "📈" : "🔓";
    ns.print(`${actionIcon} ${t.server}: $${moneyStr} | ${secStr} sec`);
  }
  
  // Currently running tasks
  ns.print("");
  ns.print("─── RUNNING TASKS ───");
  if (runningTasks.size === 0) {
    ns.print("  (no tasks running)");
  } else {
    // Sort by thread count descending
    const sorted = [...runningTasks.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, threads] of sorted.slice(0, 8)) {
      ns.print(`  ${key} (${threads}t)`);
    }
    if (sorted.length > 8) {
      ns.print(`  ... and ${sorted.length - 8} more`);
    }
  }
  
  // Recent activity log
  ns.print("");
  ns.print("─── RECENT ACTIVITY ───");
  if (activityLog.length === 0) {
    ns.print("  (waiting for activity...)");
  } else {
    for (const entry of activityLog) {
      ns.print(`  ${entry}`);
    }
  }
  
  ns.print("");
  ns.print(`Last update: ${new Date().toLocaleTimeString()}`);
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();
  
  const flags = parseArgs(ns);
  const includeHome = !flags.ignoreHome;
  
  ns.print("Starting Distributed Orchestrator...");
  ns.print(`  Home RAM: ${includeHome ? "ENABLED" : "DISABLED"}`);
  ns.print("");
  
  while (true) {
    // 1. Scan network
    const allServers = getAllServers(ns);
    
    // 2. Try to nuke everything
    for (const server of allServers) {
      const hadRoot = ns.hasRootAccess(server);
      if (tryNuke(ns, server) && !hadRoot) {
        logActivity(`Gained root on ${server}`);
      }
    }
    
    // 3. Categorize servers (pass includeHome flag)
    const { targetServers, runnerServers } = categorizeServers(ns, allServers, includeHome);
    
    // 4. Deploy worker scripts
    deployWorkerScripts(ns, runnerServers);
    
    // 5. Assess all targets (with prediction based on in-flight tasks)
    const targetStates = getAllTargetStates(ns, targetServers, runnerServers);
    
    // 6. Assign and execute tasks
    const taskSummary = assignTasks(ns, targetStates, runnerServers);
    
    // 7. Print status
    printStatus(ns, targetStates, runnerServers, taskSummary, includeHome);
    
    // 8. Wait before next cycle
    await ns.sleep(CYCLE_DELAY);
  }
}
