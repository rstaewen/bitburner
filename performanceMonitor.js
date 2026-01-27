import { getAllServers } from "/utils/scanner.js";

const SAMPLE_INTERVAL = 200; // Can be slower now since we're tracking completions
const MIN_REMAINING_FRACTION = 0.05;
const STOCK_TRADER_SCRIPT_PATTERNS = ["stock-trader", "stocktrader", "stock_trader"];
const SERVERS_TO_SHOW = 4;
const TOP_POSITIONS_TO_SHOW = 5;

// Servers to exclude from aggregate calculations (too inefficient to bother with)
const BLACKLISTED_SERVERS = [
  "fulcrumassets",
  "foodnstuff", 
  "sigma-cosmetics",
];

function getFormulas(ns) {
  try { return ns.formulas || null; } catch { return null; }
}

function getAllMoneyServers(ns) {
  const allServers = getAllServers(ns);
  const candidates = [];
  for (const server of allServers) {
    if (!ns.hasRootAccess(server)) continue;
    const maxMoney = ns.getServerMaxMoney(server);
    if (maxMoney <= 0) continue;
    candidates.push({ server, maxMoney });
  }
  candidates.sort((a, b) => b.maxMoney - a.maxMoney);
  return candidates;
}

function computeTheoreticalRate(ns, server, player, formulas, cores = 1) {
  const maxMoney = ns.getServerMaxMoney(server);
  if (maxMoney <= 0) return 0;
  const cycleMoney = maxMoney * (1 - MIN_REMAINING_FRACTION);
  let hackTime, growTime;
  if (formulas && formulas.hacking) {
    const snapshot = ns.getServer(server);
    snapshot.hackDifficulty = snapshot.minDifficulty;
    snapshot.moneyAvailable = maxMoney;
    hackTime = formulas.hacking.hackTime(snapshot, player);
    growTime = formulas.hacking.growTime(snapshot, player);
  } else {
    const currentSec = ns.getServerSecurityLevel(server);
    const minSec = ns.getServerMinSecurityLevel(server);
    const secRatio = minSec / Math.max(currentSec, minSec);
    hackTime = ns.getHackTime(server) * secRatio;
    growTime = ns.getGrowTime(server) * secRatio;
  }
  const cycleMs = hackTime + growTime;
  return cycleMs > 0 ? cycleMoney / (cycleMs / 1000) : 0;
}

function computeConservativeRate(ns, server, player, formulas, cores = 1) {
  const maxMoney = ns.getServerMaxMoney(server);
  if (maxMoney <= 0) return 0;
  const cycleMoney = maxMoney * (1 - MIN_REMAINING_FRACTION);
  let hackTime, growTime, weakenTime;
  if (formulas && formulas.hacking) {
    const snapshot = ns.getServer(server);
    snapshot.hackDifficulty = snapshot.minDifficulty;
    snapshot.moneyAvailable = maxMoney;
    hackTime = formulas.hacking.hackTime(snapshot, player);
    growTime = formulas.hacking.growTime(snapshot, player);
    weakenTime = formulas.hacking.weakenTime(snapshot, player);
  } else {
    const currentSec = ns.getServerSecurityLevel(server);
    const minSec = ns.getServerMinSecurityLevel(server);
    const secRatio = minSec / Math.max(currentSec, minSec);
    hackTime = ns.getHackTime(server) * secRatio;
    growTime = ns.getGrowTime(server) * secRatio;
    weakenTime = ns.getWeakenTime(server) * secRatio;
  }
  const cycleMs = hackTime + growTime + 2 * weakenTime;
  return cycleMs > 0 ? cycleMoney / (cycleMs / 1000) : 0;
}

/**
 * Get total hack earnings by finding the orchestrator script and reading its onlineMoneyMade
 * Bitburner credits hack earnings to the script that spawned the hack via ns.exec()
 * @param {NS} ns
 * @returns {number} Total money earned by orchestrator
 */
function getOrchestratorEarnings(ns) {
  const allServers = getAllServers(ns);
  
  for (const host of allServers) {
    for (const proc of ns.ps(host)) {
      // Look for orchestrator script
      if (proc.filename.includes("orchestrator")) {
        const info = ns.getRunningScript(proc.pid);
        if (info) {
          return info.onlineMoneyMade;
        }
      }
    }
  }
  
  return 0;
}

