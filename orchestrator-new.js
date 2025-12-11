/** @param {NS} ns */

import { getAllServers, categorizeServers } from "/utils/scanner.js";
import { tryNuke } from "/utils/nuker.js";

const WORKER_SCRIPTS = {
  hack: "hack.js",
  grow: "grow.js",
  weaken: "weaken.js"
};
const SHARE_SCRIPT = "share.js";

const MONEY_GROW_THRESHOLD = 0.75;
const MONEY_HACK_FLOOR = 0.05;
const GROW_OVERBOOK = 1.15;
const CYCLE_DELAY = 10_000;
const DEFAULT_ANALYSIS_CORES = 1;
const ACTIVITY_LIMIT = 6;

const activityLog = [];

function parseArgs(ns) {
  const parsed = ns.flags([
    ["ignore-home", false],
    ["formulas", false]
  ]);
  return {
    includeHome: !parsed["ignore-home"],
    useFormulas: parsed.formulas
  };
}

function getFormulasApi(ns) {
  try {
    return ns.formulas || null;
  } catch {
    return null;
  }
}

function buildCalcContext(ns, useFormulas) {
  if (!useFormulas) {
    return { useFormulas: false, cores: DEFAULT_ANALYSIS_CORES };
  }

  const formulas = getFormulasApi(ns);
  if (!formulas || !formulas.hacking) {
    return { useFormulas: false, cores: DEFAULT_ANALYSIS_CORES };
  }

  return {
    useFormulas: true,
    formulas,
    player: ns.getPlayer(),
    cores: DEFAULT_ANALYSIS_CORES
  };
}

function buildServerSnapshot(ns, target, overrides = {}) {
  const server = ns.getServer(target);
  return Object.assign(server, overrides);
}

function logActivity(message) {
  const entry = `[${new Date().toLocaleTimeString()}] ${message}`;
  activityLog.unshift(entry);
  while (activityLog.length > ACTIVITY_LIMIT) {
    activityLog.pop();
  }
}

function deployWorkerScripts(ns, runners) {
  const scripts = [...Object.values(WORKER_SCRIPTS), SHARE_SCRIPT];
  for (const host of runners) {
    ns.scp(scripts, host, "home");
  }
}

function terminateShareTasks(ns, runners) {
  for (const host of runners) {
    for (const proc of ns.ps(host)) {
      if (proc.filename === SHARE_SCRIPT) {
        ns.kill(proc.pid);
      }
    }
  }
}

function getInFlightThreads(ns, runners) {
  const map = new Map();
  for (const host of runners) {
    for (const proc of ns.ps(host)) {
      if (!Object.values(WORKER_SCRIPTS).includes(proc.filename)) continue;
      const target = proc.args[0];
      if (!target) continue;

      if (!map.has(target)) {
        map.set(target, { hack: 0, grow: 0, weaken: 0 });
      }

      const bucket = map.get(target);
      if (proc.filename === WORKER_SCRIPTS.hack) bucket.hack += proc.threads;
      if (proc.filename === WORKER_SCRIPTS.grow) bucket.grow += proc.threads;
      if (proc.filename === WORKER_SCRIPTS.weaken) bucket.weaken += proc.threads;
    }
  }
  return map;
}

function getRunningSummary(ns, runners) {
  const summary = { hack: 0, grow: 0, weaken: 0, share: 0 };
  for (const host of runners) {
    for (const proc of ns.ps(host)) {
      if (proc.filename === WORKER_SCRIPTS.hack) summary.hack += proc.threads;
      if (proc.filename === WORKER_SCRIPTS.grow) summary.grow += proc.threads;
      if (proc.filename === WORKER_SCRIPTS.weaken) summary.weaken += proc.threads;
      if (proc.filename === SHARE_SCRIPT) summary.share += proc.threads;
    }
  }
  return summary;
}

