/** @param {NS} ns */

import { getAllServers, categorizeServers } from "/utils/scanner.js";
import { tryNuke } from "/utils/nuker.js";

const BACKDOOR_WARN_COOLDOWN = 300000; // 5 minutes
const BACKDOOR_SCRIPT = "utils/backdoor-sluts.js"
const WORKER_SCRIPTS = ["hack.js", "grow.js", "weaken.js"];
const SHARE_SCRIPT = "share.js";
const SECURITY_THRESHOLD = 1;      // How much above min security before we prioritize weaken
const MONEY_THRESHOLD = 0.75;      // Grow until we have 75% of max money
const MIN_MONEY_AFTER_HACK = 0.05; // Never allow hacks to drive money below 5% of max
const CYCLE_DELAY = 10000;         // 10 seconds between cycles
const MAX_ACTIVITY_LOG = 8;        // How many recent activities to show
const DEFAULT_ANALYSIS_CORES = 1;  // Assume single-core scripts for planning estimates
const RESERVED_SERVERS = ["nexus", "nexus-0"];   // Servers reserved for auxiliary scripts

// Persistent activity log (survives across cycles)
const activityLog = [];

/**
 * Parse command line arguments
 * @param {NS} ns
 * @returns {object} Parsed flags
 */
function parseArgs(ns) {
  const flags = {
    ignoreHome: false,
    useFormulas: false
  };

  for (const arg of ns.args) {
    if (arg === "-H") {
      flags.ignoreHome = true;
    } else if (arg === "-F") {
      flags.useFormulas = true;
    }
  }

  return flags;
}

/**
 * Create a fresh server snapshot for formulas calculations
 * @param {NS} ns
 * @param {string} target
 * @param {object} overrides
 * @returns {Server}
 */
function buildServerSnapshot(ns, target, overrides = {}) {
  const server = ns.getServer(target);
  return Object.assign(server, overrides);
}

/**
 * Safely retrieve formulas API reference if available
 * @param {NS} ns
 * @returns {NS["formulas"] | null}
 */