function getStockTraderScriptStats(ns) {
  const allServers = getAllServers(ns);
  const stockScripts = [];
  let totalMade = 0, totalRate = 0;
  for (const server of allServers) {
    for (const proc of ns.ps(server)) {
      const filename = proc.filename.toLowerCase();
      if (STOCK_TRADER_SCRIPT_PATTERNS.some(p => filename.includes(p))) {
        const info = ns.getRunningScript(proc.pid);
        if (info) {
          const rate = info.onlineRunningTime > 0 ? info.onlineMoneyMade / info.onlineRunningTime : 0;
          stockScripts.push({ filename: proc.filename, server, pid: proc.pid, moneyMade: info.onlineMoneyMade, runningTime: info.onlineRunningTime, rate });
          totalMade += info.onlineMoneyMade;
          totalRate += rate;
        }
      }
    }
  }
  return { scripts: stockScripts, totalMade, totalRate };
}

function getHeldPositions(ns) {
  if (!ns.stock || !ns.stock.hasTIXAPIAccess()) return [];
  const positions = [];
  for (const symbol of ns.stock.getSymbols()) {
    const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(symbol);
    if (longShares <= 0 && shortShares <= 0) continue;
    const price = ns.stock.getPrice(symbol);
    let forecast = null;
    try { forecast = ns.stock.getForecast(symbol); } catch {}
    if (longShares > 0) {
      const delta = ns.stock.getSaleGain(symbol, longShares, "Long") - longShares * longAvg;
      positions.push({ symbol, side: "L", shares: longShares, avg: longAvg, price, delta, forecast });
    }
    if (shortShares > 0) {
      const delta = shortShares * shortAvg - ns.stock.getSaleGain(symbol, shortShares, "Short");
      positions.push({ symbol, side: "S", shares: shortShares, avg: shortAvg, price, delta, forecast });
    }
  }
  positions.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return positions;
}

function getUnrealizedPL(ns) {
  const positions = getHeldPositions(ns);
  let totalUnrealized = 0, totalInvested = 0;
  for (const pos of positions) {
    totalUnrealized += pos.delta;
    totalInvested += pos.shares * pos.avg;
  }
  return { totalUnrealized, totalInvested };
}