function predictTargetState(ns, target, threads, calcContext) {
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);

  const useFormulas = calcContext.useFormulas;
  const player = calcContext.player;
  const serverSnapshot = useFormulas ? buildServerSnapshot(ns, target) : null;

  const predictedSecurity =
    Math.max(
      minSecurity,
      currentSecurity
        - threads.weaken * 0.05
        + threads.hack * 0.002
        + threads.grow * 0.004
    );

  let predictedMoney = currentMoney;
  if (threads.hack > 0 && predictedMoney > 0) {
    const hackPercent = useFormulas && serverSnapshot
      ? calcContext.formulas.hacking.hackPercent(serverSnapshot, player)
      : ns.hackAnalyze(target);
    const steal = Math.min(1, hackPercent * threads.hack);
    predictedMoney *= (1 - steal);
    if (serverSnapshot) {
      serverSnapshot.moneyAvailable = predictedMoney;
    }
  }

  if (threads.grow > 0 && predictedMoney > 0) {
    if (useFormulas && serverSnapshot) {
      const multiplier = calcContext.formulas.hacking.growPercent(
        serverSnapshot,
        threads.grow,
        player,
        calcContext.cores
      );
      predictedMoney = Math.min(maxMoney, predictedMoney * multiplier);
    } else {
      const multiplier = ns.growthAnalyze(target, threads.grow);
      predictedMoney = Math.min(maxMoney, predictedMoney * multiplier);
    }
  }

  return {
    predictedMoney: Math.max(0, predictedMoney),
    predictedSecurity
  };
}

function analyzeTarget(ns, target, inFlight, calcContext) {
  const snapshot = buildServerSnapshot(ns, target);
  const threads = inFlight.get(target) || { hack: 0, grow: 0, weaken: 0 };
  const { predictedMoney, predictedSecurity } = predictTargetState(ns, target, threads, calcContext);
  const maxMoney = snapshot.moneyMax;
  const minSecurity = snapshot.minDifficulty;
  const hackChance = calcContext.useFormulas
    ? calcContext.formulas.hacking.hackChance(snapshot, calcContext.player)
    : ns.hackAnalyzeChance(target);

  const predictedMoneyPercent = maxMoney > 0 ? predictedMoney / maxMoney : 0;

  return {
    server: target,
    maxMoney,
    minSecurity,
    currentMoney: snapshot.moneyAvailable,
    currentSecurity: snapshot.hackDifficulty,
    predictedMoney,
    predictedSecurity,
    predictedMoneyPercent,
    modeHint: predictedMoneyPercent >= MONEY_GROW_THRESHOLD ? "hack" : "grow",
    hackChance,
    canHack: ns.getHackingLevel() >= snapshot.requiredHackingSkill,
    inFlight: threads
  };
}

function getTargetStates(ns, targetServers, runnerServers, calcContext) {
  const inFlight = getInFlightThreads(ns, runnerServers);
  const states = [];
  for (const target of targetServers) {
    if (!ns.hasRootAccess(target)) continue;
    const maxMoney = ns.getServerMaxMoney(target);
    if (maxMoney <= 0) continue;
    const state = analyzeTarget(ns, target, inFlight, calcContext);
    if (state.canHack) {
      states.push(state);
    }
  }
  return states.sort((a, b) => b.maxMoney * b.hackChance - a.maxMoney * a.hackChance);
}

function determineMode(targetStates, runningSummary) {
  if (runningSummary.hack > 0 && runningSummary.grow > 0) {
    return { mode: "hack", locked: true, reason: "mixed activity detected" };
  }
  if (runningSummary.hack > 0) {
    return { mode: "hack", locked: true, reason: "existing hack jobs" };
  }
  if (runningSummary.grow > 0) {
    return { mode: "grow", locked: true, reason: "existing grow jobs" };
  }

  const first = targetStates[0];
  if (!first) {
    return { mode: "grow", locked: false, reason: "no viable targets" };
  }

  const mode = first.predictedMoneyPercent >= MONEY_GROW_THRESHOLD ? "hack" : "grow";
  const reason = mode === "hack" ? "money healthy" : "money low";
  return { mode, locked: false, reason };
}

