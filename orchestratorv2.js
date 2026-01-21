/** @param {NS} ns */

import { getAllServers, categorizeServers } from "/utils/scanner.js";
import { tryNuke } from "/utils/nuker.js";
import { getNexusTargetRam } from "server-upgrader.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

const CYCLE_DELAY = 1000;              // 1 second between orchestrator cycles
const MAX_ACTIVITY_LOG = 12;           // Recent activity entries to display
const INFO_FILE = '/data/orchestrator-info.json';
const RESERVED_SERVERS = ["nexus"];    // Excluded from worker deployment
const BACKDOOR_SCRIPT = "utils/backdoor-sluts.js";
const BACKDOOR_WARN_COOLDOWN = 300000; // 5 minutes

// Worker scripts
const WORKER_SCRIPTS = ["hack.js", "grow.js", "weaken.js"];
const SHARE_SCRIPT = "share.js";

// Thresholds - these define when we consider a server "prepped"
const SECURITY_THRESHOLD = 1;          // Max extra security before we consider unprepped
const MONEY_THRESHOLD = 0.90;          // Min money ratio before we consider unprepped

// Prep allocation - don't starve cycling servers
const MAX_PREP_THREAD_RATIO = 0.60;    // Max 60% of threads for prep tasks

// Target goals for operations
const TARGET_MONEY_AFTER_HACK = 0.05;  // Hack down to 5% of max
const TARGET_MONEY_AFTER_GROW = 1.0;   // Grow to 100% of max

// Priority prep targets - servers to prep first due to good ROI at various hacking levels
// Format: { name: string, minHackLevel: number }
const PRIORITY_PREP_TARGETS = [
  { name: "joesguns", minHackLevel: 0 },
  { name: "n00dles", minHackLevel: 0 },
  { name: "harakiri-sushi", minHackLevel: 40 },
  { name: "hong-fang-tea", minHackLevel: 30 },
  { name: "nectar-net", minHackLevel: 20 },
  { name: "silver-helix", minHackLevel: 150 },
  { name: "omega-net", minHackLevel: 200 },
  { name: "phantasy", minHackLevel: 100 },
  { name: "max-hardware", minHackLevel: 80 },
  { name: "iron-gym", minHackLevel: 100 },
];

// =============================================================================
// SERVER STATE MACHINE
// =============================================================================

/**
 * @typedef {'UNPREPPED' | 'PREPPING' | 'READY' | 'HACKING' | 'WEAKEN_AFTER_HACK' | 'GROWING' | 'WEAKEN_AFTER_GROW'} ServerPhase
 */

/**
 * @typedef {Object} ServerState
 * @property {string} name
 * @property {ServerPhase} phase
 * @property {number} batchStartTime - When current batch started (0 if none)
 * @property {number} batchEndTime - Expected completion time (0 if none)
 * @property {string} batchType - Current batch type: 'weaken', 'grow', 'hack', or ''
 * @property {number} batchThreads - Threads allocated to current batch
 * @property {number} profitScore - Cached profitability score
 */

/** @type {Map<string, ServerState>} */
const serverStates = new Map();

/**
 * Initialize or get server state
 * @param {string} name
 * @returns {ServerState}
 */
function getServerState(name) {
  if (!serverStates.has(name)) {
    serverStates.set(name, {
      name,
      phase: 'UNPREPPED',
      batchStartTime: 0,
      batchEndTime: 0,
      batchType: '',
      batchThreads: 0,
      profitScore: 0
    });
  }
  return serverStates.get(name);
}

/**
 * Check if a server is currently busy (has a batch in flight)
 * Uses time estimate - actual script completion is verified separately
 * @param {ServerState} state
 * @returns {boolean}
 */
function isServerBusy(state) {
  if (state.batchEndTime === 0) return false;
  // Add 500ms buffer for timing variance
  return Date.now() < (state.batchEndTime + 500);
}

/**
 * Check if any worker scripts are currently targeting a server
 * @param {NS} ns
 * @param {string[]} runners
 * @param {string} target
 * @returns {{hack: number, grow: number, weaken: number}}
 */
function getRunningThreadsForTarget(ns, runners, target) {
  const threads = { hack: 0, grow: 0, weaken: 0 };
  
  for (const runner of runners) {
    for (const proc of ns.ps(runner)) {
      if (!WORKER_SCRIPTS.includes(proc.filename)) continue;
      if (proc.args[0] !== target) continue;
      
      const action = proc.filename.replace('.js', '');
      threads[action] += proc.threads;
    }
  }
  
  return threads;
}

/**
 * Check if a server has any worker scripts running against it
 * @param {NS} ns
 * @param {string[]} runners
 * @param {string} target
 * @returns {boolean}
 */
function hasRunningScripts(ns, runners, target) {
  const threads = getRunningThreadsForTarget(ns, runners, target);
  return threads.hack > 0 || threads.grow > 0 || threads.weaken > 0;
}

/**
 * Get all running batches by scanning all runners for worker scripts
 * Returns map of target -> {type, threads, runners}
 * @param {NS} ns
 * @param {string[]} runners
 * @returns {Map<string, {hack: number, grow: number, weaken: number}>}
 */
function getAllRunningBatches(ns, runners) {
  const batches = new Map();
  
  for (const runner of runners) {
    for (const proc of ns.ps(runner)) {
      if (!WORKER_SCRIPTS.includes(proc.filename)) continue;
      
      const target = proc.args[0];
      if (!target) continue;
      
      if (!batches.has(target)) {
        batches.set(target, { hack: 0, grow: 0, weaken: 0 });
      }
      
      const action = proc.filename.replace('.js', '');
      batches.get(target)[action] += proc.threads;
    }
  }
  
  return batches;
}

