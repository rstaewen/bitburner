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

// Minimum growth rate to consider a server worth hacking
// Servers with growth rate below this are blacklisted (e.g., fulcrumassets=1, foodnstuff=5)
const MIN_GROWTH_RATE = 15;

// Blacklisted servers - never hack these, they're not worth the thread cost
// Generated from server-analyzer.js: servers with growthRate <= 10
const BLACKLIST_SERVERS = [
  "fulcrumassets",  // growth=1, needs 67k threads to grow, earns $368/s - absolute worst
  "foodnstuff",     // growth=5, needs 3.9k threads, deceptively bad early game trap
  "sigma-cosmetics", // growth=10, needs 1.9k threads
  // NOTE: n00dles is NOT blacklisted despite low max money ($1.75m)
  // Its growth rate of 3000 means only ~7 threads to fully grow
  // Perfect bootstrapper: minimal thread cost, instant cycling, good early XP
];

// Priority prep targets by hacking level tier
// From server-analyzer.js output - best $/sec servers at each level range
const PRIORITY_PREP_TARGETS_BY_LEVEL = {
  // Level 1-100: Very early game - n00dles is the ultimate bootstrapper
  // Only needs ~10 threads total to cycle, generates seed money while real targets prep
  0: ["n00dles", "joesguns", "harakiri-sushi", "hong-fang-tea", "nectar-net", "neo-net"],
  
  // Level 101-300: Early game - n00dles still useful but diminishing returns
  100: ["n00dles", "max-hardware", "joesguns", "harakiri-sushi", "zer0", "phantasy", "nectar-net"],
  
  // Level 301-500: Early-mid game - n00dles becomes irrelevant, drop from list
  300: ["omega-net", "phantasy", "silver-helix", "crush-fitness", "max-hardware", "iron-gym"],
  
  // Level 501-700: Mid game
  500: ["computek", "the-hub", "catalyst", "summit-uni", "rho-construction", "omega-net"],
  
  // Level 701-900: Mid-late game
  700: ["rho-construction", "alpha-ent", "computek", "the-hub", "catalyst", "lexo-corp"],
  
  // Level 901-1100: Late game
  900: ["alpha-ent", "rho-construction", "lexo-corp", "global-pharm", "zb-institute", "computek"],
  
  // Level 1101-1300: End game begins
  1100: ["kuai-gong", "b-and-a", "4sigma", "blade", "nwo", "clarkinc", "megacorp", "omnitek"],
  
  // Level 1301-1500: End game
  1300: ["ecorp", "megacorp", "nwo", "blade", "clarkinc", "b-and-a", "4sigma", "kuai-gong"],
  
  // Level 1501+: Max level
  1500: ["ecorp", "megacorp", "nwo", "clarkinc", "blade", "b-and-a", "4sigma", "kuai-gong", "omnitek"],
};

// =============================================================================
// SERVER STATE MACHINE
// =============================================================================

/**
 * @typedef {'UNPREPPED' | 'PREPPING' | 'READY' | 'HACKING' | 'WEAKEN_AFTER_HACK' | 'GROWING' | 'WEAKEN_AFTER_GROW' | 'HACK_WEAKEN' | 'GROW_WEAKEN'} ServerPhase
 */

/**
 * @typedef {Object} ServerState
 * @property {string} name
 * @property {ServerPhase} phase
 * @property {number} batchStartTime - When current batch started (0 if none)
 * @property {number} batchEndTime - Expected completion time (0 if none)
 * @property {string} batchType - Current batch type: 'weaken', 'grow', 'hack', 'hack+weaken', 'grow+weaken', or ''
 * @property {number} batchThreads - Threads allocated to current batch
 * @property {number} profitScore - Cached profitability score
 * @property {Object} [lastBatchInfo] - Debug info from last hack batch for diagnosing over-hacks
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
const incidentLog = []; // Separate log for over-hacks and other incidents
const MAX_INCIDENT_LOG = 20; // Keep more incidents since they're rare
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

/**
 * Add an entry to the incident log (for over-hacks and other issues)
 * @param {string} message
 */