function growthThreadsToCap(ns, target, predictedMoney, calcContext) {
  const maxMoney = ns.getServerMaxMoney(target);
  if (maxMoney <= 0) return 0;
  const safeMoney = Math.max(1, predictedMoney);
  if (safeMoney >= maxMoney) return 0;
  const multiplierNeeded = maxMoney / safeMoney;

  if (calcContext.useFormulas) {
    const server = buildServerSnapshot(ns, target, { moneyAvailable: safeMoney });
    const { formulas, player, cores } = calcContext;

    let low = 1;
    let high = 1;
    while (
      formulas.hacking.growPercent(server, high, player, cores) < multiplierNeeded &&
      high < 1_000_000
    ) {
      low = high;
      high *= 2;
    }

    let answer = high;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const percent = formulas.hacking.growPercent(server, mid, player, cores);
      if (percent >= multiplierNeeded) {
        answer = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return Math.ceil(answer * GROW_OVERBOOK);
  }

  const base = Math.ceil(ns.growthAnalyze(target, multiplierNeeded));
  return Math.ceil(base * GROW_OVERBOOK);
}

function hackThreadsToFloor(ns, target, predictedMoney) {
  const maxMoney = ns.getServerMaxMoney(target);
  if (maxMoney <= 0 || predictedMoney <= 0) return 0;
  const floorMoney = maxMoney * MONEY_HACK_FLOOR;
  if (predictedMoney <= floorMoney) return 0;

  const hackPercent = ns.hackAnalyze(target);
  if (hackPercent <= 0) return 0;

  const stealAmount = predictedMoney - floorMoney;
  const perThread = predictedMoney * hackPercent;
  if (perThread <= 0) return 0;

  return Math.ceil(stealAmount / perThread);
}

function getRunnerRamMap(ns, runners) {
  const map = new Map();
  for (const host of runners) {
    const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    if (free > 0) {
      map.set(host, free);
    }
  }
  return map;
}

function tryExec(ns, script, host, threads, args = []) {
  if (threads <= 0) return 0;
  const pid = ns.exec(script, host, threads, ...args);
  return pid > 0 ? threads : 0;
}

function assignMainTasks(ns, runnerServers, targetStates, modeDecision, calcContext, runningSummary) {
  const result = { totalThreads: 0, assignments: [], pendingSecurity: new Map() };

  if (modeDecision.mode === "hack" && runningSummary.grow > 0) {
    logActivity("⏳ Waiting for grow scripts to finish before hacking");
    return result;
  }
  if (modeDecision.mode === "grow" && runningSummary.hack > 0) {
    logActivity("⏳ Waiting for hack scripts to finish before growing");
    return result;
  }

  const script = WORKER_SCRIPTS[modeDecision.mode];
  const scriptRam = ns.getScriptRam(script);
  if (scriptRam === 0) return result;

  const ramMap = getRunnerRamMap(ns, runnerServers);
  for (const target of targetStates) {
    if (!target.canHack) continue;

    if (modeDecision.mode === "hack" && target.predictedMoneyPercent < MONEY_GROW_THRESHOLD) continue;
    if (modeDecision.mode === "grow" && target.predictedMoneyPercent >= 1) continue;

    let threadsNeeded = 0;
    if (modeDecision.mode === "hack") {
      threadsNeeded = hackThreadsToFloor(ns, target.server, target.predictedMoney);
    } else {
      threadsNeeded = growthThreadsToCap(ns, target.server, target.predictedMoney, calcContext);
    }

    if (threadsNeeded <= 0) continue;

    let remaining = threadsNeeded;
    for (const [host, freeRam] of ramMap) {
      if (remaining <= 0) break;
      const threads = Math.min(Math.floor(freeRam / scriptRam), remaining);
      if (threads <= 0) continue;

      const used = tryExec(ns, script, host, threads, [target.server]);
      if (used > 0) {
        remaining -= used;
        result.totalThreads += used;
        result.assignments.push({ script, host, threads: used, target: target.server });

        const pending = result.pendingSecurity.get(target.server) || { hack: 0, grow: 0 };
        pending[modeDecision.mode] += used;
        result.pendingSecurity.set(target.server, pending);

        const leftover = freeRam - used * scriptRam;
        if (leftover < scriptRam) {
          ramMap.delete(host);
        } else {
          ramMap.set(host, leftover);
        }
      }
    }
  }

  if (result.totalThreads > 0) {
    logActivity(`${modeDecision.mode.toUpperCase()} dispatched (${result.totalThreads}t)`);
  }

  return result;
}

function weakenThreadsNeeded(ns, target, predictedSecurity, pendingSecurityIncrease = 0) {
  const min = ns.getServerMinSecurityLevel(target);
  const delta = predictedSecurity + pendingSecurityIncrease - min;
  if (delta <= 0) return 0;
  return Math.ceil(delta / 0.05);
}

function assignWeakenTasks(ns, runnerServers, targetStates, calcContext, pendingSecurity) {
  const script = WORKER_SCRIPTS.weaken;
  const scriptRam = ns.getScriptRam(script);
  if (scriptRam === 0) return 0;

  const ramMap = getRunnerRamMap(ns, runnerServers);
  let totalThreads = 0;

  for (const target of targetStates) {
    const pending = pendingSecurity.get(target.server) || { hack: 0, grow: 0 };
    const extraSecurity =
      pending.hack * 0.002 +
      pending.grow * 0.004;

    const threadsNeeded = weakenThreadsNeeded(
      ns,
      target.server,
      target.predictedSecurity,
      extraSecurity
    );
    if (threadsNeeded <= 0) continue;

    let remaining = threadsNeeded;
    for (const [host, freeRam] of ramMap) {
      if (remaining <= 0) break;
      const threads = Math.min(Math.floor(freeRam / scriptRam), remaining);
      if (threads <= 0) continue;

      const used = tryExec(ns, script, host, threads, [target.server]);
      if (used > 0) {
        remaining -= used;
        totalThreads += used;

        const leftover = freeRam - used * scriptRam;
        if (leftover < scriptRam) {
          ramMap.delete(host);
        } else {
          ramMap.set(host, leftover);
        }
      }
    }
  }

  if (totalThreads > 0) {
    logActivity(`WEAKEN dispatched (${totalThreads}t)`);
  }

  return totalThreads;
}

function calculateAvailableThreads(ns, runner, scriptName) {
  const maxRam = ns.getServerMaxRam(runner);
  const usedRam = ns.getServerUsedRam(runner);
  const scriptRam = ns.getScriptRam(scriptName);
  if (scriptRam <= 0) return 0;
  return Math.floor((maxRam - usedRam) / scriptRam);
}

function assignShareTasks(ns, runnerServers) {
  const scriptRam = ns.getScriptRam(SHARE_SCRIPT);
  if (scriptRam === 0) return 0;

  let totalThreads = 0;
  for (const runner of runnerServers) {
    const threads = calculateAvailableThreads(ns, runner, SHARE_SCRIPT);
    if (threads <= 0) continue;
    const used = tryExec(ns, SHARE_SCRIPT, runner, threads);
    if (used > 0) {
      totalThreads += used;
    }
  }

  if (totalThreads > 0) {
    logActivity(`SHARE utilizing ${totalThreads} idle threads`);
  }

  return totalThreads;
}

function printStatus(ns, runners, targetStates, modeDecision, runningSummary, mainSummary, weakenThreads, shareThreads) {
  ns.clearLog();
  ns.print("═══════════════════════════════════");
  ns.print("         TWO-STATE ORCHESTRATOR    ");
  ns.print("═══════════════════════════════════");
  ns.print(`Mode: ${modeDecision.mode.toUpperCase()} (${modeDecision.reason})`);
  ns.print(`Running -> hack:${runningSummary.hack} grow:${runningSummary.grow} weaken:${runningSummary.weaken} share:${runningSummary.share}`);
  ns.print(`New -> main:${mainSummary.totalThreads} weaken:${weakenThreads} share:${shareThreads}`);
  ns.print("");

  ns.print("Top targets");
  for (const state of targetStates.slice(0, 8)) {
    const moneyPct = (state.predictedMoneyPercent * 100).toFixed(0);
    const secDelta = (state.predictedSecurity - state.minSecurity).toFixed(2);
    ns.print(`${state.server}: ${moneyPct}% money | +${secDelta} sec | hint:${state.modeHint}`);
  }

  ns.print("");
  ns.print("Recent activity");
  if (activityLog.length === 0) {
    ns.print("  (no activity yet)");
  } else {
    for (const entry of activityLog) {
      ns.print(`  ${entry}`);
    }
  }
}

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = parseArgs(ns);
  ns.tail();

  while (true) {
    const calcContext = buildCalcContext(ns, flags.useFormulas);
    const servers = getAllServers(ns);

    for (const host of servers) {
      const hadRoot = ns.hasRootAccess(host);
      if (tryNuke(ns, host) && !hadRoot) {
        logActivity(`Root access gained on ${host}`);
      }
    }

    const { targetServers, runnerServers } = categorizeServers(ns, servers, flags.includeHome);
    deployWorkerScripts(ns, runnerServers);
    terminateShareTasks(ns, runnerServers);

    const targetStates = getTargetStates(ns, targetServers, runnerServers, calcContext);
    const runningSummary = getRunningSummary(ns, runnerServers);
    const modeDecision = determineMode(targetStates, runningSummary);

    const mainSummary = assignMainTasks(
      ns,
      runnerServers,
      targetStates,
      modeDecision,
      calcContext,
      runningSummary
    );
    const weakenThreads = assignWeakenTasks(
      ns,
      runnerServers,
      targetStates,
      calcContext,
      mainSummary.pendingSecurity
    );
    const shareThreads = assignShareTasks(ns, runnerServers);

    printStatus(ns, runnerServers, targetStates, modeDecision, runningSummary, mainSummary, weakenThreads, shareThreads);
    await ns.sleep(CYCLE_DELAY);
  }
}