/**
 * Mark a batch as started
 * @param {ServerState} state
 * @param {string} batchType
 * @param {number} durationMs
 * @param {number} threads
 */
function startBatch(state, batchType, durationMs, threads) {
  state.batchStartTime = Date.now();
  state.batchEndTime = Date.now() + durationMs;
  state.batchType = batchType;
  state.batchThreads = threads;
}

/**
 * Clear batch tracking (called when batch completes)
 * @param {ServerState} state
 */
function clearBatch(state) {
  state.batchStartTime = 0;
  state.batchEndTime = 0;
  state.batchType = '';
  state.batchThreads = 0;
}

// =============================================================================
// ACTIVITY LOGGING
// =============================================================================

const activityLog = [];
let lastBackdoorWarning = 0;

/**
 * Add an entry to the activity log
 * @param {string} message
 */
function logActivity(message) {
  const timestamp = new Date().toLocaleTimeString();
  activityLog.unshift(`[${timestamp}] ${message}`);
  while (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.pop();
  }
}

// =============================================================================
// THREAD CALCULATIONS (Using Formulas API)
// =============================================================================

/**
 * Calculate threads needed to weaken from current security to min
 * @param {NS} ns
 * @param {string} target
 * @returns {number}
 */
function calcWeakenThreads(ns, target) {
  const current = ns.getServerSecurityLevel(target);
  const min = ns.getServerMinSecurityLevel(target);
  const delta = current - min;
  
  if (delta <= 0) return 0;
  
  // Each weaken thread removes 0.05 security (with core bonus on home)
  // ns.weakenAnalyze(threads, cores) gives actual reduction
  // We'll use home's cores for estimation
  const homeCores = ns.getServer("home").cpuCores;
  const reductionPerThread = ns.weakenAnalyze(1, homeCores);
  
  return Math.ceil(delta / reductionPerThread);
}

/**
 * Calculate threads needed to grow from current money to max
 * @param {NS} ns
 * @param {string} target
 * @returns {number}
 */
function calcGrowThreads(ns, target) {
  const current = ns.getServerMoneyAvailable(target);
  const max = ns.getServerMaxMoney(target);
  
  if (current >= max * MONEY_THRESHOLD) return 0;
  if (current <= 0) {
    // Server is at $0, need to bootstrap - use growthAnalyze with large multiplier
    // This is an edge case; we'll estimate conservatively
    return Math.ceil(ns.growthAnalyze(target, max, ns.getServer("home").cpuCores));
  }
  
  const multiplierNeeded = max / current;
  const homeCores = ns.getServer("home").cpuCores;
  
  // Use formulas API for accurate calculation
  const server = ns.getServer(target);
  const player = ns.getPlayer();
  
  return Math.ceil(ns.formulas.hacking.growThreads(server, player, max, homeCores));
}

/**
 * Calculate threads needed to hack from current money down to target percentage
 * @param {NS} ns
 * @param {string} target
 * @returns {number}
 */
function calcHackThreads(ns, target) {
  const current = ns.getServerMoneyAvailable(target);
  const max = ns.getServerMaxMoney(target);
  
  if (current <= max * TARGET_MONEY_AFTER_HACK) return 0;
  
  const server = ns.getServer(target);
  const player = ns.getPlayer();
  
  // hackPercent gives fraction stolen per thread
  const hackPercent = ns.formulas.hacking.hackPercent(server, player);
  if (hackPercent <= 0) return 0;
  
  // We want to steal down to TARGET_MONEY_AFTER_HACK of max
  const targetMoney = max * TARGET_MONEY_AFTER_HACK;
  const toSteal = current - targetMoney;
  
  // Each thread steals hackPercent * current
  // threads * hackPercent * current >= toSteal
  // threads >= toSteal / (hackPercent * current)
  const threadsNeeded = Math.ceil(toSteal / (hackPercent * current));
  
  return threadsNeeded;
}

/**
 * Calculate security increase from hack/grow operations
 * @param {string} action - 'hack' or 'grow'
 * @param {number} threads
 * @returns {number} Security increase
 */
function calcSecurityIncrease(action, threads) {
  // hack: 0.002 per thread, grow: 0.004 per thread
  if (action === 'hack') return threads * 0.002;
  if (action === 'grow') return threads * 0.004;
  return 0;
}

/**
 * Calculate weaken threads needed to counter security increase
 * @param {NS} ns
 * @param {number} securityIncrease
 * @returns {number}
 */
function calcCounterWeakenThreads(ns, securityIncrease) {
  if (securityIncrease <= 0) return 0;
  const homeCores = ns.getServer("home").cpuCores;
  const reductionPerThread = ns.weakenAnalyze(1, homeCores);
  return Math.ceil(securityIncrease / reductionPerThread);
}

// =============================================================================
// SERVER ASSESSMENT
// =============================================================================

/**
 * Check if server is prepped (low security, high money)
 * @param {NS} ns
 * @param {string} target
 * @returns {boolean}
 */
function isServerPrepped(ns, target) {
  const security = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const money = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  
  const securityOk = (security - minSecurity) <= SECURITY_THRESHOLD;
  const moneyOk = maxMoney === 0 || (money / maxMoney) >= MONEY_THRESHOLD;
  
  return securityOk && moneyOk;
}

