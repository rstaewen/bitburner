/** @param {NS} ns */

import { getAllServers, categorizeServers } from "/utils/scanner.js";
import { tryNuke } from "/utils/nuker.js";

const WORKER_SCRIPTS = {
  grow: "grow.js",
  hack: "hack.js",
  weaken: "weaken.js"
};
const SHARE_SCRIPT = "share.js";

const TARGET_FLOOR = 0.05; // Leave 5% of max money behind after hack
const GROW_OVERBOOK = 1.05; // Slightly over-allocate grow threads to ensure cap
const SECURITY_PER_GROW = 0.004;
const SECURITY_PER_HACK = 0.002;
const SECURITY_PER_WEAKEN = 0.05;

const BATCH_STAGGER = 1000; // 1s gap between consecutive completions (grow -> hack -> weaken)
const LOOP_DELAY = 2000; // ms between orchestrator passes
const DEFAULT_ANALYSIS_CORES = 1;
const ACTIVITY_LIMIT = 8;
const HACK_FLOOR_TOLERANCE = 1.2; // Allow 20% overshoot when checking hack success
const MONEY_DIVERGENCE_THRESHOLD = 10; // percentage points difference
const SECURITY_DELTA_TOLERANCE = 0.05;
const WEAKEN_GRACE_MS = 2000;

const activityLog = [];
const targetStates = new Map();