function fmt(ns, v, d = 2) { return ns.formatNumber(v, d); }
function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.clearLog();

  const diagServer = ns.args[0] || "n00dles";
  
  const stats = new Map();
  const startTime = Date.now();
  
  // Track orchestrator earnings - mark starting value so we only count from monitor start
  const startingOrchestratorEarnings = getOrchestratorEarnings(ns);

  while (true) {
    const player = ns.getPlayer();
    const formulas = getFormulas(ns);
    const allMoneyServers = getAllMoneyServers(ns);
    const activeSet = new Set(allMoneyServers.map(t => t.server));

    for (const server of Array.from(stats.keys())) {
      if (!activeSet.has(server)) stats.delete(server);
    }

    const now = Date.now();
    const elapsedSec = Math.max(1, (now - startTime) / 1000);

    // Get orchestrator's total earnings since monitor started
    const orchestratorEarnings = getOrchestratorEarnings(ns) - startingOrchestratorEarnings;

    for (const { server } of allMoneyServers) {
      const currentMoney = ns.getServerMoneyAvailable(server);
      const maxMoney = ns.getServerMaxMoney(server);
      
      // Get or create record
      const record = stats.get(server) || { 
        actualEarned: 0, 
        prevMoney: currentMoney,
        theoreticalPerSec: 0, 
        conservativePerSec: 0
      };
      
      // Money-delta tracking for per-server breakdown
      // This undercounts fast servers but gives relative comparison
      let delta = record.prevMoney - currentMoney;
      if (delta > 0) {
        record.actualEarned += delta;
      }
      record.prevMoney = currentMoney;
      
      record.theoreticalPerSec = computeTheoreticalRate(ns, server, player, formulas);
      record.conservativePerSec = computeConservativeRate(ns, server, player, formulas);
      record.currentMoney = currentMoney;
      record.maxMoney = maxMoney;
      stats.set(server, record);
    }
    
    const stockStats = getStockTraderScriptStats(ns);
    const positions = getHeldPositions(ns);
    const { totalUnrealized, totalInvested } = getUnrealizedPL(ns);

    // Build sorted list with server info (excluding blacklisted)
    const allSorted = Array.from(stats.entries())
      .filter(([s]) => s !== diagServer && !BLACKLISTED_SERVERS.includes(s))
      .map(([server, r]) => {
        const sec = ns.getServerSecurityLevel(server);
        const minSec = ns.getServerMinSecurityLevel(server);
        const grow = ns.getServerGrowth(server);
        const aps = r.actualEarned / elapsedSec;
        const te = r.theoreticalPerSec > 0 ? (aps / r.theoreticalPerSec) * 100 : 0;
        const ce = r.conservativePerSec > 0 ? (aps / r.conservativePerSec) * 100 : 0;
        return { server, ...r, sec, minSec, grow, aps, te, ce };
      })
      .sort((a, b) => b.actualEarned - a.actualEarned);

    const top = allSorted.slice(0, SERVERS_TO_SHOW);
    const bottom = allSorted.slice(-SERVERS_TO_SHOW).reverse();
    
    // Calculate aggregate excluding blacklisted servers
    let aggActual = 0, aggTheo = 0, aggCons = 0;
    for (const [server, record] of stats.entries()) {
      if (BLACKLISTED_SERVERS.includes(server)) continue;
      aggActual += record.actualEarned;
      aggTheo += record.theoreticalPerSec;
      aggCons += record.conservativePerSec;
    }
    const aggActualPerSec = aggActual / elapsedSec;

    // ═══════════════════════════════════════════════════════════════
    ns.clearLog();
    ns.print(`══════ PERF MONITOR ══════ ${fmtTime(elapsedSec)} uptime | ${allMoneyServers.length} servers`);

    // Detailed diagnostics for chosen server
    const diagRecord = stats.get(diagServer);
    if (diagRecord && ns.serverExists(diagServer)) {
      const r = diagRecord.actualEarned / elapsedSec;
      const te = diagRecord.theoreticalPerSec > 0 ? (r / diagRecord.theoreticalPerSec) * 100 : 0;
      const ce = diagRecord.conservativePerSec > 0 ? (r / diagRecord.conservativePerSec) * 100 : 0;
      const sec = ns.getServerSecurityLevel(diagServer);
      const minSec = ns.getServerMinSecurityLevel(diagServer);
      const money = ns.getServerMoneyAvailable(diagServer);
      const maxMoney = ns.getServerMaxMoney(diagServer);
      const moneyPct = maxMoney > 0 ? (money / maxMoney) * 100 : 0;
      const growParam = ns.getServerGrowth(diagServer);
      
      // Timing info
      const hackTime = ns.getHackTime(diagServer) / 1000;
      const growTime = ns.getGrowTime(diagServer) / 1000;
      const weakenTime = ns.getWeakenTime(diagServer) / 1000;
      
      // Hack analysis
      const hackPct = ns.hackAnalyze(diagServer);
      const hackChance = ns.hackAnalyzeChance(diagServer);
      
      // Theoretical cycle analysis
      const theoCycleMoney = maxMoney * (1 - MIN_REMAINING_FRACTION);
      const theoCycleTime = hackTime + growTime;
      const workerCount = ns.ps(diagServer).filter(p => 
        p.filename.includes("hack") || p.filename.includes("grow") || p.filename.includes("weaken")
      ).length;
      
      ns.print(`─── ${diagServer.toUpperCase()} DIAGNOSTICS ───────────────────────────────────`);
      ns.print(`Earned: $${fmt(ns, diagRecord.actualEarned)} | Rate: ${fmt(ns, r)}/s | T:${te.toFixed(0)}% C:${ce.toFixed(0)}%`);
      ns.print(`Money: $${fmt(ns, money)}/$${fmt(ns, maxMoney)} (${moneyPct.toFixed(1)}%) | Sec: ${sec.toFixed(1)}/${minSec} | Grow: ${growParam}`);
      ns.print(`Times: H:${hackTime.toFixed(2)}s G:${growTime.toFixed(2)}s W:${weakenTime.toFixed(2)}s`);
      ns.print(`Hack: ${(hackPct * 100).toFixed(2)}%/thread | ${(hackChance * 100).toFixed(1)}% chance | Workers: ${workerCount}`);
      ns.print(`Theo: $${fmt(ns, theoCycleMoney)}/cycle @ ${theoCycleTime.toFixed(2)}s = $${fmt(ns, diagRecord.theoreticalPerSec)}/s`);
      ns.print(`Cons: cycle @ ${(hackTime + growTime + 2 * weakenTime).toFixed(2)}s = $${fmt(ns, diagRecord.conservativePerSec)}/s`);
    } else if (diagServer !== "n00dles") {
      ns.print(`─── ${diagServer.toUpperCase()} DIAGNOSTICS ───────────────────────────────────`);
      ns.print(`Server "${diagServer}" not found or no data yet.`);
    }

    // Server table header
    const hdr = "$/s      | Theo$/s  | T%   | C%   | Sec   | Grow | Server";
    
    // Top servers
    ns.print("─── TOP 4 ─────────────────────────────────────────────────");
    ns.print(hdr);
    for (const r of top) {
      const secStr = `${r.sec.toFixed(0)}/${r.minSec}`;
      ns.print(`${fmt(ns, r.aps).padStart(8)} |${fmt(ns, r.theoreticalPerSec).padStart(9)} |${r.te.toFixed(0).padStart(4)}% |${r.ce.toFixed(0).padStart(4)}% |${secStr.padStart(6)} |${r.grow.toString().padStart(5)} | ${r.server}`);
    }

    // Bottom servers
    ns.print("─── BOTTOM 4 ──────────────────────────────────────────────");
    ns.print(hdr);
    for (const r of bottom) {
      const secStr = `${r.sec.toFixed(0)}/${r.minSec}`;
      ns.print(`${fmt(ns, r.aps).padStart(8)} |${fmt(ns, r.theoreticalPerSec).padStart(9)} |${r.te.toFixed(0).padStart(4)}% |${r.ce.toFixed(0).padStart(4)}% |${secStr.padStart(6)} |${r.grow.toString().padStart(5)} | ${r.server}`);
    }

    // Aggregate - compare orchestrator (ground truth) vs per-server tracking
    const orchEarningsPerSec = orchestratorEarnings / elapsedSec;
    const orchTE = aggTheo > 0 ? (orchEarningsPerSec / aggTheo) * 100 : 0;
    const orchCE = aggCons > 0 ? (orchEarningsPerSec / aggCons) * 100 : 0;
    
    // Per-server tracking (undercounts fast servers)
    const perServerTE = aggTheo > 0 ? (aggActualPerSec / aggTheo) * 100 : 0;
    const perServerCE = aggCons > 0 ? (aggActualPerSec / aggCons) * 100 : 0;
    
    // How much the per-server tracking misses
    const trackingCoverage = orchestratorEarnings > 0 ? (aggActual / orchestratorEarnings) * 100 : 0;
    
    const blacklistCount = BLACKLISTED_SERVERS.filter(s => stats.has(s)).length;
    ns.print("─── AGGREGATE ─────────────────────────────────────────────");
    ns.print(`Actual:  $${fmt(ns, orchestratorEarnings)} ($${fmt(ns, orchEarningsPerSec)}/s) | Eff: T:${orchTE.toFixed(1)}% C:${orchCE.toFixed(1)}%`);
    ns.print(`Tracked: $${fmt(ns, aggActual)} ($${fmt(ns, aggActualPerSec)}/s) | Eff: T:${perServerTE.toFixed(1)}% C:${perServerCE.toFixed(1)}% | Cov: ${trackingCoverage.toFixed(0)}%`);
    if (blacklistCount > 0) {
      ns.print(`(excluding ${blacklistCount} blacklisted servers from theoretical)`);
    }

    // Stock scripts
    if (stockStats.scripts.length > 0) {
      ns.print("─── STOCK SCRIPTS ─────────────────────────────────────────");
      for (const s of stockStats.scripts) {
        ns.print(`${s.filename}: $${fmt(ns, s.moneyMade)} ($${fmt(ns, s.rate)}/s) [${fmtTime(s.runningTime)}]`);
      }
    }

    // Stock positions
    if (ns.stock && ns.stock.hasTIXAPIAccess() && positions.length > 0) {
      ns.print("─── POSITIONS (top " + TOP_POSITIONS_TO_SHOW + ") ────────────────────────────────────");
      ns.print("Sym  |Side| Shares  | Avg     | Price   | P&L        | Fcst");
      for (const p of positions.slice(0, TOP_POSITIONS_TO_SHOW)) {
        const fc = p.forecast !== null ? `${(p.forecast * 100).toFixed(0)}%` : "N/A";
        ns.print(`${p.symbol.padEnd(4)} | ${p.side}  |${fmt(ns, p.shares, 0).padStart(8)} |${fmt(ns, p.avg, 0).padStart(8)} |${fmt(ns, p.price, 0).padStart(8)} |${(p.delta >= 0 ? "+" : "") + "$" + fmt(ns, p.delta, 1).padStart(9)} |${fc.padStart(5)}`);
      }
      if (positions.length > TOP_POSITIONS_TO_SHOW) {
        ns.print(`  ... and ${positions.length - TOP_POSITIONS_TO_SHOW} more positions`);
      }
      ns.print(`Unrealized: ${totalUnrealized >= 0 ? "+" : ""}$${fmt(ns, totalUnrealized)} | Invested: $${fmt(ns, totalInvested)} | Ret: ${((totalUnrealized / totalInvested) * 100).toFixed(2)}%`);
    }

    // Combined
    ns.print("═══════════════════════════════════════════════════════════");
    const grand = orchestratorEarnings + stockStats.totalMade + totalUnrealized;
    ns.print(`HACK: $${fmt(ns, orchestratorEarnings)} | STOCK(R): $${fmt(ns, stockStats.totalMade)} | STOCK(U): ${totalUnrealized >= 0 ? "+" : ""}$${fmt(ns, totalUnrealized)}`);
    ns.print(`TOTAL: $${fmt(ns, grand)} | RATE: $${fmt(ns, orchEarningsPerSec + stockStats.totalRate)}/s`);

    await ns.sleep(SAMPLE_INTERVAL);
  }
}