/**
 * Calculate profitability score for a target
 * @param {NS} ns
 * @param {string} target
 * @returns {number}
 */
function calcProfitScore(ns, target) {
  const server = ns.getServer(target);
  const player = ns.getPlayer();
  
  const maxMoney = ns.getServerMaxMoney(target);
  const hackChance = ns.formulas.hacking.hackChance(server, player);
  const hackTime = ns.formulas.hacking.hackTime(server, player);
  
  // Simple score: money * chance / time
  // Higher is better
  if (hackTime <= 0) return 0;
  
  return (maxMoney * hackChance) / hackTime;
}

/**
 * Get all hackable targets sorted by priority
 * @param {NS} ns
 * @param {string[]} targetServers
 * @returns {string[]}
 */
function getSortedTargets(ns, targetServers) {
  const hackLevel = ns.getHackingLevel();
  
  // Filter to hackable targets and calculate scores
  const scored = [];
  for (const target of targetServers) {
    if (!ns.hasRootAccess(target)) continue;
    if (ns.getServerRequiredHackingLevel(target) > hackLevel) continue;
    if (ns.getServerMaxMoney(target) <= 0) continue;
    
    const score = calcProfitScore(ns, target);
    scored.push({ target, score });
    
    // Update cached score in state
    const state = getServerState(target);
    state.profitScore = score;
  }
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  return scored.map(s => s.target);
}

/**
 * Get prep targets in priority order
 * @param {NS} ns
 * @param {string[]} unprepedServers
 * @returns {string[]}
 */
function getPriorityPrepTargets(ns, unprepedServers) {
  const hackLevel = ns.getHackingLevel();
  
  // Build priority list based on config
  const priorityNames = PRIORITY_PREP_TARGETS
    .filter(p => p.minHackLevel <= hackLevel)
    .map(p => p.name);
  
  // Partition into priority and non-priority
  const priority = [];
  const rest = [];
  
  for (const server of unprepedServers) {
    if (priorityNames.includes(server)) {
      priority.push(server);
    } else {
      rest.push(server);
    }
  }
  
  // Sort priority by their order in config
  priority.sort((a, b) => {
    const aIdx = priorityNames.indexOf(a);
    const bIdx = priorityNames.indexOf(b);
    return aIdx - bIdx;
  });
  
  // Sort rest by profit score
  rest.sort((a, b) => {
    const stateA = getServerState(a);
    const stateB = getServerState(b);
    return stateB.profitScore - stateA.profitScore;
  });
  
  return [...priority, ...rest];
}

// =============================================================================
// RUNNER MANAGEMENT
// =============================================================================

/**
 * Get runner servers sorted by cores (descending)
 * @param {NS} ns
 * @param {string[]} runners
 * @returns {{name: string, cores: number, availableRam: number}[]}
 */
function getSortedRunners(ns, runners) {
  const result = [];
  
  for (const runner of runners) {
    const maxRam = ns.getServerMaxRam(runner);
    const usedRam = ns.getServerUsedRam(runner);
    const availableRam = maxRam - usedRam;
    const cores = ns.getServer(runner).cpuCores;
    
    if (availableRam > 0) {
      result.push({ name: runner, cores, availableRam });
    }
  }
  
  // Sort by cores descending
  result.sort((a, b) => b.cores - a.cores);
  
  return result;
}

/**
 * Calculate total available threads for a script across all runners
 * @param {NS} ns
 * @param {string[]} runners
 * @param {string} scriptName
 * @returns {number}
 */
function getTotalAvailableThreads(ns, runners, scriptName) {
  const scriptRam = ns.getScriptRam(scriptName);
  if (scriptRam <= 0) return 0;
  
  let total = 0;
  for (const runner of runners) {
    const available = ns.getServerMaxRam(runner) - ns.getServerUsedRam(runner);
    total += Math.floor(available / scriptRam);
  }
  
  return total;
}

/**
 * Deploy worker scripts to all runners
 * @param {NS} ns
 * @param {string[]} runners
 */
function deployWorkerScripts(ns, runners) {
  for (const runner of runners) {
    ns.scp([...WORKER_SCRIPTS, SHARE_SCRIPT], runner, "home");
  }
}

/**
 * Execute a script across multiple runners, using high-core servers first
 * @param {NS} ns
 * @param {string} script
 * @param {number} totalThreads
 * @param {string} target
 * @param {{name: string, cores: number, availableRam: number}[]} runners - Will be mutated!
 * @returns {number} Actual threads deployed
 */
function executeDistributed(ns, script, totalThreads, target, runners) {
  const scriptRam = ns.getScriptRam(script);
  if (scriptRam <= 0 || totalThreads <= 0) return 0;
  
  let deployed = 0;
  
  for (const runner of runners) {
    if (deployed >= totalThreads) break;
    
    const maxThreads = Math.floor(runner.availableRam / scriptRam);
    if (maxThreads <= 0) continue;
    
    const threadsToRun = Math.min(maxThreads, totalThreads - deployed);
    
    // Execute with optional delay parameter (0 for now - sequential execution)
    const pid = ns.exec(script, runner.name, threadsToRun, target, 0);
    
    if (pid > 0) {
      deployed += threadsToRun;
      runner.availableRam -= threadsToRun * scriptRam;
    }
  }
  
  return deployed;
}

// =============================================================================
// BATCH EXECUTION
// =============================================================================

