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
 * Assess the current state of a target server and determine priority action
 * @param {NS} ns
 * @param {string} target
 * @returns {object} Target state with priority
 */
function assessTargetState(ns, target) {
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const hackChance = ns.hackAnalyzeChance(target);
  
  const moneyPercent = maxMoney > 0 ? currentMoney / maxMoney : 0;
  const securityDelta = currentSecurity - minSecurity;
  
  // Determine priority action
  let priority;
  if (securityDelta > SECURITY_THRESHOLD) {
    priority = "weaken";
  } else if (moneyPercent < MONEY_THRESHOLD) {
    priority = "grow";
  } else {
    priority = "hack";
  }
  
  // Calculate a profitability score for sorting
  // Higher is better - factors in money, hack chance, and current readiness
  const profitScore = maxMoney * hackChance * (1 - securityDelta / 100);
  
  return {
    server: target,
    priority,
    moneyPercent,
    securityDelta,
    currentMoney,
    maxMoney,
    hackChance,
    profitScore,
    canHack: ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(target)
  };
}

/**
 * Get states for all targets, sorted by profitability
 * @param {NS} ns
 * @param {string[]} targetServers
 * @returns {object[]}
 */
function getAllTargetStates(ns, targetServers) {
  const states = [];
  
  for (const target of targetServers) {
    // Only include targets we can actually hack
    if (ns.hasRootAccess(target)) {
      const state = assessTargetState(ns, target);
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
 */
function printStatus(ns, targetStates, runnerServers, taskSummary) {
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
  ns.print(`🖥️  Runners: ${runnerServers.length} | RAM: ${usedRam.toFixed(0)}/${totalRam.toFixed(0)} GB`);
  
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
  ns.print("─── TOP TARGETS ───");
  const topTargets = targetStates.slice(0, 5);
  for (const t of topTargets) {
    const moneyStr = `$${ns.formatNumber(t.currentMoney)}/${ns.formatNumber(t.maxMoney)}`;
    const secStr = `+${t.securityDelta.toFixed(1)} sec`;
    const actionIcon = t.priority === "hack" ? "💰" : t.priority === "grow" ? "📈" : "🔓";
    ns.print(`${actionIcon} ${t.server}: ${moneyStr} | ${secStr}`);
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
  
  ns.print("Starting Distributed Orchestrator...");
  
  while (true) {
    // 1. Scan network
    const allServers = getAllServers(ns);
    
    // 2. Try to nuke everything
    for (const server of allServers) {
      const hadRoot = ns.hasRootAccess(server);
      if (tryNuke(ns, server) && !hadRoot) {
        ns.print(`[+] Gained root on ${server}`);
      }
    }
    
    // 3. Categorize servers
    const { targetServers, runnerServers } = categorizeServers(ns, allServers);
    
    // 4. Deploy worker scripts
    deployWorkerScripts(ns, runnerServers);
    
    // 5. Assess all targets
    const targetStates = getAllTargetStates(ns, targetServers);
    
    // 6. Assign and execute tasks
    const taskSummary = assignTasks(ns, targetStates, runnerServers);
    
    // 7. Print status
    printStatus(ns, targetStates, runnerServers, taskSummary);
    
    // 8. Wait before next cycle
    await ns.sleep(CYCLE_DELAY);
  }
}