function logIncident(message) {
  const timestamp = new Date().toLocaleTimeString();
  incidentLog.unshift(`[${timestamp}] ${message}`);
  while (incidentLog.length > MAX_INCIDENT_LOG) {
    incidentLog.pop();
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
  
  // Calculate expected outcome
  const expectedStealPercent = threadsNeeded * hackPercent;
  const expectedMoneyAfter = current * (1 - expectedStealPercent);
  
  // If this looks like it will over-hack, log it
  if (expectedMoneyAfter < 0 || expectedStealPercent > 0.99) {
    logIncident(`🧮 CALC WARNING ${target}: ${threadsNeeded}t × ${(hackPercent*100).toFixed(4)}% = ${(expectedStealPercent*100).toFixed(1)}% steal`);
    logIncident(`   cur=$${ns.formatNumber(current)} max=$${ns.formatNumber(max)} target=$${ns.formatNumber(targetMoney)} after=$${ns.formatNumber(expectedMoneyAfter)}`);
  }
  
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
    // Skip blacklisted servers entirely
    if (BLACKLIST_SERVERS.includes(target)) continue;
    
    if (!ns.hasRootAccess(target)) continue;
    if (ns.getServerRequiredHackingLevel(target) > hackLevel) continue;
    if (ns.getServerMaxMoney(target) <= 0) continue;
    
    // Also skip servers with very low growth rate (dynamic check)
    const growthRate = ns.getServerGrowth(target);
    if (growthRate < MIN_GROWTH_RATE) continue;
    
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
  
  // Filter out blacklisted servers first
  const validServers = unprepedServers.filter(s => !BLACKLIST_SERVERS.includes(s));
  
  // Find the appropriate priority list for current hacking level
  const levelTiers = Object.keys(PRIORITY_PREP_TARGETS_BY_LEVEL)
    .map(Number)
    .sort((a, b) => b - a); // Sort descending
  
  let priorityNames = [];
  for (const tier of levelTiers) {
    if (hackLevel >= tier) {
      priorityNames = PRIORITY_PREP_TARGETS_BY_LEVEL[tier];
      break;
    }
  }
  
  // Partition into priority and non-priority
  const priority = [];
  const rest = [];
  
  for (const server of validServers) {
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
  
  // Skip if nothing actually needed (server might already be prepped)
  if (weakenNeeded <= 0 && growNeeded <= 0) {
    return { deployed: 0, type: '', duration: 0 };
  }
  
  // Prioritize weaken if security is high
  if (weakenNeeded > 0) {
    const threads = Math.min(weakenNeeded, maxThreads);
    if (threads <= 0) return { deployed: 0, type: '', duration: 0 };
    
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
    if (threads <= 0) return { deployed: 0, type: '', duration: 0 };
    
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
 * Execute a combined Hack + Weaken batch with proper timing
 * Launches weaken first, then hack with delay so hack lands just before weaken
 * @param {NS} ns
 * @param {string} target
 * @param {{name: string, cores: number, availableRam: number}[]} runners
 * @returns {{deployed: number, type: string, duration: number, hackThreads: number, weakenThreads: number}}
 */
function executeHackWeakenBatch(ns, target, runners) {
  const state = getServerState(target);
  
  // Check for existing scripts - this shouldn't happen but let's detect it
  const existingThreads = getRunningThreadsForTarget(ns, runners.map(r => r.name), target);
  const hasExisting = existingThreads.hack > 0 || existingThreads.grow > 0 || existingThreads.weaken > 0;
  if (hasExisting) {
    logIncident(`🔄 OVERLAP detected on ${target} before H+W: H=${existingThreads.hack} G=${existingThreads.grow} W=${existingThreads.weaken}`);
  }
  
  const hackThreads = calcHackThreads(ns, target);
  if (hackThreads <= 0) {
    // Nothing to hack - debug why
    const current = ns.getServerMoneyAvailable(target);
    const max = ns.getServerMaxMoney(target);
    const pct = max > 0 ? (current / max * 100).toFixed(1) : 0;
    const server = ns.getServer(target);
    const player = ns.getPlayer();
    const hackPct = ns.formulas.hacking.hackPercent(server, player);
    logActivity(`⏸️ H+W ${target}: hackThreads=0, money=${pct}%, hackPct=${(hackPct*100).toFixed(4)}%`);
    
    // Transition to grow
    state.phase = 'GROWING';
    return { deployed: 0, type: '', duration: 0, hackThreads: 0, weakenThreads: 0 };
  }
  
  // Calculate weaken threads needed to counter hack security increase
  const securityIncrease = calcSecurityIncrease('hack', hackThreads);
  const weakenThreads = calcCounterWeakenThreads(ns, securityIncrease);
  
  // Get timing info
  const hackTime = ns.getHackTime(target);
  const weakenTime = ns.getWeakenTime(target);
  
  // Calculate delay for hack so it lands 200ms before weaken
  // Weaken lands at: weakenTime (launched at t=0)
  // Hack lands at: hackDelay + hackTime
  // We want: hackDelay + hackTime = weakenTime - 200ms
  // So: hackDelay = weakenTime - hackTime - 200
  const LAND_BUFFER = 200; // ms before weaken that hack should land
  const hackDelay = Math.max(0, weakenTime - hackTime - LAND_BUFFER);
  
  // Log timing details for debugging
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const currentSec = ns.getServerSecurityLevel(target);
  const minSec = ns.getServerMinSecurityLevel(target);
  
  // Check if server is backdoored (hack time would be 25% less)
  const server = ns.getServer(target);
  const isBackdoored = server.backdoorInstalled;
  
  // Get runner names for refresh
  const runnerNames = runners.map(r => r.name);
  
  // Check if we have enough RAM for both operations BEFORE deploying anything
  const hackRam = ns.getScriptRam("hack.js");
  const weakenRam = ns.getScriptRam("weaken.js");
  let totalRamNeeded = (hackThreads * hackRam) + (weakenThreads * weakenRam);
  
  let totalAvailableRam = 0;
  for (const runner of runners) {
    totalAvailableRam += runner.availableRam;
  }
  
  // If not enough RAM, try to scale down hack threads to fit
  // This is especially important for early game bootstrapping
  let adjustedHackThreads = hackThreads;
  let adjustedWeakenThreads = weakenThreads;
  
  if (totalAvailableRam < totalRamNeeded) {
    // Calculate max hack threads that will fit
    // We need: (hackThreads * hackRam) + (weakenThreads * weakenRam) <= availableRam
    // Weaken threads = ceil(hackThreads * 0.002 / 0.05) = ceil(hackThreads * 0.04)
    // Let h = hack threads, then weaken = ceil(h * 0.04)
    // h * hackRam + ceil(h * 0.04) * weakenRam <= availableRam
    // 
    // Be conservative: assume worst case weaken overhead
    // At minimum, 1 weaken thread per batch, plus ceil() rounding
    // Use slightly higher ratio to ensure we don't overshoot
    const ramPerHackWithWeaken = hackRam + (0.05 * weakenRam); // Slightly conservative
    let maxAffordableHackThreads = Math.floor(totalAvailableRam / ramPerHackWithWeaken);
    
    // Binary search to find actual max that fits (handles edge cases)
    while (maxAffordableHackThreads > 0) {
      const testSecIncrease = calcSecurityIncrease('hack', maxAffordableHackThreads);
      const testWeakenThreads = calcCounterWeakenThreads(ns, testSecIncrease);
      const testRamNeeded = (maxAffordableHackThreads * hackRam) + (testWeakenThreads * weakenRam);
      
      if (testRamNeeded <= totalAvailableRam) {
        break; // Found a valid count
      }
      maxAffordableHackThreads--;
    }
    
    // Minimum 1 hack thread to be worth doing
    const MIN_HACK_THREADS = 1;
    
    if (maxAffordableHackThreads >= MIN_HACK_THREADS) {
      adjustedHackThreads = maxAffordableHackThreads;
      const adjustedSecIncrease = calcSecurityIncrease('hack', adjustedHackThreads);
      adjustedWeakenThreads = calcCounterWeakenThreads(ns, adjustedSecIncrease);
      totalRamNeeded = (adjustedHackThreads * hackRam) + (adjustedWeakenThreads * weakenRam);
      
      // Final verification (should always pass now but keep for safety)
      if (totalAvailableRam < totalRamNeeded) {
        return { deployed: 0, type: '', duration: 0, hackThreads: 0, weakenThreads: 0 };
      }
    } else {
      // Can't even afford minimum threads
      return { deployed: 0, type: '', duration: 0, hackThreads: 0, weakenThreads: 0 };
    }
  }
  
  // Deploy weaken first (no delay)
  const weakenDeployed = adjustedWeakenThreads > 0 
    ? executeDistributed(ns, "weaken.js", adjustedWeakenThreads, target, runners)
    : 0;
  
  // Refresh runners after weaken deployment
  const refreshedRunners = getSortedRunnersFromNames(ns, runnerNames);
  
  // Deploy hack with delay
  const hackDeployed = executeDistributedWithDelay(ns, "hack.js", adjustedHackThreads, target, refreshedRunners, hackDelay);
  
  if (hackDeployed > 0) {
    // Batch duration is when weaken completes (the last operation)
    const batchDuration = weakenTime;
    startBatch(state, 'hack+weaken', batchDuration, hackDeployed + weakenDeployed);
    state.phase = 'HACK_WEAKEN';
    
    // Store timing info for post-batch analysis
    state.lastBatchInfo = {
      type: 'hack+weaken',
      hackThreads: hackDeployed,
      weakenThreads: weakenDeployed,
      hackTime,
      weakenTime,
      hackDelay,
      preMoney: currentMoney,
      maxMoney,
      preSecurity: currentSec,
      minSecurity: minSec,
      expectedSecIncrease: securityIncrease,
      isBackdoored,
      hadOverlap: hasExisting,
      timestamp: Date.now()
    };
    
    const expectedSteal = ns.hackAnalyze(target) * hackDeployed * currentMoney;
    const bdFlag = isBackdoored ? ' [BD]' : '';
    logActivity(`⚡ H+W ${target}${bdFlag}: H=${hackDeployed}t W=${weakenDeployed}t → $${ns.formatNumber(expectedSteal)}, ${formatDuration(batchDuration)}`);
    
    return { 
      deployed: hackDeployed + weakenDeployed, 
      type: 'hack+weaken', 
      duration: batchDuration,
      hackThreads: hackDeployed,
      weakenThreads: weakenDeployed
    };
  }
  
  return { deployed: 0, type: '', duration: 0, hackThreads: 0, weakenThreads: 0 };
}

/**
 * Execute scripts with a delay parameter
 * @param {NS} ns
 * @param {string} script
 * @param {number} totalThreads
 * @param {string} target
 * @param {{name: string, cores: number, availableRam: number}[]} runners
 * @param {number} delayMs
 * @returns {number} Actual threads deployed
 */
function executeDistributedWithDelay(ns, script, totalThreads, target, runners, delayMs) {
  const scriptRam = ns.getScriptRam(script);
  if (scriptRam <= 0 || totalThreads <= 0) return 0;
  
  let deployed = 0;
  
  for (const runner of runners) {
    if (deployed >= totalThreads) break;
    
    const maxThreads = Math.floor(runner.availableRam / scriptRam);
    if (maxThreads <= 0) continue;
    
    const threadsToRun = Math.min(maxThreads, totalThreads - deployed);
    
    // Execute with delay parameter
    const pid = ns.exec(script, runner.name, threadsToRun, target, delayMs);
    
    if (pid > 0) {
      deployed += threadsToRun;
      runner.availableRam -= threadsToRun * scriptRam;
    }
  }
  
  return deployed;
}

/**
 * Helper to get fresh runner list from server names
 * @param {NS} ns
 * @param {string[]} runnerNames
 * @returns {{name: string, cores: number, availableRam: number}[]}
 */
function getSortedRunnersFromNames(ns, runnerNames) {
  const result = [];
  
  for (const name of runnerNames) {
    const maxRam = ns.getServerMaxRam(name);
    const usedRam = ns.getServerUsedRam(name);
    const availableRam = maxRam - usedRam;
    const cores = ns.getServer(name).cpuCores;
    
    if (availableRam > 0) {
      result.push({ name, cores, availableRam });
    }
  }
  
  result.sort((a, b) => b.cores - a.cores);
  return result;
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
 * Execute a combined Grow + Weaken batch with proper timing
 * Launches weaken first, then grow with delay so grow lands just before weaken
 * @param {NS} ns
 * @param {string} target
 * @param {{name: string, cores: number, availableRam: number}[]} runners
 * @param {string[]} runnerNames - List of runner server names for refresh
 * @returns {{deployed: number, type: string, duration: number, growThreads: number, weakenThreads: number}}
 */
function executeGrowWeakenBatch(ns, target, runners, runnerNames) {
  const state = getServerState(target);
  
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const moneyPercent = maxMoney > 0 ? (currentMoney / maxMoney * 100) : 0;
  
  // Detect over-hacked condition - only flag if significantly below target
  // TARGET_MONEY_AFTER_HACK is 5%, so anything below 4% is a real problem
  const OVER_HACK_THRESHOLD = 0.04; // Less than 4% money = something actually went wrong
  const isOverHacked = maxMoney > 0 && currentMoney < maxMoney * OVER_HACK_THRESHOLD;
  
  if (isOverHacked) {
    if (state.lastBatchInfo) {
      const info = state.lastBatchInfo;
      const timingDetails = `hDel=${info.hackDelay}ms hTime=${info.hackTime}ms wTime=${info.weakenTime}ms`;
      const threadDetails = `H=${info.hackThreads}t W=${info.weakenThreads}t`;
      const moneyDetails = `pre=$${ns.formatNumber(info.preMoney)} now=$${ns.formatNumber(currentMoney)} (${moneyPercent.toFixed(2)}%)`;
      const secDetails = `preSec=${info.preSecurity.toFixed(1)} min=${info.minSecurity} +${info.expectedSecIncrease.toFixed(3)}`;
      
      // Calculate if timing was the problem
      const expectedHackLand = info.hackDelay + info.hackTime;
      const timingMargin = info.weakenTime - expectedHackLand;
      const timingStatus = timingMargin > 0 ? `OK (${timingMargin}ms margin)` : `BAD (hack landed ${-timingMargin}ms AFTER weaken)`;
      
      // Flags for special conditions
      const flags = [];
      if (info.isBackdoored) flags.push('BACKDOORED');
      if (info.hadOverlap) flags.push('HAD_OVERLAP');
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      
      logIncident(`⚠️ OVER-HACK ${target}${flagStr}`);
      logIncident(`   Money: ${moneyDetails}`);
      logIncident(`   Timing: ${timingDetails}`);
      logIncident(`   Expected landing: ${timingStatus}`);
      logIncident(`   ${threadDetails} | ${secDetails}`);
    } else {
      // No lastBatchInfo - might be from a previous run or prep issue
      logIncident(`⚠️ OVER-HACK ${target}: ${moneyPercent.toFixed(2)}% money (no batch info - maybe from previous run?)`);
    }
  }
  
  const growThreads = calcGrowThreads(ns, target);
  if (growThreads <= 0) {
    // Already at max money, go back to hack
    state.phase = 'READY';
    return { deployed: 0, type: '', duration: 0, growThreads: 0, weakenThreads: 0 };
  }
  
  // Log if grow threads seem excessive (indicator of over-hack or just hard-to-grow server)
  const EXCESSIVE_GROW_THRESHOLD = 5000;
  if (growThreads > EXCESSIVE_GROW_THRESHOLD) {
    const serverGrowth = ns.getServerGrowth(target);
    const currentSec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);
    
    logIncident(`📊 Large grow: ${target} needs ${growThreads}t (${moneyPercent.toFixed(1)}% money)`);
    logIncident(`   Server stats: growthRate=${serverGrowth}, security=${currentSec.toFixed(1)}/${minSec}, max=$${ns.formatNumber(maxMoney)}`);
    
    // Add batch info if available for debugging
    if (state.lastBatchInfo) {
      const info = state.lastBatchInfo;
      const expectedHackLand = info.hackDelay + info.hackTime;
      const timingMargin = info.weakenTime - expectedHackLand;
      logIncident(`   Last H+W: H=${info.hackThreads}t W=${info.weakenThreads}t, margin=${timingMargin.toFixed(0)}ms`);
      logIncident(`   Pre-hack money: $${ns.formatNumber(info.preMoney)} (${(info.preMoney/info.maxMoney*100).toFixed(1)}%)`);
    }
  }
  
  // Calculate weaken threads needed to counter grow security increase
  const securityIncrease = calcSecurityIncrease('grow', growThreads);
  let weakenThreads = calcCounterWeakenThreads(ns, securityIncrease);
  
  // Get timing info
  const growTime = ns.getGrowTime(target);
  const weakenTime = ns.getWeakenTime(target);
  
  // Calculate delay for grow so it lands 200ms before weaken
  const LAND_BUFFER = 200;
  const growDelay = Math.max(0, weakenTime - growTime - LAND_BUFFER);
  
  // Check if we have enough RAM for both operations BEFORE deploying anything
  const growRam = ns.getScriptRam("grow.js");
  const weakenRam = ns.getScriptRam("weaken.js");
  let totalRamNeeded = (growThreads * growRam) + (weakenThreads * weakenRam);
  
  let totalAvailableRam = 0;
  for (const runner of runners) {
    totalAvailableRam += runner.availableRam;
  }
  
  // If not enough RAM, try to scale down grow threads to fit
  let adjustedGrowThreads = growThreads;
  let adjustedWeakenThreads = weakenThreads;
  
  if (totalAvailableRam < totalRamNeeded) {
    // Grow uses 0.004 security per thread, weaken removes 0.05 per thread
    // So weaken = ceil(grow * 0.004 / 0.05) = ceil(grow * 0.08)
    const ramPerGrowWithWeaken = growRam + (0.1 * weakenRam); // Conservative estimate
    let maxAffordableGrowThreads = Math.floor(totalAvailableRam / ramPerGrowWithWeaken);
    
    // Binary search to find actual max that fits
    while (maxAffordableGrowThreads > 0) {
      const testSecIncrease = calcSecurityIncrease('grow', maxAffordableGrowThreads);
      const testWeakenThreads = calcCounterWeakenThreads(ns, testSecIncrease);
      const testRamNeeded = (maxAffordableGrowThreads * growRam) + (testWeakenThreads * weakenRam);
      
      if (testRamNeeded <= totalAvailableRam) {
        break;
      }
      maxAffordableGrowThreads--;
    }
    
    // Need at least 1 grow thread
    if (maxAffordableGrowThreads >= 1) {
      adjustedGrowThreads = maxAffordableGrowThreads;
      const adjustedSecIncrease = calcSecurityIncrease('grow', adjustedGrowThreads);
      adjustedWeakenThreads = calcCounterWeakenThreads(ns, adjustedSecIncrease);
      totalRamNeeded = (adjustedGrowThreads * growRam) + (adjustedWeakenThreads * weakenRam);
      
      if (totalAvailableRam < totalRamNeeded) {
        return { deployed: 0, type: '', duration: 0, growThreads: 0, weakenThreads: 0 };
      }
    } else {
      return { deployed: 0, type: '', duration: 0, growThreads: 0, weakenThreads: 0 };
    }
  }
  
  // Deploy weaken first (no delay)
  const weakenDeployed = adjustedWeakenThreads > 0
    ? executeDistributed(ns, "weaken.js", adjustedWeakenThreads, target, runners)
    : 0;
  
  // Refresh runners after weaken deployment
  const refreshedRunners = getSortedRunnersFromNames(ns, runnerNames);
  
  // Deploy grow with delay
  const growDeployed = executeDistributedWithDelay(ns, "grow.js", adjustedGrowThreads, target, refreshedRunners, growDelay);
  
  if (growDeployed > 0) {
    // Batch duration is when weaken completes (the last operation)
    const batchDuration = weakenTime;
    startBatch(state, 'grow+weaken', batchDuration, growDeployed + weakenDeployed);
    state.phase = 'GROW_WEAKEN';
    
    logActivity(`⚡ G+W ${target}: G=${growDeployed}t W=${weakenDeployed}t, ${formatDuration(batchDuration)}`);
    
    return {
      deployed: growDeployed + weakenDeployed,
      type: 'grow+weaken',
      duration: batchDuration,
      growThreads: growDeployed,
      weakenThreads: weakenDeployed
    };
  }
  
  return { deployed: 0, type: '', duration: 0, growThreads: 0, weakenThreads: 0 };
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
      
      const pct = ns.getServerMoneyAvailable(batch.target) / ns.getServerMaxMoney(batch.target);
      const isPrep = batch.phase === 'PREPPING' || batch.phase === 'UNPREPPED';
      const phaseStr = isPrep ? '[PREP ' + ns.formatPercent(pct) + ']' : '';
      
      ns.print(`  ${batch.target} ${phaseStr}: ${parts.join(' ')} (${batch.total}t)`);
    }
    if (batchList.length > 12) {
      ns.print(`  ... and ${batchList.length - 12} more targets`);
    }
  }
  
  ns.print("");
  
  // Incidents (over-hacks, etc) - shown first since they're important
  if (incidentLog.length > 0) {
    ns.print("─── ⚠️ INCIDENTS ───");
    for (const entry of incidentLog.slice(0, 8)) {
      ns.print(`  ${entry}`);
    }
    if (incidentLog.length > 8) {
      ns.print(`  ... and ${incidentLog.length - 8} more`);
    }
    ns.print("");
  }
  
  // Recent activity (reduced to 6 entries to make room)
  ns.print("─── RECENT ACTIVITY ───");
  if (activityLog.length === 0) {
    ns.print("  (waiting for activity...)");
  } else {
    for (const entry of activityLog.slice(0, 6)) {
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
          // Weaken could be prep OR post-hack/post-grow cycle weaken
          // If server is already at min security, this is likely a cycle weaken
          const security = ns.getServerSecurityLevel(target);
          const minSec = ns.getServerMinSecurityLevel(target);
          if (security <= minSec + 0.1) {
            // Server is basically at min security - this is a post-operation weaken
            // Check money to determine if it's post-hack or post-grow
            const money = ns.getServerMoneyAvailable(target);
            const maxMoney = ns.getServerMaxMoney(target);
            if (maxMoney > 0 && money < maxMoney * 0.5) {
              // Low money = probably post-hack, need to grow next
              state.phase = 'WEAKEN_AFTER_HACK';
            } else {
              // High money = probably post-grow, ready for hack next
              state.phase = 'WEAKEN_AFTER_GROW';
            }
          } else {
            // Security is elevated - this is prep
            state.phase = 'PREPPING';
          }
        }
        
        if (batchType) {
          // Estimate when it will finish (assume it just started - conservative)
          startBatch(state, batchType, duration, total);
          logActivity(`🔄 Recovered ${batchType} batch: ${target} (${total}t, phase=${state.phase})`);
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
      const cyclingPhases = ['HACKING', 'WEAKEN_AFTER_HACK', 'GROWING', 'WEAKEN_AFTER_GROW', 'HACK_WEAKEN', 'GROW_WEAKEN'];
      
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
      
      // Combined batches: HACK_WEAKEN and GROW_WEAKEN complete together
      if (state.phase === 'HACK_WEAKEN') {
        // Hack+Weaken batch completed, now need to grow
        clearBatch(state);
        state.phase = 'GROWING';
        // Will be handled in Phase 7
      } else if (state.phase === 'GROW_WEAKEN') {
        // Grow+Weaken batch completed, back to ready for hack
        clearBatch(state);
        state.phase = 'READY';
      }
      // Legacy sequential phases (kept for compatibility during transition)
      else if (state.phase === 'HACKING') {
        // Just finished hack, need post-hack weaken
        const hackThreadsUsed = state.batchThreads || 1;
        clearBatch(state);
        
        runners = getSortedRunners(ns, runnerServers);
        const result = executePostHackWeaken(ns, target, hackThreadsUsed, runners);
        if (result.deployed > 0) {
          cycleThreadsUsed += result.deployed;
          const idx = prepped.indexOf(target);
          if (idx >= 0) prepped.splice(idx, 1);
          cycling.push(target);
        } else {
          state.phase = 'GROWING';
        }
      } else if (state.phase === 'WEAKEN_AFTER_HACK') {
        // Just finished post-hack weaken, now need to grow
        clearBatch(state);
        state.phase = 'GROWING';
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
        // Server is mid-cycle and needs grow+weaken
        const result = executeGrowWeakenBatch(ns, target, runners, runnerServers);
        if (result.deployed > 0) {
          cycleThreadsUsed += result.deployed;
        }
      } else {
        // READY phase - decide: hack or grow?
        const money = ns.getServerMoneyAvailable(target);
        const maxMoney = ns.getServerMaxMoney(target);
        const moneyRatio = maxMoney > 0 ? money / maxMoney : 0;
        
        if (moneyRatio >= MONEY_THRESHOLD) {
          // Ready to hack - use combined hack+weaken batch
          const result = executeHackWeakenBatch(ns, target, runners);
          if (result.deployed > 0) {
            cycleThreadsUsed += result.deployed;
            hackingThreads += result.hackThreads;
          } else {
            // Debug: why didn't batch deploy?
            let totalAvail = 0;
            for (const r of runners) totalAvail += r.availableRam;
            logActivity(`⏸️ H+W ${target} skipped: runners=${runners.length}, availRAM=${totalAvail.toFixed(1)}GB`);
          }
        } else {
          // Need to grow first (shouldn't happen often for READY servers)
          const result = executeGrowWeakenBatch(ns, target, runners, runnerServers);
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