/**
 * Execute a prep batch (weaken and/or grow to get server ready)
 * @param {NS} ns
 * @param {string} target
 * @param {{name: string, cores: number, availableRam: number}[]} runners
 * @param {number} maxThreads - Thread budget for this prep
 * @returns {{deployed: number, type: string, duration: number}}
 */
function executePrepBatch(ns, target, runners, maxThreads) {
  const state = getServerState(target);
  
  // Determine what prep is needed
  const weakenNeeded = calcWeakenThreads(ns, target);
  const growNeeded = calcGrowThreads(ns, target);
  
  // Prioritize weaken if security is high
  if (weakenNeeded > 0) {
    const threads = Math.min(weakenNeeded, maxThreads);
    const deployed = executeDistributed(ns, "weaken.js", threads, target, runners);
    
    if (deployed > 0) {
      const duration = ns.getWeakenTime(target);
      startBatch(state, 'weaken', duration, deployed);
      state.phase = 'PREPPING';
      const timeStr = formatDuration(duration);
      logActivity(`🔓 PREP WEAKEN ${target}: ${deployed}t, ${timeStr}`);
      return { deployed, type: 'weaken', duration };
    }
  } else if (growNeeded > 0) {
    const threads = Math.min(growNeeded, maxThreads);
    const deployed = executeDistributed(ns, "grow.js", threads, target, runners);
    
    if (deployed > 0) {
      const duration = ns.getGrowTime(target);
      startBatch(state, 'grow', duration, deployed);
      state.phase = 'PREPPING';
      const timeStr = formatDuration(duration);
      logActivity(`📈 PREP GROW ${target}: ${deployed}t, ${timeStr}`);
      return { deployed, type: 'grow', duration };
    }
  }
  
  return { deployed: 0, type: '', duration: 0 };
}

/**
 * Format duration in human-readable form, flagging suspicious values
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const seconds = ms / 1000;
  if (seconds < 5) {
    // Suspiciously short - flag it
    return `${seconds.toFixed(1)}s ⚠️`;
  } else if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  } else if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m${secs}s`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h${mins}m`;
  }
}

/**
 * Debug: Get operation times for a target
 * @param {NS} ns
 * @param {string} target
 * @returns {string}
 */
function getDebugTimes(ns, target) {
  const hackTime = ns.getHackTime(target);
  const growTime = ns.getGrowTime(target);
  const weakenTime = ns.getWeakenTime(target);
  const security = ns.getServerSecurityLevel(target);
  const minSec = ns.getServerMinSecurityLevel(target);
  
  return `H:${(hackTime/1000).toFixed(1)}s G:${(growTime/1000).toFixed(1)}s W:${(weakenTime/1000).toFixed(1)}s Sec:${security.toFixed(1)}/${minSec}`;
}

/**
 * Execute a hack cycle batch
 * Returns after the full hack -> weaken sequence completes
 * @param {NS} ns
 * @param {string} target
 * @param {{name: string, cores: number, availableRam: number}[]} runners
 * @returns {{deployed: number, type: string, duration: number}}
 */
function executeHackBatch(ns, target, runners) {
  const state = getServerState(target);
  
  const hackThreads = calcHackThreads(ns, target);
  if (hackThreads <= 0) {
    // Nothing to hack, transition to grow
    state.phase = 'GROWING';
    return { deployed: 0, type: '', duration: 0 };
  }
  
  const deployed = executeDistributed(ns, "hack.js", hackThreads, target, runners);
  
  if (deployed > 0) {
    const duration = ns.getHackTime(target);
    startBatch(state, 'hack', duration, deployed);
    state.phase = 'HACKING';
    
    const expectedSteal = ns.hackAnalyze(target) * deployed * ns.getServerMoneyAvailable(target);
    const timeStr = formatDuration(duration);
    logActivity(`💰 HACK ${target}: ${deployed}t → $${ns.formatNumber(expectedSteal)}, ${timeStr}`);
    
    return { deployed, type: 'hack', duration };
  }
  
  return { deployed: 0, type: '', duration: 0 };
}

/**
 * Execute post-hack weaken to clean up security
 * @param {NS} ns
 * @param {string} target
 * @param {number} hackThreadsUsed
 * @param {{name: string, cores: number, availableRam: number}[]} runners
 * @returns {{deployed: number, type: string, duration: number}}
 */
function executePostHackWeaken(ns, target, hackThreadsUsed, runners) {
  const state = getServerState(target);
  
  const securityIncrease = calcSecurityIncrease('hack', hackThreadsUsed);
  const weakenNeeded = calcCounterWeakenThreads(ns, securityIncrease);
  
  if (weakenNeeded <= 0) {
    state.phase = 'GROWING';
    return { deployed: 0, type: '', duration: 0 };
  }
  
  const deployed = executeDistributed(ns, "weaken.js", weakenNeeded, target, runners);
  
  if (deployed > 0) {
    const duration = ns.getWeakenTime(target);
    startBatch(state, 'weaken', duration, deployed);
    state.phase = 'WEAKEN_AFTER_HACK';  // New phase to track this step
    logActivity(`🔓 POST-HACK WEAKEN ${target}: ${deployed}t, ${formatDuration(duration)}`);
    return { deployed, type: 'weaken', duration };
  }
  
  return { deployed: 0, type: '', duration: 0 };
}

/**
 * Execute a grow cycle batch
 * @param {NS} ns
 * @param {string} target
 * @param {{name: string, cores: number, availableRam: number}[]} runners
 * @returns {{deployed: number, type: string, duration: number}}
 */