function parseArgs(ns) {
  const flags = ns.flags([
    ["ignore-home", false],
    ["formulas", false],
    ["targets", 3] // How many targets to try batching per loop
  ]);

  // Support both "--flag" (ns.flags) and bare positional tokens (e.g. "ignore-home")
  const positional = new Set((flags._ ?? []).map(String));
  const includeHome = positional.has("ignore-home") ? false : !flags["ignore-home"];
  const useFormulas = positional.has("formulas") ? true : flags.formulas;

  return {
    includeHome,
    useFormulas,
    maxTargets: Math.max(1, Number(flags.targets) || 1)
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
  const stamp = new Date().toLocaleTimeString();
  activityLog.unshift(`[${stamp}] ${message}`);
  while (activityLog.length > ACTIVITY_LIMIT) {
    activityLog.pop();
  }
}

function deployWorkerScripts(ns, runners) {
  const payload = [...Object.values(WORKER_SCRIPTS), SHARE_SCRIPT];
  for (const host of runners) {
    ns.scp(payload, host, "home");
  }
}

function terminateShareScripts(ns, runners) {
  for (const host of runners) {
    for (const proc of ns.ps(host)) {
      if (proc.filename === SHARE_SCRIPT) {
        ns.kill(proc.pid);
      }
    }
  }
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

function getTotalFreeRam(ramMap) {
  let total = 0;
  for (const free of ramMap.values()) {
    total += free;
  }
  return total;
}

function getInFlightThreads(ns, runners) {
  const map = new Map();
  const tracked = Object.values(WORKER_SCRIPTS);
  for (const host of runners) {
    for (const proc of ns.ps(host)) {
      if (!tracked.includes(proc.filename)) continue;
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

function targetIsBusy(target, inFlight) {
  const bucket = inFlight.get(target);
  if (!bucket) return false;
  return bucket.hack > 0 || bucket.grow > 0 || bucket.weaken > 0;
}

function calcGrowThreads(ns, target, startMoney, maxMoney, calcContext) {
  const safeMoney = Math.max(1, Math.min(startMoney, maxMoney));
  if (safeMoney >= maxMoney) {
    return 0;
  }
  const multiplier = maxMoney / safeMoney;
  if (calcContext.useFormulas) {
    const snapshot = buildServerSnapshot(ns, target, { moneyAvailable: safeMoney });
    const { formulas, player, cores } = calcContext;
    let low = 1;
    let high = 1;
    while (
      formulas.hacking.growPercent(snapshot, high, player, cores) < multiplier &&
      high < 1_000_000
    ) {
      low = high;
      high *= 2;
    }
    let answer = high;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const percent = formulas.hacking.growPercent(snapshot, mid, player, cores);
      if (percent >= multiplier) {
        answer = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return Math.ceil(answer * GROW_OVERBOOK);
  }
  const raw = ns.growthAnalyze(target, multiplier);
  return Math.ceil(raw * GROW_OVERBOOK);
}

function calcHackThreads(ns, target, moneyAfterGrow, calcContext) {
  if (moneyAfterGrow <= 0) return 0;
  const floor = moneyAfterGrow * TARGET_FLOOR;
  const stealAmount = moneyAfterGrow - floor;
  if (stealAmount <= 0) return 0;

  let hackPercent;
  if (calcContext.useFormulas) {
    const snapshot = buildServerSnapshot(ns, target);
    snapshot.moneyAvailable = moneyAfterGrow;
    hackPercent = calcContext.formulas.hacking.hackPercent(snapshot, calcContext.player);
  } else {
    hackPercent = ns.hackAnalyze(target);
  }
  if (hackPercent <= 0) return 0;

  return Math.ceil(stealAmount / (moneyAfterGrow * hackPercent));
}

function calcWeakenAllocation(currentSecurity, minSecurity, growThreads, hackThreads) {
  const existingDelta = Math.max(0, currentSecurity - minSecurity);
  const growSecurity = growThreads * SECURITY_PER_GROW;
  const hackSecurity = hackThreads * SECURITY_PER_HACK;
  const weakenAfterGrow = Math.max(0, Math.ceil((existingDelta + growSecurity) / SECURITY_PER_WEAKEN));
  const weakenAfterHack = Math.max(0, Math.ceil(hackSecurity / SECURITY_PER_WEAKEN));
  return {
    weakenAfterGrow,
    weakenAfterHack,
    total: weakenAfterGrow + weakenAfterHack
  };
}

function buildBatchPlan(ns, target, calcContext) {
  const maxMoney = ns.getServerMaxMoney(target);
  if (maxMoney <= 0) return null;
  const currentMoney = ns.getServerMoneyAvailable(target);
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const expectedMoney = maxMoney * TARGET_FLOOR;

  const growThreads = calcGrowThreads(ns, target, currentMoney, maxMoney, calcContext);
  const moneyAfterGrow = maxMoney; // By construction we try to cap
  const hackThreads = calcHackThreads(ns, target, moneyAfterGrow, calcContext);
  if (hackThreads <= 0) {
    return null;
  }
  const weakenAllocation = calcWeakenAllocation(currentSecurity, minSecurity, growThreads, hackThreads);

  const growTime = ns.getGrowTime(target);
  const hackTime = ns.getHackTime(target);
  const weakenTime = ns.getWeakenTime(target);

  const hackDelay = Math.max(0, growTime + BATCH_STAGGER - hackTime);
  const weakenGrowDelay = Math.max(0, growTime + BATCH_STAGGER - weakenTime);
  const weakenHackDelay = Math.max(0, hackDelay + hackTime + BATCH_STAGGER - weakenTime);

  const ram = {
    grow: ns.getScriptRam(WORKER_SCRIPTS.grow),
    hack: ns.getScriptRam(WORKER_SCRIPTS.hack),
    weaken: ns.getScriptRam(WORKER_SCRIPTS.weaken)
  };
  if (ram.grow === 0 || ram.hack === 0 || ram.weaken === 0) {
    return null;
  }

  const totalRam =
    growThreads * ram.grow +
    hackThreads * ram.hack +
    weakenAllocation.total * ram.weaken;

  return {
    target,
    maxMoney,
    growThreads,
    hackThreads,
    weakenGrowThreads: weakenAllocation.weakenAfterGrow,
    weakenHackThreads: weakenAllocation.weakenAfterHack,
    growTime,
    hackTime,
    weakenTime,
    hackDelay,
    weakenGrowDelay,
    weakenHackDelay,
    ram,
    totalRam,
    currentSecurity,
    minSecurity,
    expectedMoney,
    type: "batch"
  };
}

function downscalePlanForRam(plan, availableRam) {
  if (plan.totalRam <= availableRam) {
    return plan;
  }
  let scale = availableRam / plan.totalRam;
  if (scale <= 0) {
    return null;
  }

  const ram = plan.ram;
  for (let i = 0; i < 20; i++) {
    const growThreads = Math.max(0, Math.floor(plan.growThreads * scale));
    const hackThreads = plan.hackThreads > 0 ? Math.max(1, Math.floor(plan.hackThreads * scale)) : 0;
    const weakenAllocation = calcWeakenAllocation(
      plan.currentSecurity,
      plan.minSecurity,
      growThreads,
      hackThreads
    );

    const totalRam =
      growThreads * ram.grow +
      hackThreads * ram.hack +
      weakenAllocation.total * ram.weaken;

    if (totalRam <= availableRam && (plan.hackThreads === 0 || hackThreads > 0)) {
      return {
        ...plan,
        growThreads,
        hackThreads,
        weakenGrowThreads: weakenAllocation.weakenAfterGrow,
        weakenHackThreads: weakenAllocation.weakenAfterHack,
        totalRam
      };
    }

    scale *= 0.85;
  }
  return null;
}

function dispatchAction(ns, ramMap, script, threads, args) {
  if (threads <= 0) return 0;
  const scriptRam = ns.getScriptRam(script);
  let remaining = threads;
  for (const [host, freeRam] of ramMap) {
    if (remaining <= 0) break;
    const possible = Math.floor(freeRam / scriptRam);
    if (possible <= 0) continue;
    const use = Math.min(possible, remaining);
    const pid = ns.exec(script, host, use, ...args);
    if (pid > 0) {
      remaining -= use;
      const leftover = freeRam - use * scriptRam;
      if (leftover < scriptRam) {
        ramMap.delete(host);
      } else {
        ramMap.set(host, leftover);
      }
    }
  }
  return threads - remaining;
}

function recordPlanLaunch(plan) {
  const now = Date.now();
  const hackEnd = now + (plan.hackDelay ?? 0) + plan.hackTime;
  const weakenEnd = now + (plan.weakenHackDelay ?? 0) + plan.weakenTime;
  targetStates.set(plan.target, {
    expectedMoney: plan.expectedMoney,
    expectedHackEnd: hackEnd,
    expectedWeakenEnd: weakenEnd,
    type: plan.type ?? "batch"
  });
}

function dispatchBatch(ns, ramMap, plan) {
  const growArgs = [plan.target, 0];
  const hackArgs = [plan.target, plan.hackDelay];
  const weakenGrowArgs = [plan.target, plan.weakenGrowDelay];
  const weakenHackArgs = [plan.target, plan.weakenHackDelay];

  const growLaunched = dispatchAction(ns, ramMap, WORKER_SCRIPTS.grow, plan.growThreads, growArgs);
  if (growLaunched < plan.growThreads) {
    logActivity(`⚠️ Failed to fully launch grow batch for ${plan.target}`);
    return false;
  }

  const hackLaunched = dispatchAction(ns, ramMap, WORKER_SCRIPTS.hack, plan.hackThreads, hackArgs);
  if (hackLaunched < plan.hackThreads) {
    logActivity(`⚠️ Failed to fully launch hack batch for ${plan.target}`);
    return false;
  }

  const weakenGrowLaunched = dispatchAction(ns, ramMap, WORKER_SCRIPTS.weaken, plan.weakenGrowThreads, weakenGrowArgs);
  if (weakenGrowLaunched < plan.weakenGrowThreads) {
    logActivity(`⚠️ Failed to launch grow-guard weaken for ${plan.target}`);
    return false;
  }

  const weakenHackLaunched = dispatchAction(ns, ramMap, WORKER_SCRIPTS.weaken, plan.weakenHackThreads, weakenHackArgs);
  if (weakenHackLaunched < plan.weakenHackThreads) {
    logActivity(`⚠️ Failed to launch hack-guard weaken for ${plan.target}`);
    return false;
  }

  const totalThreads = plan.growThreads + plan.hackThreads + plan.weakenGrowThreads + plan.weakenHackThreads;
  recordPlanLaunch(plan);
  const label = plan.type === "recovery" ? "Recovery" : "Batch";
  logActivity(`🚀 ${label} launched on ${plan.target} (${totalThreads} threads)`);
  return true;
}

function scoreTarget(ns, target) {
  const maxMoney = ns.getServerMaxMoney(target);
  if (maxMoney <= 0) return 0;
  const chance = ns.hackAnalyzeChance(target);
  const sec = ns.getServerMinSecurityLevel(target);
  return maxMoney * chance / (sec + 1);
}

function getCandidateTargets(ns, targets) {
  return targets
    .filter(t => ns.hasRootAccess(t) && ns.getServerMaxMoney(t) > 0)
    .map(t => ({ server: t, score: scoreTarget(ns, t) }))
    .sort((a, b) => b.score - a.score);
}

function describeInflight(counts) {
  if (!counts) return "none";
  const parts = [];
  if (counts.grow) parts.push(`G${counts.grow}`);
  if (counts.hack) parts.push(`H${counts.hack}`);
  if (counts.weaken) parts.push(`W${counts.weaken}`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

function formatExpectationLabel(expectedPct) {
  if (expectedPct === null) return "none";
  if (expectedPct <= TARGET_FLOOR * 100 + 0.5) {
    return `floor (${expectedPct.toFixed(1)}%)`;
  }
  if (expectedPct >= 99) {
    return `cap (${expectedPct.toFixed(1)}%)`;
  }
  return `${expectedPct.toFixed(1)}%`;
}

function buildTargetDiagnostic(ns, target, inFlight) {
  const state = targetStates.get(target);
  const counts = inFlight.get(target) || { hack: 0, grow: 0, weaken: 0 };
  const maxMoney = ns.getServerMaxMoney(target);
  const currentMoney = ns.getServerMoneyAvailable(target);
  const moneyPct = maxMoney > 0 ? (currentMoney / maxMoney) * 100 : 0;
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const secDelta = currentSecurity - minSecurity;

  let expectedPct = null;
  if (state && typeof state.expectedMoney === "number" && maxMoney > 0) {
    expectedPct = Math.min(100, Math.max(0, (state.expectedMoney / maxMoney) * 100));
  }
  const expectationLabel = state ? `${state.type} → ${formatExpectationLabel(expectedPct)}` : "none";
  const inflightLabel = describeInflight(counts);

  const redFlags = [];
  if (expectedPct !== null) {
    const diff = Math.abs(moneyPct - expectedPct);
    if (diff > MONEY_DIVERGENCE_THRESHOLD) {
      redFlags.push(`money Δ${diff.toFixed(1)}%`);
    }
  }
  const now = Date.now();
  const weakenEta = state?.expectedWeakenEnd ?? 0;
  const secureGrace = weakenEta + WEAKEN_GRACE_MS;
  if (secDelta > SECURITY_DELTA_TOLERANCE && now > secureGrace) {
    redFlags.push(`security +${secDelta.toFixed(2)}`);
  }

  const etaLabel = state?.expectedWeakenEnd
    ? `, eta ${(Math.max(0, state.expectedWeakenEnd - now) / 1000).toFixed(1)}s`
    : "";
  let line = `${target} | money ${moneyPct.toFixed(1)}% | sec +${secDelta.toFixed(2)} | inflight ${inflightLabel} | plan ${expectationLabel}${etaLabel}`;
  if (redFlags.length > 0) {
    line += ` | ⚠️ ${redFlags.join(", ")}`;
  }

  return { line, redFlags };
}

function buildRecoveryPlan(ns, target, calcContext) {
  const maxMoney = ns.getServerMaxMoney(target);
  if (maxMoney <= 0) return null;
  const currentMoney = ns.getServerMoneyAvailable(target);
  const desiredMoney = maxMoney * TARGET_FLOOR;
  if (currentMoney <= desiredMoney * HACK_FLOOR_TOLERANCE) {
    return null;
  }
  const hackThreads = calcHackThreads(ns, target, currentMoney, calcContext);
  if (hackThreads <= 0) {
    return null;
  }
  const currentSecurity = ns.getServerSecurityLevel(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const weakenAllocation = calcWeakenAllocation(currentSecurity, minSecurity, 0, hackThreads);
  const hackTime = ns.getHackTime(target);
  const weakenTime = ns.getWeakenTime(target);
  const weakenGrowDelay = Math.max(0, BATCH_STAGGER - weakenTime); // settle existing delta quickly
  const weakenHackDelay = Math.max(0, hackTime + BATCH_STAGGER - weakenTime);
  const ram = {
    grow: 0,
    hack: ns.getScriptRam(WORKER_SCRIPTS.hack),
    weaken: ns.getScriptRam(WORKER_SCRIPTS.weaken)
  };
  if (ram.hack === 0 || ram.weaken === 0) return null;
  const totalRam = hackThreads * ram.hack + weakenAllocation.total * ram.weaken;
  return {
    target,
    maxMoney,
    growThreads: 0,
    hackThreads,
    weakenGrowThreads: weakenAllocation.weakenAfterGrow,
    weakenHackThreads: weakenAllocation.weakenAfterHack,
    growTime: 0,
    hackTime,
    weakenTime,
    hackDelay: 0,
    weakenGrowDelay,
    weakenHackDelay,
    ram,
    totalRam,
    currentSecurity,
    minSecurity,
    expectedMoney: desiredMoney,
    type: "recovery"
  };
}

function evaluateTargetStates(ns) {
  const now = Date.now();
  const recoveryTargets = new Set();
  for (const [target, state] of targetStates.entries()) {
    if (now < state.expectedHackEnd) {
      continue;
    }
    const maxMoney = ns.getServerMaxMoney(target);
    if (maxMoney <= 0) {
      targetStates.delete(target);
      continue;
    }
    const currentMoney = ns.getServerMoneyAvailable(target);
    const expectedMoney = state.expectedMoney ?? maxMoney * TARGET_FLOOR;
    if (currentMoney > expectedMoney * HACK_FLOOR_TOLERANCE) {
      recoveryTargets.add(target);
      continue;
    }
    if (now > state.expectedWeakenEnd) {
      targetStates.delete(target);
    }
  }
  return recoveryTargets;
}

function printStatus(ns, candidates, ramMap, inFlight) {
  ns.clearLog();
  ns.print("══════════════════════════════════════");
  ns.print("          ORCHESTRATOR PRO            ");
  ns.print("══════════════════════════════════════");
  ns.print(`Free RAM: ${ns.formatRam(getTotalFreeRam(ramMap))}`);
  ns.print("");
  ns.print("Target diagnostics");
  const seen = new Set();
  const targetOrder = [];
  for (const { server } of candidates) {
    if (!seen.has(server)) {
      seen.add(server);
      targetOrder.push(server);
    }
  }
  for (const target of targetStates.keys()) {
    if (!seen.has(target)) {
      seen.add(target);
      targetOrder.push(target);
    }
  }
  if (targetOrder.length === 0) {
    ns.print("  (no viable targets)");
  } else {
    const redFlagSummaries = [];
    for (const target of targetOrder) {
      const { line, redFlags } = buildTargetDiagnostic(ns, target, inFlight);
      ns.print(`  ${line}`);
      if (redFlags.length > 0) {
        redFlagSummaries.push(`${target}: ${redFlags.join(", ")}`);
      }
    }
    if (redFlagSummaries.length > 0) {
      ns.print("");
      ns.print("⚠️ Red flags detected");
      for (const entry of redFlagSummaries) {
        ns.print(`  ${entry}`);
      }
    }
  }
  ns.print("");
  ns.print("Recent activity");
  if (activityLog.length === 0) {
    ns.print("  (none yet)");
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
  logActivity(`🚀 Orchestrator Pro started. [Using formulas: ${flags.useFormulas}] [Including home: ${flags.includeHome}]`);

  while (true) {
    const calcContext = buildCalcContext(ns, flags.useFormulas);
    const servers = getAllServers(ns);
    for (const host of servers) {
      const hadRoot = ns.hasRootAccess(host);
      if (tryNuke(ns, host) && !hadRoot) {
        logActivity(`🔓 Root access gained on ${host}`);
      }
    }

    const { targetServers, runnerServers } = categorizeServers(ns, servers, flags.includeHome);
    if (runnerServers.length === 0) {
      logActivity("⚠️ No runner servers available");
      await ns.sleep(LOOP_DELAY);
      continue;
    }

    deployWorkerScripts(ns, runnerServers);
    terminateShareScripts(ns, runnerServers);

    const recoveryTargets = evaluateTargetStates(ns);
    const ramMap = getRunnerRamMap(ns, runnerServers);
    const candidates = getCandidateTargets(ns, targetServers);
    const inFlight = getInFlightThreads(ns, runnerServers);

    let batchesLaunched = 0;

    for (const target of recoveryTargets) {
      if (targetIsBusy(target, inFlight)) {
        continue;
      }
      const availableRam = getTotalFreeRam(ramMap);
      if (availableRam <= 0) {
        break;
      }
      let plan = buildRecoveryPlan(ns, target, calcContext);
      if (!plan) {
        targetStates.delete(target);
        continue;
      }
      plan = downscalePlanForRam(plan, availableRam);
      if (!plan) {
        continue;
      }
      if (dispatchBatch(ns, ramMap, plan)) {
        targetStates.set(target, {
          expectedMoney: plan.expectedMoney,
          expectedHackEnd: Date.now() + plan.hackTime,
          expectedWeakenEnd: Date.now() + plan.weakenDelay + plan.weakenTime,
          type: "recovery"
        });
      }
    }

    for (const candidate of candidates) {
      if (batchesLaunched >= flags.maxTargets) break;
      const target = candidate.server;
      if (targetIsBusy(target, inFlight)) continue;
      if (recoveryTargets.has(target)) continue;

      const availableRam = getTotalFreeRam(ramMap);
      if (availableRam <= 0) break;

      let plan = buildBatchPlan(ns, target, calcContext);
      if (!plan) continue;
      plan = downscalePlanForRam(plan, availableRam);
      if (!plan) continue;

      const success = dispatchBatch(ns, ramMap, plan);
      if (success) {
        batchesLaunched++;
      } else {
        break;
      }
    }

    if (batchesLaunched === 0) {
      logActivity("⏳ Waiting for targets or RAM to free up");
    }

    printStatus(ns, candidates, ramMap, inFlight);
    await ns.sleep(LOOP_DELAY);
  }
}
