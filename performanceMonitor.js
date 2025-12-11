import { getAllServers } from "/utils/scanner.js";

const TOP_TARGETS = 5;
const SAMPLE_INTERVAL = 5_000; // ms
const MIN_REMAINING_FRACTION = 0.05; // Leave 5% (steal 95%) when estimating theoretical max
const TRADING_HISTORY_LENGTH = 30;

/**
 * Try to access the Formulas API (requires purchased program in-game)
 * @param {NS} ns
 * @returns {NS["formulas"] | null}
 */
function getFormulas(ns) {
  try {
    return ns.formulas || null;
  } catch {
    return null;
  }
}

/**
 * Pick the top N rooted servers with the highest max money
 * @param {NS} ns
 * @returns {{server: string, maxMoney: number}[]}
 */
function getTopTargets(ns) {
  const allServers = getAllServers(ns);
  const candidates = [];

  for (const server of allServers) {
    if (!ns.hasRootAccess(server)) continue;
    const maxMoney = ns.getServerMaxMoney(server);
    if (maxMoney <= 0) continue;

    candidates.push({ server, maxMoney });
  }

  candidates.sort((a, b) => b.maxMoney - a.maxMoney);
  return candidates.slice(0, TOP_TARGETS);
}

/**
 * Estimate the theoretical best-case earning rate for a server, assuming
 * a full grow-to-max cycle followed by a hack down to 5% remaining cash.
 * Cycle length ≈ growTime(min sec) + hackTime(min sec).
 * @param {NS} ns
 * @param {string} server
 * @param {Player} player
 * @param {NS["formulas"] | null} formulas
 * @returns {number} dollars per second
a */
function computeTheoreticalRate(ns, server, player, formulas) {
  const maxMoney = ns.getServerMaxMoney(server);
  if (maxMoney <= 0) return 0;

  const cycleMoney = maxMoney * (1 - MIN_REMAINING_FRACTION);
  let hackTime;
  let growTime;

  if (formulas && formulas.hacking) {
    const snapshot = ns.getServer(server);
    snapshot.hackDifficulty = snapshot.minDifficulty;
    snapshot.moneyAvailable = maxMoney;
    hackTime = formulas.hacking.hackTime(snapshot, player);
    growTime = formulas.hacking.growTime(snapshot, player);
  } else {
    hackTime = ns.getHackTime(server);
    growTime = ns.getGrowTime(server);
  }

  const cycleMs = hackTime + growTime;
  if (cycleMs <= 0) return 0;

  return cycleMoney / (cycleMs / 1000);
}

function format(ns, value) {
  return ns.formatNumber(value, 2).padStart(10, " ");
}

function computeInvestmentCapital(ns) {
  if (!ns.stock || !ns.stock.hasTIXAPIAccess()) return null;
  let capital = ns.getServerMoneyAvailable("home");
  const symbols = ns.stock.getSymbols();
  for (const symbol of symbols) {
    const [longShares, , shortShares] = ns.stock.getPosition(symbol);
    if (longShares > 0 || shortShares > 0) {
      const price = ns.stock.getPrice(symbol);
      capital += (longShares + shortShares) * price;
    }
  }
  return capital;
}

function updateInvestmentTracker(ns, tracker, hackingAttribution) {
  const capital = computeInvestmentCapital(ns);
  if (capital === null) return null;
  const adjustedCapital = Math.max(0, capital - (hackingAttribution ?? 0));

  if (tracker.baseline === null && adjustedCapital > 0) {
    tracker.baseline = adjustedCapital;
  }

  const now = Date.now();
  const elapsedSec = Math.max(1, (now - tracker.startTime) / 1000);
  const delta = tracker.baseline !== null ? adjustedCapital - tracker.baseline : 0;
  const pctGain =
    tracker.baseline && tracker.baseline > 0 ? (delta / tracker.baseline) * 100 : 0;
  const perHour = delta / (elapsedSec / 3600);

  tracker.history.push({ capital: adjustedCapital, timestamp: now });
  while (tracker.history.length > TRADING_HISTORY_LENGTH) {
    tracker.history.shift();
  }

  tracker.lastCapital = adjustedCapital;
  tracker.lastUpdate = now;

  return {
    capital: adjustedCapital,
    baseline: tracker.baseline,
    pctGain,
    delta,
    perHour
  };
}

function getHeldPositions(ns) {
  if (!ns.stock || !ns.stock.hasTIXAPIAccess()) return [];

  const positions = [];
  for (const symbol of ns.stock.getSymbols()) {
    const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(symbol);
    if (longShares <= 0 && shortShares <= 0) continue;

    const forecast = ns.stock.getForecast(symbol);
    const price = ns.stock.getPrice(symbol);

    if (longShares > 0) {
      const saleGain = ns.stock.getSaleGain(symbol, longShares, "Long");
      const invested = longShares * longAvg;
      const delta = saleGain - invested;
      positions.push({
        symbol,
        side: "LONG",
        shares: longShares,
        avg: longAvg,
        price,
        delta,
        forecast
      });
    }

    if (shortShares > 0) {
      const coverCost = ns.stock.getSaleGain(symbol, shortShares, "Short");
      const entryProceeds = shortShares * shortAvg;
      const delta = entryProceeds - coverCost;
      positions.push({
        symbol,
        side: "SHORT",
        shares: shortShares,
        avg: shortAvg,
        price,
        delta,
        forecast
      });
    }
  }

  positions.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return positions;
}