function executeGrowBatch(ns, target, runners) {
  const state = getServerState(target);
  
  const growThreads = calcGrowThreads(ns, target);
  if (growThreads <= 0) {
    // Already at max money, go back to hack
    state.phase = 'READY';
    return { deployed: 0, type: '', duration: 0 };
  }
  
  const deployed = executeDistributed(ns, "grow.js", growThreads, target, runners);
  
  if (deployed > 0) {
    const duration = ns.getGrowTime(target);
    startBatch(state, 'grow', duration, deployed);
    state.phase = 'GROWING';
    
    const timeStr = formatDuration(duration);
    logActivity(`📈 GROW ${target}: ${deployed}t, ${timeStr}`);
    return { deployed, type: 'grow', duration };
  }
  
  return { deployed: 0, type: '', duration: 0 };
}

/**
 * Execute post-grow weaken to clean up security
 * @param {NS} ns
 * @param {string} target
 * @param {number} growThreadsUsed
 * @param {{name: string, cores: number, availableRam: number}[]} runners
 * @returns {{deployed: number, type: string, duration: number}}
 */
function executePostGrowWeaken(ns, target, growThreadsUsed, runners) {
  const state = getServerState(target);
  
  const securityIncrease = calcSecurityIncrease('grow', growThreadsUsed);
  const weakenNeeded = calcCounterWeakenThreads(ns, securityIncrease);
  
  if (weakenNeeded <= 0) {
    state.phase = 'READY';
    return { deployed: 0, type: '', duration: 0 };
  }
  
  const deployed = executeDistributed(ns, "weaken.js", weakenNeeded, target, runners);
  
  if (deployed > 0) {
    const duration = ns.getWeakenTime(target);
    startBatch(state, 'weaken', duration, deployed);
    state.phase = 'WEAKEN_AFTER_GROW';  // New phase to track this step
    logActivity(`🔓 POST-GROW WEAKEN ${target}: ${deployed}t, ${formatDuration(duration)}`);
    return { deployed, type: 'weaken', duration };
  }
  
  return { deployed: 0, type: '', duration: 0 };
}

// =============================================================================
// SHARE TASK MANAGEMENT
// =============================================================================

/**
 * Kill all running share scripts to reclaim RAM
 * @param {NS} ns
 * @param {string[]} runners
 */
function terminateShareTasks(ns, runners) {
  for (const runner of runners) {
    for (const proc of ns.ps(runner)) {
      if (proc.filename === SHARE_SCRIPT) {
        ns.kill(proc.pid);
      }
    }
  }
}

/**
 * Deploy share scripts to use remaining RAM
 * @param {NS} ns
 * @param {{name: string, cores: number, availableRam: number}[]} runners
 * @returns {number} Total share threads deployed
 */
function deployShareTasks(ns, runners) {
  const scriptRam = ns.getScriptRam(SHARE_SCRIPT);
  if (scriptRam <= 0) return 0;
  
  let total = 0;
  
  for (const runner of runners) {
    const threads = Math.floor(runner.availableRam / scriptRam);
    if (threads <= 0) continue;
    
    const pid = ns.exec(SHARE_SCRIPT, runner.name, threads);
    if (pid > 0) {
      total += threads;
      runner.availableRam -= threads * scriptRam;
    }
  }
  
  return total;
}

// =============================================================================
// INFO FILE & BACKDOOR
// =============================================================================

/**
 * Write orchestrator info for external scripts
 * @param {NS} ns
 * @param {object} stats
 */
async function writeOrchestratorInfo(ns, stats) {
  const info = {
    timestamp: Date.now(),
    shareThreads: stats.shareThreads,
    totalThreads: stats.totalThreads,
    hackingThreads: stats.hackingThreads,
    prepThreads: stats.prepThreads,
    cycleThreads: stats.cycleThreads,
    saturated: stats.saturated,
    preppedServers: stats.preppedServers,
    preppingServers: stats.preppingServers,
    cyclingServers: stats.cyclingServers
  };
  
  await ns.write(INFO_FILE, JSON.stringify(info), 'w');
  
  // Copy to nexus if it exists
  if (ns.serverExists("nexus")) {
    ns.scp(INFO_FILE, "nexus");
  }
}

/**
 * Try to spawn backdoor script
 * @param {NS} ns
 */
function trySpawnBackdoor(ns) {
  if (!ns.serverExists("nexus")) return;
  if (ns.isRunning(BACKDOOR_SCRIPT, "nexus")) return;
  
  const pid = ns.exec(BACKDOOR_SCRIPT, "nexus", 1);
  if (pid > 0) {
    logActivity(`🔑 Backdoor script started`);
  } else if (Date.now() - lastBackdoorWarning > BACKDOOR_WARN_COOLDOWN) {
    ns.tprint("⚠️ Backdoor script failed to launch");
    lastBackdoorWarning = Date.now();
  }
}

/**
 * Get reserved servers that have sufficient RAM
 * @param {NS} ns
 * @returns {string[]}
 */
function getReservedServers(ns) {
  const ready = [];
  for (const name of RESERVED_SERVERS) {
    if (!ns.serverExists(name)) continue;
    const server = ns.getServer(name);
    if (server.maxRam >= getNexusTargetRam(ns)) {
      ready.push(name);
    }
  }
  return ready;
}

// =============================================================================
// STATUS DISPLAY
// =============================================================================

/**
 * Print status to log window
 * @param {NS} ns
 * @param {object} stats
 * @param {string[]} runners
 */