function getFormulasApi(ns) {
  try {
    return ns.formulas || null;
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} CalcContextOptions
 * @property {boolean} useFormulas
 * @property {Player} [player]
 * @property {NS["formulas"]} [formulas]
 * @property {number} cores
 * @property {BitNodeMultipliers} bitnodeMultipliers
 */

class CalcContext {
  /**
   * @param {CalcContextOptions} options
   */
  constructor(options) {
    /** @type {boolean} */
    this.useFormulas = options.useFormulas;
    
    /** @type {NS["formulas"] | undefined} */
    this.formulas = options.formulas;
    
    /** @type {Player | undefined} */
    this.player = options.player;
    
    /** @type {BitNodeMultipliers} */
    this.bitnodeMultipliers = options.bitnodeMultipliers;
    
    /** @type {number} */
    this.cores = options.cores;
  }
}

/**
 * Build calculation context for downstream helpers
 * @param {NS} ns
 * @param {boolean} enableFormulas
 * @returns {CalcContext}
 */
function buildCalcContext(ns, enableFormulas) {
  if (!enableFormulas) {
    return { 
      useFormulas: false, 
      cores: DEFAULT_ANALYSIS_CORES,
      bitnodeMultipliers: ns.getBitNodeMultipliers() 
    };
  }

  const formulas = getFormulasApi(ns);
  if (!formulas || !formulas.hacking) {
    return { 
      useFormulas: false, 
      cores: DEFAULT_ANALYSIS_CORES,
      bitnodeMultipliers: ns.getBitNodeMultipliers() 
    };
  }

  return {
    useFormulas: true,
    formulas,
    player: ns.getPlayer(),
    bitnodeMultipliers: ns.getBitNodeMultipliers(),
    cores: DEFAULT_ANALYSIS_CORES
  };
}

/**
 * Get states for all targets using prediction, sorted by profitability
 * @param {NS} ns
 * @param {string[]} targetServers
 * @param {string[]} runnerServers
 * @returns {object[]}
 */
function getAllTargetStates(ns, targetServers, runnerServers, calcContext) {
  const states = [];
  const inFlightThreads = getInFlightThreads(ns, runnerServers);

  for (const target of targetServers) {
    // Only include targets we can actually hack
    if (ns.hasRootAccess(target)) {
      const state = assessTargetStateWithPrediction(ns, target, inFlightThreads, calcContext);
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
    ns.scp([...WORKER_SCRIPTS, SHARE_SCRIPT], runner, "home");
  }
}

let lastBackdoorWarning = 0;

/**
 * Attempt to spawn the backdoor script if not already running
 * @param {NS} ns
 * @returns {number} PID if launched, 0 if skipped/failed
 */
function trySpawnBackdoor(ns) {
  // Don't spawn if we haven't bought nexus yet
  if (ns.serverExists("nexus") === false) {
    return 0;
  }

  // Don't spawn if already running
  if (ns.isRunning(BACKDOOR_SCRIPT, "nexus")) {
    return 0;
  }

  // Try to exec (will fail if not enough RAM)
  const pid = ns.exec(BACKDOOR_SCRIPT, "nexus", 1);
  if (pid > 0 && pid != "") {
    logActivity(`🔑 Backdoor script started. pid: ${pid}`);
  } else if (Date.now() - lastBackdoorWarning > BACKDOOR_WARN_COOLDOWN) {
    ns.tprint("⚠️ WARN: Backdoor script failed to launch (insufficient RAM?) - manual backdoor may be needed");
    lastBackdoorWarning = Date.now();
  }
  return pid;
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
 * Kill any lingering share scripts so their RAM can be repurposed this cycle
 * @param {NS} ns
 * @param {string[]} runnerServers
 */
function terminateShareTasks(ns, runnerServers) {
  for (const runner of runnerServers) {
    const processes = ns.ps(runner);
    for (const proc of processes) {
      if (proc.filename === SHARE_SCRIPT) {
        ns.kill(proc.pid);
      }
    }
  }
}

/**
 * Log a task start with completion estimate and predicted outcome
 * @param {NS} ns
 * @param {string} action - "hack", "grow", or "weaken"
 * @param {string} target - target server name
 * @param {number} threads - number of threads
 * @param {CalcContext} calcContext
 */
function logTaskStart(ns, action, target, threads, calcContext) {
  const now = new Date();
  const useFormulas = calcContext?.useFormulas;
  const player = calcContext?.player;
  const serverSnapshot = useFormulas ? buildServerSnapshot(ns, target) : null;

  // Get operation time
  let opTime;
  if (useFormulas && serverSnapshot && player) {
    switch (action) {
      case "hack":
        opTime = calcContext.formulas.hacking.hackTime(serverSnapshot, player);
        break;
      case "grow":
        opTime = calcContext.formulas.hacking.growTime(serverSnapshot, player);
        break;
      case "weaken":
        opTime = calcContext.formulas.hacking.weakenTime(serverSnapshot, player);
        break;
      default:
        opTime = 0;
    }
  } else {
    switch (action) {
      case "hack":
        opTime = ns.getHackTime(target);
        break;
      case "grow":
        opTime = ns.getGrowTime(target);
        break;
      case "weaken":
        opTime = ns.getWeakenTime(target);
        break;
      default:
        opTime = 0;
    }
  }

  const completionTime = new Date(now.getTime() + opTime);
  const completionStr = completionTime.toLocaleTimeString();

  // Calculate predicted outcome
  let outcomeStr = "";
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);

  switch (action) {
    case "hack": {
      const hackPercent = useFormulas && serverSnapshot && player
        ? ns.formulas.hacking.hackPercent(serverSnapshot, player)
        : ns.hackAnalyze(target);
      const intelligence = ns.getPlayer().skills.intelligence
      const intelligenceModGuess = intelligence / 10 + 1;
      const totalSteal = Math.min(1, hackPercent * threads * intelligenceModGuess * calcContext.bitnodeMultipliers.ScriptHackMoney);
      const stolenAmount = currentMoney * totalSteal;
      outcomeStr = `→ $${ns.formatNumber(stolenAmount)}`;
      break;
    }
    case "grow": {
      let predictedMoney;
      if (useFormulas && serverSnapshot && player) {
        const multiplier = calcContext.formulas.hacking.growPercent(
          serverSnapshot,
          threads,
          player,
          calcContext.cores
        );
        predictedMoney = Math.min(maxMoney, currentMoney * multiplier);
      } else {
        const serverGrowth = ns.getServerGrowth(target);
        const securityPenalty = 1 + (currentSecurity - minSecurity) * 0.02;
        const baseGrowthPerThread = 1 + (serverGrowth / 100) / securityPenalty;
        const growMultiplier = Math.pow(baseGrowthPerThread, threads / 10);
        predictedMoney = Math.min(maxMoney, currentMoney * growMultiplier);
      }
      const newPercent = (predictedMoney / maxMoney * 100).toFixed(0);
      outcomeStr = `→ ${newPercent}% full`;
      break;
    }
    case "weaken": {
      const secReduction = threads * 0.05;
      const newSecurity = Math.max(minSecurity, currentSecurity - secReduction);
      const newDelta = newSecurity - minSecurity;
      outcomeStr = `→ +${newDelta.toFixed(1)} sec`;
      break;
    }
  }

  const timestamp = now.toLocaleTimeString();
  const message = `${action.toUpperCase()} ${target} (${threads}t) ${outcomeStr} @${completionStr}`;
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
  const trackedScripts = [...WORKER_SCRIPTS, SHARE_SCRIPT];

  for (const runner of runnerServers) {
    const processes = ns.ps(runner);

    for (const proc of processes) {
      if (!trackedScripts.includes(proc.filename)) continue;

      const action = proc.filename.replace('.js', '').toUpperCase();
      const target = proc.args[0];
      const key = target ? `${action} ${target}` : action;

      tasks.set(key, (tasks.get(key) || 0) + proc.threads);
    }
  }

  return tasks;
}

/**
 * Calculate how many MORE weaken threads needed to get from predicted security to threshold
 * @param {NS} ns
 * @param {string} target
 * @param {number} predictedSecurity - security level after in-flight operations complete
 * @returns {number} Additional threads needed (0 if predicted state already at target)
 */
function calcWeakenThreadsNeeded(ns, target, predictedSecurity) {
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const targetSecurity = minSecurity + SECURITY_THRESHOLD;

  if (predictedSecurity <= targetSecurity) return 0;

  const securityToRemove = predictedSecurity - targetSecurity;
  // Each weaken thread removes 0.05 security
  return Math.ceil(securityToRemove / 0.05);
}

/**
 * Calculate how many MORE grow threads needed to get from predicted money to threshold
 * @param {NS} ns
 * @param {string} target
 * @param {number} predictedMoney - money after in-flight operations complete
 * @returns {number} Additional threads needed (0 if predicted state already at target)
 */
function calcGrowThreadsNeeded(ns, target, predictedMoney, calcContext) {
  const maxMoney = ns.getServerMaxMoney(target);
  const targetMoney = maxMoney * MONEY_THRESHOLD;

  if (predictedMoney >= targetMoney) return 0;
  if (predictedMoney <= 0) return 1000; // Need some baseline if money is 0

  const multiplierNeeded = targetMoney / predictedMoney;

  if (calcContext?.useFormulas) {
    const server = buildServerSnapshot(ns, target);
    return estimateGrowThreadsWithFormulas(ns, server, multiplierNeeded, calcContext);
  }

  // Use ns.growthAnalyze to get threads needed for this multiplier
  // growthAnalyze(target, multiplier, cores) returns threads needed
  const threadsNeeded = Math.ceil(ns.growthAnalyze(target, multiplierNeeded));

  return threadsNeeded;
}

/**
 * Calculate how many hack threads to steal a reasonable amount from predicted money
 * We don't want to steal everything - aim for stealing down to ~25% money
 * @param {NS} ns
 * @param {string} target
 * @param {number} predictedMoney - money after in-flight operations complete
 * @returns {number} Threads needed
 */
function calcHackThreadsNeeded(ns, target, predictedMoney, calcContext) {
  const maxMoney = ns.getServerMaxMoney(target);

  if (predictedMoney <= 0) return 0;

  // Aim to steal down to 25% of max (leaving room for grow cycle)
  const desiredFloor = maxMoney * 0.25;
  const hardFloor = maxMoney * MIN_MONEY_AFTER_HACK;
  const targetMoney = Math.max(desiredFloor, hardFloor);
  const maxStealable = predictedMoney - hardFloor;
  const desiredSteal = predictedMoney - targetMoney;
  const amountToSteal = Math.min(desiredSteal, maxStealable);

  if (amountToSteal <= 0) return 0;

  // hackAnalyze returns the fraction stolen per thread
  const hackPercent = calcContext?.useFormulas
    ? calcContext.formulas.hacking.hackPercent(buildServerSnapshot(ns, target), calcContext.player)
    : ns.hackAnalyze(target) * calcContext.bitnodeMultipliers.ScriptHackMoney;
  if (hackPercent <= 0) return 0;

  // Each thread steals hackPercent of current money
  // We want: threads * hackPercent * predictedMoney >= amountToSteal
  const threadsNeeded = Math.ceil(amountToSteal / (hackPercent * predictedMoney));

  return threadsNeeded;
}

/**
 * Get the maximum useful threads for a target based on its priority and PREDICTED state
 * @param {NS} ns
 * @param {string} target
 * @param {string} priority - "hack", "grow", or "weaken"
 * @param {number} predictedMoney
 * @param {number} predictedSecurity
 * @returns {number} Max useful threads to assign
 */
function calcMaxUsefulThreads(ns, target, priority, predictedMoney, predictedSecurity, calcContext) {
  switch (priority) {
    case "weaken":
      return calcWeakenThreadsNeeded(ns, target, predictedSecurity);
    case "grow":
      return calcGrowThreadsNeeded(ns, target, predictedMoney, calcContext);
    case "hack":
      return calcHackThreadsNeeded(ns, target, predictedMoney, calcContext);
    default:
      return 0;
  }
}

/**
 * Estimate grow threads using the formulas API via binary search
 * @param {NS} ns
 * @param {Server} server
 * @param {number} multiplierNeeded
 * @param {{formulas: NS["formulas"], player: Player, cores: number}} calcContext
 * @returns {number}
 */
function estimateGrowThreadsWithFormulas(ns, server, multiplierNeeded, calcContext) {
  const { formulas, player, cores, bitnodeMultipliers } = calcContext;

  //ns.tprint("estimating grow threads for server: ", server.hostname, " multiplier: ", multiplierNeeded, ", cores: ", cores);

  return formulas.hacking.growThreads(server, player, server.moneyMax, cores)

  // Fast-path small multipliers
  if (multiplierNeeded <= 1) {
    return 0;
  }

  let low = 1;
  let high = 1;

  while (
    formulas.hacking.growPercent(server, high, player, cores) < multiplierNeeded &&
    high < 1_000_000
  ) {
    low = high;
    high *= 2;
  }

  let result = high;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const multiplier = formulas.hacking.growPercent(server, mid, player, cores);
    if (multiplier >= multiplierNeeded) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return Math.max(1, result);
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
function predictTargetState(ns, target, threads, calcContext) {
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const useFormulas = calcContext?.useFormulas;
  const player = calcContext?.player;
  const serverSnapshot = useFormulas ? buildServerSnapshot(ns, target) : null;

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
    const hackPercent = useFormulas && serverSnapshot && player
      ? calcContext.formulas.hacking.hackPercent(serverSnapshot, player)
      : ns.hackAnalyze(target);
    const totalHackPercent = Math.min(1, hackPercent * threads.hack);
    predictedMoney *= (1 - totalHackPercent);
    if (serverSnapshot) {
      serverSnapshot.moneyAvailable = predictedMoney;
    }
  }

  // Estimate grow effect
  // growthAnalyze is tricky - it takes (target, growthMultiplier, cores) and returns threads needed
  // We need to estimate the other direction: given threads, what's the multiplier?
  // Use a simpler approximation: grow roughly doubles money with ~25 threads at low security
  // The actual formula involves server growth rate and security level
  if (threads.grow > 0 && predictedMoney > 0) {
    if (useFormulas && serverSnapshot && player) {
      serverSnapshot.moneyAvailable = predictedMoney;
      const multiplier = calcContext.formulas.hacking.growPercent(
        serverSnapshot,
        threads.grow,
        player,
        calcContext.cores
      );
      predictedMoney = Math.min(maxMoney, predictedMoney * multiplier);
    } else {
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
function assessTargetStateWithPrediction(ns, target, inFlightThreads, calcContext) {
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const hackChance = calcContext?.useFormulas
    ? calcContext.formulas.hacking.hackChance(buildServerSnapshot(ns, target), calcContext.player)
    : ns.hackAnalyzeChance(target);

  // Get in-flight threads for this target
  const threads = inFlightThreads.get(target) || { hack: 0, grow: 0, weaken: 0 };
  const hasGrowInFlight = threads.grow > 0;

  // Get predicted state after in-flight operations complete
  const { predictedMoney, predictedSecurity } = predictTargetState(ns, target, threads, calcContext);

  const predictedMoneyPercent = maxMoney > 0 ? predictedMoney / maxMoney : 0;
  const predictedSecurityDelta = predictedSecurity - minSecurity;

  // Current state (for display)
  const currentMoneyPercent = maxMoney > 0 ? currentMoney / maxMoney : 0;
  const currentSecurityDelta = currentSecurity - minSecurity;
  const currentSecurityMultiplier = currentSecurity / minSecurity;

  // Determine priority based on PREDICTED state
  let priority;
  if (predictedSecurityDelta > SECURITY_THRESHOLD) {
    priority = "weaken";
  } else if (predictedMoneyPercent < MONEY_THRESHOLD) {
    priority = "grow";
  } else {
    priority = "hack";
  }
  const hackBlocked = priority === "hack" && hasGrowInFlight;

  // Calculate profitability score using predicted values
  const profitScore = maxMoney * hackChance * (1 - predictedSecurityDelta / 100);

  // Calculate max useful threads based on PREDICTED state (not current)
  // This tells us how many more threads we need to reach our thresholds
  const maxUsefulThreads = hackBlocked
    ? 0
    : calcMaxUsefulThreads(ns, target, priority, predictedMoney, predictedSecurity, calcContext);

  return {
    server: target,
    priority,
    // Current values (for display)
    moneyPercent: currentMoneyPercent,
    securityDelta: currentSecurityDelta,
    securityMultiplier: currentSecurityMultiplier,
    currentMoney,
    maxMoney,
    // Predicted values
    predictedMoneyPercent,
    predictedSecurityDelta,
    predictedMoney,
    predictedSecurity,
    // In-flight info
    inFlightThreads: threads,
    // Thread cap
    maxUsefulThreads,
    // Other
    hackChance,
    profitScore,
    canHack: ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(target),
    hasGrowInFlight,
    hackBlocked
  };
}

/**
 * Assign tasks to fill available RAM (does not kill running scripts)
 * Respects thread caps per target and distributes across multiple targets
 * Prioritizes high-core servers for worker tasks, any server for share tasks
 * @param {NS} ns
 * @param {object[]} targetStates
 * @param {string[]} runnerServers
 * @returns {object} Summary of new assignments
 */
function assignTasks(ns, targetStates, runnerServers, calcContext) {
  const newAssignments = [];
  let newThreads = { hack: 0, grow: 0, weaken: 0 };

  // Track how many threads we've assigned to each target this cycle
  // (on top of what's already in-flight)
  const assignedThisCycle = new Map();

  // Get script RAM costs
  const scriptRams = {
    hack: ns.getScriptRam("hack.js"),
    grow: ns.getScriptRam("grow.js"),
    weaken: ns.getScriptRam("weaken.js")
  };

  // Build a list of runners with their available RAM and cores, sorted by cores descending
  const runnerInfo = [];
  for (const runner of runnerServers) {
    let maxRam = ns.getServerMaxRam(runner);
    const available = maxRam - ns.getServerUsedRam(runner);
    const cores = ns.getServer(runner).cpuCores;
    if (available > 0) {
      runnerInfo.push({ name: runner, ram: available, cores });
    }
  }

  // Sort by cores descending (high-core servers first)
  runnerInfo.sort((a, b) => b.cores - a.cores);

  // Process targets in priority order (already sorted by profitScore)
  for (const target of targetStates) {
    const scriptName = target.priority + ".js";
    const scriptRam = scriptRams[target.priority];

    if (scriptRam === 0) continue;

    // Calculate how many more threads this target can use
    const key = `${target.priority}|${target.server}`;
    const alreadyAssignedThisCycle = assignedThisCycle.get(key) || 0;
    let remainingUseful = target.maxUsefulThreads - alreadyAssignedThisCycle;

    if (remainingUseful <= 0) continue; // This target is saturated

    // Try to assign threads from each runner (high-core first)
    for (const runner of runnerInfo) {
      if (remainingUseful <= 0) break;

      const maxThreadsFromRam = Math.floor(runner.ram / scriptRam);
      if (maxThreadsFromRam <= 0) continue;

      // Assign the minimum of: what RAM allows, what's useful
      const threadsToAssign = Math.min(maxThreadsFromRam, remainingUseful);

      const pid = ns.exec(scriptName, runner.name, threadsToAssign, target.server);

      if (pid > 0) {
        newAssignments.push({
          script: scriptName,
          runner: runner.name,
          threads: threadsToAssign,
          target: target.server,
          priority: target.priority,
          pid
        });

        newThreads[target.priority] += threadsToAssign;
        remainingUseful -= threadsToAssign;
        assignedThisCycle.set(key, alreadyAssignedThisCycle + threadsToAssign);

        // Update runner's available RAM
        runner.ram -= (threadsToAssign * scriptRam);
        if (runner.ram <= scriptRam) {
          runner.ram = 0; // Mark as exhausted
        }
      }
    }
  }

  // Log new assignments aggregated by action+target
  const aggregated = new Map();
  for (const a of newAssignments) {
    const key = `${a.priority}|${a.target}`;
    aggregated.set(key, (aggregated.get(key) || 0) + a.threads);
  }

  for (const [key, threads] of aggregated) {
    const [action, target] = key.split('|');
    logTaskStart(ns, action, target, threads, calcContext);
  }

  return { newAssignments, newThreads };
}

/**
 * Use all remaining RAM for share() on each runner
 * @param {NS} ns
 * @param {string[]} runnerServers
 * @returns {number} Total share threads launched
 */
function assignShareTasks(ns, runnerServers) {
  const scriptRam = ns.getScriptRam(SHARE_SCRIPT);
  if (scriptRam === 0) return 0;

  let totalThreads = 0;

  for (const runner of runnerServers) {
    const availableThreads = calculateAvailableThreads(ns, runner, SHARE_SCRIPT);
    if (availableThreads <= 0) continue;

    const pid = ns.exec(SHARE_SCRIPT, runner, availableThreads);
    if (pid > 0) {
      totalThreads += availableThreads;
    }
  }

  if (totalThreads > 0) {
    logActivity(`SHARE utilizing ${totalThreads} idle threads`);
  }

  return totalThreads;
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

  // Show which reserved server exists (if any)
  const existingReserved = RESERVED_SERVERS.find(s => ns.serverExists(s));
  if (existingReserved) {
    ns.print(`🚫 Reserved: ${existingReserved} (excluded from orchestration)`);
  }

  // Get all currently running tasks
  const runningTasks = getRunningTasks(ns, runnerServers);

  // Tally total threads by action type
  let totalByAction = { HACK: 0, GROW: 0, WEAKEN: 0, SHARE: 0 };
  for (const [key, threads] of runningTasks) {
    const action = key.split(' ')[0];
    totalByAction[action] = (totalByAction[action] || 0) + threads;
  }

  ns.print(`📊 Running: H:${totalByAction.HACK || 0} G:${totalByAction.GROW || 0} W:${totalByAction.WEAKEN || 0} S:${totalByAction.SHARE || 0}`);
  if (taskSummary.shareThreads > 0) {
    ns.print(`♻️  Share threads launched this cycle: +${taskSummary.shareThreads}`);
  }
  ns.print("");

  // Top targets with current priorities
  ns.print("─── TOP TARGETS (priority based on prediction) ───");
  const topTargets = targetStates.slice(0, 21);
  for (const t of topTargets) {
    const moneyStr = `${ns.formatNumber(t.maxMoney)}: ${(t.moneyPercent * 100).toFixed(0)}%→${(t.predictedMoneyPercent * 100).toFixed(0)}%`;
    const secStr = `C:${t.securityMultiplier.toFixed(1)}x+${t.securityDelta.toFixed(1)}→${t.predictedSecurityDelta.toFixed(1)}`;
    const actionIcon = t.priority === "hack" ? "💰" : t.priority === "grow" ? "📈" : "🔓";
    const capStr = t.maxUsefulThreads > 0 ? `need:${t.maxUsefulThreads}t` : "✓ full";
    ns.print(`${actionIcon} ${t.server}: $${moneyStr} | ${secStr} extra security | ${capStr}`);
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
function getReservedServers(ns) {
  let readyServers = [];
  for (let i = 0; i< RESERVED_SERVERS.length; i++) {
    if (!ns.serverExists(RESERVED_SERVERS[i])) {
      continue;
    }
    const server = ns.getServer(RESERVED_SERVERS[i]);
    if (server.maxRam >= 1024) {
      readyServers.push(RESERVED_SERVERS[i])
    }
  }
  return readyServers;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();

  const flags = parseArgs(ns);
  const includeHome = !flags.ignoreHome;

  ns.print("Starting Distributed Orchestrator...");
  ns.print(`  Home RAM: ${includeHome ? "ENABLED" : "DISABLED (-H)"}`);
  ns.print(`  Reserved Servers: ${getReservedServers(ns).join(", ")} (reserved when RAM reaches usable level)`);
  ns.print("");

  // Check for duplicate nexus situation
  const hasNexus = ns.serverExists("nexus");
  const hasNexus0 = ns.serverExists("nexus-0");

  if (hasNexus && hasNexus0) {
    ns.print("⚠️  WARNING: Duplicate nexus servers detected!");
    ns.print("Both 'nexus' and 'nexus-0' exist - both will be excluded from orchestration");
    ns.print("Consider deleting one to free up a server slot.");
    ns.print("");
  }

  while (true) {
    const calcContext = buildCalcContext(ns, true);
    if (flags.useFormulas && !calcContext.useFormulas) {
      ns.print("⚠️  Formulas requested (-F) but API unavailable. Falling back to vanilla sims.");
    }
    // 1. Scan network
    const allServers = getAllServers(ns);

    // 2. Try to nuke everything
    for (const server of allServers) {
      const hadRoot = ns.hasRootAccess(server);
      if (tryNuke(ns, server) && !hadRoot) {
        logActivity(`Gained root on ${server}`);
      }
    }

    // 2.5 Attempt to run backdoor script (fails gracefully if insufficient RAM)
    trySpawnBackdoor(ns);

    // 3. Categorize servers (pass includeHome flag)
    let { targetServers, runnerServers } = categorizeServers(ns, allServers, includeHome);

    // 4. Filter out reserved servers from runners
    runnerServers = runnerServers.filter(s => !getReservedServers(ns).includes(s));

    // 5. Deploy worker scripts
    deployWorkerScripts(ns, runnerServers);

    // 6. Reclaim RAM used by previous share cycles
    terminateShareTasks(ns, runnerServers);

    // 7. Assess all targets (with prediction based on in-flight tasks)
    const targetStates = getAllTargetStates(ns, targetServers, runnerServers, calcContext);

    // 8. Assign and execute tasks
    const taskSummary = assignTasks(ns, targetStates, runnerServers, calcContext);

    // 9. Fill remaining RAM with share scripts
    taskSummary.shareThreads = assignShareTasks(ns, runnerServers);

    // 10. Print status
    printStatus(ns, targetStates, runnerServers, taskSummary, includeHome);

    // 11. Wait before next cycle
    await ns.sleep(CYCLE_DELAY);
  }
}