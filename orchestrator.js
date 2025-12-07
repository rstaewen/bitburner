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
 * Check completed scripts and log their results before killing
 * @param {NS} ns
 * @param {string[]} runnerServers
 */
function harvestCompletedScripts(ns, runnerServers) {
  for (const runner of runnerServers) {
    for (const script of WORKER_SCRIPTS) {
      // Get all running instances of this script on this runner
      const processes = ns.ps(runner).filter(p => p.filename === script);
      
      for (const proc of processes) {
        // Check if script is still running (has threads)
        // We can't directly check completion, but we can log what was running
        const target = proc.args[0];
        const threads = proc.threads;
        
        // Get current state of target to see if we made progress
        const currentSec = ns.getServerSecurityLevel(target);
        const minSec = ns.getServerMinSecurityLevel(target);
        const currentMoney = ns.getServerMoneyAvailable(target);
        const maxMoney = ns.getServerMaxMoney(target);
        
        const action = script.replace('.js', '');
        const secDelta = (currentSec - minSec).toFixed(1);
        const moneyPct = ((currentMoney / maxMoney) * 100).toFixed(0);
        
        logActivity(`${action.toUpperCase()} ${target} (${threads}t) | sec:+${secDelta} money:${moneyPct}%`);
      }
    }
  }
}

/**
 * Kill all worker scripts on all runners
 * @param {NS} ns
 * @param {string[]} runnerServers
 */
function killAllWorkers(ns, runnerServers) {
  for (const runner of runnerServers) {
    for (const script of WORKER_SCRIPTS) {
      //ns.scriptKill(script, runner);
    }
  }
}

/**
 * Assign and execute tasks across all runners
 * @param {NS} ns
 * @param {object[]} targetStates
 * @param {string[]} runnerServers
 * @returns {object} Summary of assignments
 */
function assignTasks(ns, targetStates, runnerServers) {
  // Harvest info from running scripts before killing them
  harvestCompletedScripts(ns, runnerServers);
  
  // Kill existing workers for clean slate
  killAllWorkers(ns, runnerServers);
  
  // Give a moment for scripts to die
  // (In practice, scriptKill is synchronous but let's be safe)
  
  const assignments = [];
  let totalThreads = { hack: 0, grow: 0, weaken: 0 };
  
  // Track remaining capacity per runner
  const runnerCapacity = new Map();
  for (const runner of runnerServers) {
    const maxRam = ns.getServerMaxRam(runner);
    const usedRam = ns.getServerUsedRam(runner);
    runnerCapacity.set(runner, maxRam - usedRam);
  }
  
  // Assign tasks to runners based on target priorities
  for (const target of targetStates) {
    const scriptName = target.priority + ".js";
    const scriptRam = ns.getScriptRam(scriptName);
    
    if (scriptRam === 0) continue;
    
    for (const runner of runnerServers) {
      const availableRam = runnerCapacity.get(runner);
      const threads = Math.floor(availableRam / scriptRam);
      
      if (threads > 0) {
        const pid = ns.exec(scriptName, runner, threads, target.server);
        
        if (pid > 0) {
          assignments.push({
            script: scriptName,
            runner,
            threads,
            target: target.server,
            pid
          });
          
          totalThreads[target.priority] += threads;
          runnerCapacity.set(runner, availableRam - (threads * scriptRam));
        }
      }
    }
  }
  
  return { assignments, totalThreads };
}

/**
 * Print a status summary
 * @param {NS} ns
 * @param {object[]} targetStates
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
  
  // Thread summary
  const tt = taskSummary.totalThreads;
  ns.print(`📊 Threads: H:${tt.hack} G:${tt.grow} W:${tt.weaken}`);
  ns.print("");
  
  // Top targets
  ns.print("─── TOP TARGETS ───");
  const topTargets = targetStates.slice(0, 5);
  for (const t of topTargets) {
    const moneyStr = `$${ns.formatNumber(t.currentMoney)}/${ns.formatNumber(t.maxMoney)}`;
    const secStr = `+${t.securityDelta.toFixed(1)} sec`;
    const actionIcon = t.priority === "hack" ? "💰" : t.priority === "grow" ? "📈" : "🔓";
    ns.print(`${actionIcon} ${t.server}: ${moneyStr} | ${secStr}`);
  }
  
  // Activity log
  ns.print("");
  ns.print("─── RECENT ACTIVITY ───");
  if (activityLog.length === 0) {
    ns.print("  (waiting for first cycle to complete...)");
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