function printStatus(ns, stats, runners) {
  ns.clearLog();
  
  ns.print("═══════════════════════════════════════════");
  ns.print("        ORCHESTRATOR v2 (State Machine)    ");
  ns.print("═══════════════════════════════════════════");
  ns.print("");
  
  // Runner summary
  let totalRam = 0;
  let usedRam = 0;
  for (const runner of runners) {
    totalRam += ns.getServerMaxRam(runner);
    usedRam += ns.getServerUsedRam(runner);
  }
  ns.print(`🖥️  Runners: ${runners.length} | RAM: ${ns.formatRam(usedRam)}/${ns.formatRam(totalRam)}`);
  ns.print(`🎮 Hacking Level: ${ns.getHackingLevel()}`);
  
  // Show sample operation times for a reference server
  const sampleTarget = "n00dles";
  if (ns.serverExists(sampleTarget)) {
    ns.print(`⏱️  Times (${sampleTarget}): ${getDebugTimes(ns, sampleTarget)}`);
  }
  
  // Server state summary
  ns.print(`📊 Prepped: ${stats.preppedServers} | Prepping: ${stats.preppingServers} | Cycling: ${stats.cyclingServers}`);
  ns.print(`🧵 Threads: Prep=${stats.prepThreads} Cycle=${stats.cycleThreads} Share=${stats.shareThreads}`);
  ns.print(`📋 Budget: PrepCap=${stats.prepCapacity} PrepRunning=${stats.prepThreads} Available=${stats.availableThreads}`);
  
  if (stats.saturated) {
    ns.print(`✅ SATURATED - All useful work assigned`);
  }
  
  ns.print("");
  
  // Active batches - get from ACTUAL running scripts, not state estimates
  ns.print("─── ACTIVE BATCHES (from process list) ───");
  const runningBatches = getAllRunningBatches(ns, runners);
  
  if (runningBatches.size === 0) {
    ns.print("  (no worker scripts running)");
  } else {
    // Convert to array and sort by total threads
    const batchList = [];
    for (const [target, threads] of runningBatches) {
      const total = threads.hack + threads.grow + threads.weaken;
      const state = serverStates.get(target);
      const phase = state?.phase || 'UNKNOWN';
      batchList.push({ target, threads, total, phase });
    }
    batchList.sort((a, b) => b.total - a.total);
    
    for (const batch of batchList.slice(0, 12)) {
      const parts = [];
      if (batch.threads.hack > 0) parts.push(`H:${batch.threads.hack}`);
      if (batch.threads.grow > 0) parts.push(`G:${batch.threads.grow}`);
      if (batch.threads.weaken > 0) parts.push(`W:${batch.threads.weaken}`);
      
      const isPrep = batch.phase === 'PREPPING' || batch.phase === 'UNPREPPED';
      const phaseStr = isPrep ? '[PREP]' : '';
      
      ns.print(`  ${batch.target} ${phaseStr}: ${parts.join(' ')} (${batch.total}t)`);
    }
    if (batchList.length > 12) {
      ns.print(`  ... and ${batchList.length - 12} more targets`);
    }
  }
  
  ns.print("");
  
  // Recent activity
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

// =============================================================================
// MAIN ORCHESTRATION LOOP
// =============================================================================

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();
  
  ns.print("Starting Orchestrator v2...");
  ns.print(`  Reserved Servers: ${RESERVED_SERVERS.join(", ")}`);
  ns.print(`  Prep Thread Ratio: ${MAX_PREP_THREAD_RATIO * 100}%`);
  ns.print("");
  
  while (true) {
    // =========================================================================
    // PHASE 1: Network Scan & Setup
    // =========================================================================
    
    const allServers = getAllServers(ns);
    
    // Try to nuke everything
    for (const server of allServers) {
      const hadRoot = ns.hasRootAccess(server);
      if (tryNuke(ns, server) && !hadRoot) {
        logActivity(`🔓 Gained root: ${server}`);
      }
    }
    
    // Try backdoor script
    trySpawnBackdoor(ns);
    
    // Categorize servers (always include home)
    let { targetServers, runnerServers } = categorizeServers(ns, allServers, true);
    
    // Filter out reserved servers
    const reserved = getReservedServers(ns);
    runnerServers = runnerServers.filter(s => !reserved.includes(s));
    
    // Deploy worker scripts
    deployWorkerScripts(ns, runnerServers);
    
    // Kill share tasks to reclaim RAM for real work
    // Share is just filler - it should never block prep or cycle tasks
    terminateShareTasks(ns, runnerServers);
    
    // Get sorted runner list (high cores first)
    let runners = getSortedRunners(ns, runnerServers);
    
    // =========================================================================
    // PHASE 2: Recover State from Running Scripts
    // =========================================================================
    
    // Scan for running worker scripts and recover state
    // This handles script restarts and orphaned batches
    const runningBatches = getAllRunningBatches(ns, runnerServers);
    
    for (const [target, threads] of runningBatches) {
      const state = getServerState(target);
      const total = threads.hack + threads.grow + threads.weaken;
      
      // If we have running scripts but no tracked batch, recover state
      if (state.batchEndTime === 0 && total > 0) {
        // Determine what type of batch this is
        let batchType = '';
        let duration = 0;
        
        if (threads.hack > 0) {
          batchType = 'hack';
          duration = ns.getHackTime(target);
          state.phase = 'HACKING';
        } else if (threads.grow > 0) {
          batchType = 'grow';
          duration = ns.getGrowTime(target);
          // Could be prep or cycle grow - check if server is prepped
          state.phase = isServerPrepped(ns, target) ? 'GROWING' : 'PREPPING';
        } else if (threads.weaken > 0) {
          batchType = 'weaken';
          duration = ns.getWeakenTime(target);
          state.phase = 'PREPPING'; // Weaken is usually prep
        }
        
        if (batchType) {
          // Estimate when it will finish (assume it just started - conservative)
          startBatch(state, batchType, duration, total);
          logActivity(`🔄 Recovered ${batchType} batch: ${target} (${total}t)`);
        }
      }
    }
    
    // =========================================================================
    // PHASE 3: Categorize Targets by State
    // =========================================================================
    
    const sortedTargets = getSortedTargets(ns, targetServers);
    
    const prepped = [];      // Ready for cycling (or ready for next cycle step)
    const prepping = [];     // Currently being prepped (busy)
    const needsPrep = [];    // Unprepped and idle
    const cycling = [];      // Currently in hack/grow cycle (busy)
    
    for (const target of sortedTargets) {
      const state = getServerState(target);
      
      // Check if there are actually scripts running against this target
      const hasScripts = hasRunningScripts(ns, runnerServers, target);
      
      // If scripts are running, mark as busy
      if (hasScripts) {
        if (state.phase === 'PREPPING' || state.phase === 'UNPREPPED') {
          prepping.push(target);
        } else {
          cycling.push(target);
        }
        continue;
      }
      
      // No scripts running - check state to determine next action
      // Key insight: these phases mean we're mid-cycle,
      // even if the server doesn't look "prepped" right now (due to security increase)
      const cyclingPhases = ['HACKING', 'WEAKEN_AFTER_HACK', 'GROWING', 'WEAKEN_AFTER_GROW'];
      
      if (cyclingPhases.includes(state.phase)) {
        // Mid-cycle server that just finished an operation
        // It goes to prepped[] so Phase 5 can handle the next step
        prepped.push(target);
        continue;
      }
      
      // Clear any stale batch tracking
      if (state.batchEndTime > 0) {
        clearBatch(state);
      }
      
      // For READY, PREPPING (just finished), or UNPREPPED states,
      // check actual server state to determine category
      if (isServerPrepped(ns, target)) {
        state.phase = 'READY';
        prepped.push(target);
      } else {
        state.phase = 'UNPREPPED';
        needsPrep.push(target);
      }
    }
    
    // =========================================================================
    // PHASE 4: Calculate Thread Budget
    // =========================================================================
    
    // Calculate total thread CAPACITY (not just available)
    const weakenRam = ns.getScriptRam("weaken.js");
    let totalCapacity = 0;
    for (const runner of runnerServers) {
      totalCapacity += Math.floor(ns.getServerMaxRam(runner) / weakenRam);
    }
    
    // Get currently running prep threads
    let runningPrepThreads = 0;
    for (const [target, threads] of runningBatches) {
      const state = serverStates.get(target);
      if (state?.phase === 'PREPPING' || state?.phase === 'UNPREPPED') {
        runningPrepThreads += threads.hack + threads.grow + threads.weaken;
      }
    }
    
    // Prep budget is 60% of TOTAL capacity, minus what's already running
    const maxPrepThreads = Math.floor(totalCapacity * MAX_PREP_THREAD_RATIO);
    const remainingPrepBudget = Math.max(0, maxPrepThreads - runningPrepThreads);
    
    // Available threads for NEW deployments this cycle
    const availableThreads = getTotalAvailableThreads(ns, runnerServers, "weaken.js");
    
    // Actual prep budget is the minimum of remaining budget and available RAM
    const prepBudget = Math.min(remainingPrepBudget, availableThreads);
    const cycleBudget = Math.max(0, availableThreads - prepBudget);
    
    let prepThreadsUsed = 0;
    let cycleThreadsUsed = 0;
    let hackingThreads = 0;
    
    // =========================================================================
    // PHASE 4: Handle State Transitions for Cycling Servers
    // =========================================================================
    
    // For servers that just finished a batch, trigger the next step
    for (const target of [...prepped]) {
      const state = getServerState(target);
      
      // Check for state transitions that need follow-up actions
      if (state.phase === 'HACKING') {
        // Just finished hack, need post-hack weaken
        const hackThreadsUsed = state.batchThreads || 1;
        clearBatch(state);
        
        runners = getSortedRunners(ns, runnerServers);
        const result = executePostHackWeaken(ns, target, hackThreadsUsed, runners);
        if (result.deployed > 0) {
          cycleThreadsUsed += result.deployed;
          // Move from prepped to cycling
          const idx = prepped.indexOf(target);
          if (idx >= 0) prepped.splice(idx, 1);
          cycling.push(target);
        } else {
          // No weaken needed, go straight to grow
          state.phase = 'GROWING';
        }
      } else if (state.phase === 'WEAKEN_AFTER_HACK') {
        // Just finished post-hack weaken, now need to grow
        clearBatch(state);
        state.phase = 'GROWING';
        // Will be handled in Phase 7 as a "ready to grow" server
      } else if (state.phase === 'GROWING') {
        // Just finished grow, need post-grow weaken
        const growThreadsUsed = state.batchThreads || 1;
        clearBatch(state);
        
        runners = getSortedRunners(ns, runnerServers);
        const result = executePostGrowWeaken(ns, target, growThreadsUsed, runners);
        if (result.deployed > 0) {
          cycleThreadsUsed += result.deployed;
          const idx = prepped.indexOf(target);
          if (idx >= 0) prepped.splice(idx, 1);
          cycling.push(target);
        } else {
          // No weaken needed, back to ready
          state.phase = 'READY';
        }
      } else if (state.phase === 'WEAKEN_AFTER_GROW') {
        // Just finished post-grow weaken, back to ready for hack
        clearBatch(state);
        state.phase = 'READY';
      }
    }
    
    // =========================================================================
    // PHASE 6: Start New Prep Batches
    // =========================================================================
    
    // Get priority-sorted prep targets
    const prepTargets = getPriorityPrepTargets(ns, needsPrep);
    
    for (const target of prepTargets) {
      const state = getServerState(target);
      
      // Skip if this server already has scripts running (shouldn't happen but safety check)
      if (hasRunningScripts(ns, runnerServers, target)) {
        continue;
      }
      
      // Check thread budget
      const remainingBudget = prepBudget - prepThreadsUsed;
      if (remainingBudget <= 0) break;
      
      // Refresh runner list (might have changed)
      runners = getSortedRunners(ns, runnerServers);
      if (runners.length === 0) break;
      
      // Don't deploy tiny batches - minimum 10 threads or skip
      const minThreads = 10;
      if (remainingBudget < minThreads) break;
      
      const result = executePrepBatch(ns, target, runners, remainingBudget);
      if (result.deployed > 0) {
        prepThreadsUsed += result.deployed;
      }
    }
    
    // =========================================================================
    // PHASE 7: Start New Cycle Batches (Hack or Grow)
    // =========================================================================
    
    // Process prepped servers that are ready or need grow
    for (const target of prepped) {
      const state = getServerState(target);
      
      // Skip if scripts are running (safety check)
      if (hasRunningScripts(ns, runnerServers, target)) continue;
      
      // Handle READY and GROWING phases
      if (state.phase !== 'READY' && state.phase !== 'GROWING') continue;
      
      // Refresh runner list
      runners = getSortedRunners(ns, runnerServers);
      if (runners.length === 0) break;
      
      if (state.phase === 'GROWING') {
        // Server is mid-cycle and needs grow
        const result = executeGrowBatch(ns, target, runners);
        if (result.deployed > 0) {
          cycleThreadsUsed += result.deployed;
        }
      } else {
        // READY phase - decide: hack or grow?
        const money = ns.getServerMoneyAvailable(target);
        const maxMoney = ns.getServerMaxMoney(target);
        const moneyRatio = maxMoney > 0 ? money / maxMoney : 0;
        
        if (moneyRatio >= MONEY_THRESHOLD) {
          // Ready to hack
          const result = executeHackBatch(ns, target, runners);
          if (result.deployed > 0) {
            cycleThreadsUsed += result.deployed;
            hackingThreads += result.deployed;
          }
        } else {
          // Need to grow first (shouldn't happen often for READY servers)
          const result = executeGrowBatch(ns, target, runners);
          if (result.deployed > 0) {
            cycleThreadsUsed += result.deployed;
          }
        }
      }
    }
    
    // =========================================================================
    // PHASE 8: Deploy Share Tasks with Remaining RAM
    // =========================================================================
    
    // Share tasks fill whatever RAM is left after real work
    runners = getSortedRunners(ns, runnerServers);
    const shareThreads = deployShareTasks(ns, runners);
    
    // =========================================================================
    // PHASE 9: Calculate Stats & Write Info
    // =========================================================================
    
    // Get ACTUAL running thread counts from process list
    const currentBatches = getAllRunningBatches(ns, runnerServers);
    let actualPrepThreads = 0;
    let actualCycleThreads = 0;
    let actualHackThreads = 0;
    
    for (const [target, threads] of currentBatches) {
      const state = serverStates.get(target);
      const isPrep = state?.phase === 'PREPPING' || state?.phase === 'UNPREPPED';
      const total = threads.hack + threads.grow + threads.weaken;
      
      if (isPrep) {
        actualPrepThreads += total;
      } else {
        actualCycleThreads += total;
        actualHackThreads += threads.hack;
      }
    }
    
    // Count share threads from process list too
    let actualShareThreads = 0;
    for (const runner of runnerServers) {
      for (const proc of ns.ps(runner)) {
        if (proc.filename === SHARE_SCRIPT) {
          actualShareThreads += proc.threads;
        }
      }
    }
    
    const totalThreads = actualPrepThreads + actualCycleThreads + actualShareThreads;
    
    // Saturated = we have share threads AND we deployed some real work
    const saturated = actualShareThreads > 0 && (actualPrepThreads > 0 || actualCycleThreads > 0);
    
    const stats = {
      shareThreads: actualShareThreads,
      totalThreads: totalThreads,
      hackingThreads: actualHackThreads,
      prepThreads: actualPrepThreads,
      cycleThreads: actualCycleThreads,
      saturated,
      preppedServers: prepped.length,
      preppingServers: prepping.length,
      cyclingServers: cycling.length,
      // Budget debug info
      prepCapacity: maxPrepThreads,
      availableThreads: availableThreads
    };
    
    await writeOrchestratorInfo(ns, stats);
    
    // =========================================================================
    // PHASE 10: Display Status
    // =========================================================================
    
    printStatus(ns, stats, runnerServers);
    
    // =========================================================================
    // Wait for next cycle
    // =========================================================================
    
    await ns.sleep(CYCLE_DELAY);
  }
}