/**
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.clearLog();

  const stats = new Map(); // server -> {prevMoney, actualEarned, lastDelta, theoreticalPerSec}
  const tradingTracker = {
    baseline: null,
    history: [],
    lastCapital: 0,
    lastUpdate: null,
    startTime: Date.now()
  };
  const startTime = Date.now();

  while (true) {
    const player = ns.getPlayer();
    const formulas = getFormulas(ns);
    const topTargets = getTopTargets(ns);
    const activeSet = new Set(topTargets.map((t) => t.server));

    // Drop any stats for servers no longer in the top list
    for (const server of Array.from(stats.keys())) {
      if (!activeSet.has(server)) {
        stats.delete(server);
      }
    }

    let totalActual = 0;
    let totalTheoreticalPerSec = 0;
    const now = Date.now();

    for (const { server } of topTargets) {
      const currentMoney = ns.getServerMoneyAvailable(server);
      const record = stats.get(server) || {
        prevMoney: currentMoney,
        actualEarned: 0,
        lastDelta: 0,
        theoreticalPerSec: 0
      };

      let delta = record.prevMoney - currentMoney;
      if (delta < 0) delta = 0; // Ignore increases; only count money we actually drained
      record.actualEarned += delta;
      record.lastDelta = delta;
      record.prevMoney = currentMoney;
      record.theoreticalPerSec = computeTheoreticalRate(ns, server, player, formulas);
      record.lastMax = ns.getServerMaxMoney(server);
      record.lastUpdate = now;

      stats.set(server, record);

      totalActual += record.actualEarned;
      totalTheoreticalPerSec += record.theoreticalPerSec;
    }

    const elapsedSec = Math.max(1, (now - startTime) / 1000);
    const totalActualPerSec = totalActual / elapsedSec;

    ns.clearLog();
    ns.print("══════════ TARGET PERFORMANCE MONITOR ══════════");
    ns.print(`Tracking top ${topTargets.length} targets by max money (rooted only)`);
    ns.print(`Formulas: ${formulas ? "ON" : "OFF (using live times)"}`);
    ns.print(`Refresh interval: ${(SAMPLE_INTERVAL / 1000).toFixed(1)}s`);
    ns.print("");

    if (topTargets.length === 0) {
      ns.print("No rooted money servers available yet.");
    } else {
      ns.print("Server        | Actual Earned | Actual/s | Theoretical/s | Eff% | Last Δ | Max$");
      ns.print("--------------------------------------------------------------------------------");
      for (const { server } of topTargets) {
        const record = stats.get(server);
        const actualPerSec = record.actualEarned / elapsedSec;
        const theoreticalPerSec = record.theoreticalPerSec;
        const efficiency = theoreticalPerSec > 0 ? (actualPerSec / theoreticalPerSec) * 100 : 0;
        const recentPerSec = record.lastDelta / (SAMPLE_INTERVAL / 1000);

        const line = `${server.padEnd(12)} | $${format(ns, record.actualEarned)} | $${format(ns, actualPerSec)} | $${format(ns, theoreticalPerSec)} | ${efficiency.toFixed(1).padStart(5)} | $${format(ns, recentPerSec)} | $${ns.formatNumber(record.lastMax, 1)}`;
        ns.print(line);
      }
    }

    ns.print("");
    ns.print(`Aggregate actual: $${ns.formatNumber(totalActual)} (${ns.formatNumber(totalActualPerSec)}/s)`);
    ns.print(`Aggregate theoretical max: $${ns.formatNumber(totalTheoreticalPerSec)}/s`);
    const aggregateEfficiency = totalTheoreticalPerSec > 0 ? (totalActualPerSec / totalTheoreticalPerSec) * 100 : 0;
    ns.print(`Efficiency vs theoretical: ${aggregateEfficiency.toFixed(1)}%`);

    const tradingSummary = updateInvestmentTracker(ns, tradingTracker, totalActual);
    if (tradingSummary) {
      ns.print("");
      ns.print("══════ STOCK-TRADER PERFORMANCE ══════");
      if (tradingSummary.capital <= 0) {
        ns.print("No active holdings detected (waiting for investments).");
      } else if (!tradingSummary.baseline || tradingSummary.baseline <= 0) {
        ns.print(
          `Tracking baseline… current investment capital $${ns.formatNumber(tradingSummary.capital)}`
        );
      } else {
        ns.print(
          `Investment capital: $${ns
            .formatNumber(tradingSummary.capital)} (baseline $${ns.formatNumber(tradingSummary.baseline)})`
        );
        ns.print(
          `Total change: $${ns.formatNumber(tradingSummary.delta)} (${tradingSummary.pctGain.toFixed(2)}%)`
        );
        ns.print(`Change rate: $${ns.formatNumber(tradingSummary.perHour)}/hr since tracking start`);
      }

      const heldPositions = getHeldPositions(ns);
      ns.print("");
      ns.print("══════ HELD POSITIONS ══════");
      if (heldPositions.length === 0) {
        ns.print("No open positions to display.");
      } else {
        ns.print("Symbol | Side  | Shares | Avg Px | Curr Px | Δ if Exit | Forecast");
        ns.print("----------------------------------------------------------------");
        for (const pos of heldPositions) {
          const line = [
            pos.symbol.padEnd(6),
            pos.side.padEnd(5),
            pos.shares.toString().padStart(6),
            ns.formatNumber(pos.avg, 2).padStart(8),
            ns.formatNumber(pos.price, 2).padStart(8),
            `${pos.delta >= 0 ? "+" : ""}$${ns.formatNumber(pos.delta, 2)}`.padStart(12),
            `${(pos.forecast * 100).toFixed(1)}%`.padStart(7)
          ].join(" | ");
          ns.print(line);
        }
      }
    }

    await ns.sleep(SAMPLE_INTERVAL);
  }
}
