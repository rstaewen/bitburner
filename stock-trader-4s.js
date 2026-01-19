/** @param {NS} ns */

const CONFIG = {
  commission: 100_000,
  cycleDelay: 10_000,
  cashReserve: 10_000_000,
  allowShorting: false,
  excessCashForShorts: 1_000_000_000,
  minPurchase: 10_000_000  // Don't buy positions smaller than this
};

const BUY_BUCKETS = [
  { label: "+++", minForecast: 0.7, priority: 3 },
  { label: "++", minForecast: 0.6, priority: 2 },
  { label: "+", minForecast: 0.55, priority: 1 }
];

const SHORT_BUCKETS = [
  { label: "---", maxForecast: 0.3, priority: 3 },
  { label: "--", maxForecast: 0.4, priority: 2 },
  { label: "-", maxForecast: 0.45, priority: 1 }
];

const PRIORITY_ORDER = ["+++", "++", "+", "-", "--", "---"];

let shortAccessWarned = false;

export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");

  if (!ns.stock.hasTIXAPIAccess()) {
    ns.tprint("ERROR: TIX API access is required for stock-trader.js");
    return;
  }

  if (!ns.stock.has4SDataTIXAPI()) {
    ns.tprint(
      "WARN: 4S Market Data API is recommended for accurate forecasts, but continuing anyway."
    );
  }

  ns.print("stock-trader online. Building priority queues.");

  while (true) {
    const marketState = captureMarketState(ns);
    const { buyPriority, shortPriority } = buildPriorityLists(marketState);

    liquidatePositions(ns, marketState);

    executePurchases(ns, buyPriority, marketState);

    const shortingUnlocked = hasShortAccess(ns);
    if (CONFIG.allowShorting && shortingUnlocked && shouldEngageShorts(ns)) {
      executeShorts(ns, shortPriority, marketState);
    } else if (CONFIG.allowShorting && !shortingUnlocked && !shortAccessWarned) {
      ns.print(
        "Shorting disabled: requires BitNode-8 or Source-File 8 level 2. Set CONFIG.allowShorting to false to hide this message."
      );
      shortAccessWarned = true;
    }

    logPrioritySummary(ns, buyPriority, shortPriority);
    await ns.sleep(CONFIG.cycleDelay);
  }
}

function captureMarketState(ns) {
  const symbols = ns.stock.getSymbols();
  const map = new Map();

  for (const symbol of symbols) {
    const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(symbol);
    const forecast = ns.stock.getForecast(symbol);
    const volatility = ns.stock.getVolatility(symbol);
    const classification = classifyForecast(forecast);

    map.set(symbol, {
      symbol,
      price: ns.stock.getPrice(symbol),
      maxShares: ns.stock.getMaxShares(symbol),
      forecast,
      volatility,
      classification,
      longShares,
      longAvg,
      shortShares,
      shortAvg
    });
  }

  return map;
}

function classifyForecast(forecast) {
  for (const bucket of BUY_BUCKETS) {
    if (forecast >= bucket.minForecast) {
      return {
        bias: "buy",
        label: bucket.label,
        priority: bucket.priority
      };
    }
  }

  for (const bucket of SHORT_BUCKETS) {
    if (forecast <= bucket.maxForecast) {
      return {
        bias: "sell",
        label: bucket.label,
        priority: bucket.priority
      };
    }
  }

  return { bias: "neutral", label: "", priority: 0 };
}

function buildPriorityLists(marketState) {
  const buyPriority = [];
  const shortPriority = [];

  for (const stock of marketState.values()) {
    const entry = {
      symbol: stock.symbol,
      volatility: stock.volatility,
      forecast: stock.forecast,
      classification: stock.classification
    };

    if (entry.classification.bias === "buy") {
      buyPriority.push(entry);
    } else if (entry.classification.bias === "sell") {
      shortPriority.push(entry);
    }
  }

  const comparator = (a, b) => {
    if (a.classification.priority !== b.classification.priority) {
      return b.classification.priority - a.classification.priority;
    }
    if (a.volatility !== b.volatility) {
      return b.volatility - a.volatility;
    }
    return b.forecast - a.forecast;
  };

  buyPriority.sort(comparator);
  shortPriority.sort(comparator);

  return { buyPriority, shortPriority };
}

function liquidatePositions(ns, marketState) {
  let soldAnything = false;

  for (const stock of marketState.values()) {
    const longSold = liquidateLong(ns, stock);
    const shortSold = liquidateShort(ns, stock);
    soldAnything = soldAnything || longSold || shortSold;
  }

  return soldAnything;
}

function liquidateLong(ns, stock) {
  if (stock.longShares <= 0) return false;

  // IMMEDIATE EXIT: If forecast flipped to sell bias, dump it now regardless of profit
  if (stock.classification.bias === "sell") {
    const soldShares = ns.stock.sellStock(stock.symbol, stock.longShares);
    if (soldShares > 0) {
      const saleGain = ns.stock.getSaleGain(stock.symbol, soldShares, "Long");
      const costBasis = soldShares * stock.longAvg;
      const profit = saleGain - costBasis;
      ns.print(
        `EMERGENCY SOLD ${soldShares} ${stock.symbol} - forecast went negative (profit ${ns.nFormat(profit, "$0.00a")})`
      );
      return true;
    }
    return false;
  }

  // Normal exit: only sell weak buys or neutrals if profitable
  const shouldExit =
    stock.classification.bias === "neutral" || stock.classification.priority <= 1;
  if (!shouldExit) return false;

  const saleGain = ns.stock.getSaleGain(stock.symbol, stock.longShares, "Long");
  const costBasis = stock.longShares * stock.longAvg;
  const profit = saleGain - costBasis;

  if (profit <= CONFIG.commission) {
    return false;
  }

  const soldShares = ns.stock.sellStock(stock.symbol, stock.longShares);
  if (soldShares > 0) {
    ns.print(
      `Sold ${soldShares} ${stock.symbol} @ ${ns.nFormat(saleGain / soldShares, "$0.00a")} (profit ${ns.nFormat(profit, "$0.00a")})`
    );
    return true;
  }

  return false;
}

function liquidateShort(ns, stock) {
  if (stock.shortShares <= 0) return false;

  // IMMEDIATE EXIT: If forecast flipped to buy bias, cover now regardless of profit
  if (stock.classification.bias === "buy") {
    const covered = ns.stock.sellShort(stock.symbol, stock.shortShares);
    if (covered > 0) {
      const repurchaseCost = ns.stock.getSaleGain(stock.symbol, covered, "Short");
      const entryProceeds = covered * stock.shortAvg;
      const profit = entryProceeds - repurchaseCost;
      ns.print(
        `EMERGENCY COVERED ${covered} ${stock.symbol} - forecast went positive (profit ${ns.nFormat(profit, "$0.00a")})`
      );
      return true;
    }
    return false;
  }

  // Normal exit: only cover weak shorts or neutrals if profitable
  const shouldExit =
    stock.classification.bias === "neutral" || stock.classification.priority <= 1;
  if (!shouldExit) return false;

  const repurchaseCost = ns.stock.getSaleGain(stock.symbol, stock.shortShares, "Short");
  const entryProceeds = stock.shortShares * stock.shortAvg;
  const profit = entryProceeds - repurchaseCost;

  if (profit <= CONFIG.commission) {
    return false;
  }

  const covered = ns.stock.sellShort(stock.symbol, stock.shortShares);
  if (covered > 0) {
    ns.print(
      `Covered ${covered} ${stock.symbol} @ ${ns.nFormat(repurchaseCost / covered, "$0.00a")} (profit ${ns.nFormat(profit, "$0.00a")})`
    );
    return true;
  }

  return false;
}

function executePurchases(ns, buyPriority, marketState) {
  let available = ns.getServerMoneyAvailable("home") - CONFIG.cashReserve;

  if (available <= CONFIG.commission) {
    return;
  }

  ns.print(`DEBUG: Starting purchases with $${ns.nFormat(available, "0.00a")} available`);
  ns.print(`DEBUG: buyPriority order: ${buyPriority.slice(0, 10).map(e => e.symbol).join(", ")}`);

  for (const entry of buyPriority) {
    const stock = marketState.get(entry.symbol);
    
    if (!stock) {
      ns.print(`DEBUG: ${entry.symbol} - marketState lookup FAILED`);
      continue;
    }
    
    if (stock.shortShares > 0) {
      ns.print(`DEBUG: ${entry.symbol} - skipped, has short position`);
      continue;
    }

    const headroom = stock.maxShares - stock.longShares;
    if (headroom <= 0) {
      ns.print(`DEBUG: ${entry.symbol} - skipped, no headroom (max: ${stock.maxShares}, owned: ${stock.longShares})`);
      continue;
    }

    const price = ns.stock.getPrice(stock.symbol);
    const askPrice = ns.stock.getAskPrice(stock.symbol);
    const maxAffordable = Math.min(
      headroom,
      Math.floor((available - CONFIG.commission) / askPrice)  // Use ask price, not mid price
    );

    if (maxAffordable <= 0) {
      ns.print(`DEBUG: ${entry.symbol} - skipped, can't afford any shares`);
      continue;
    }

    const cost = ns.stock.getPurchaseCost(stock.symbol, maxAffordable, "Long");
    if (cost > available) continue;

    // Don't bother with tiny positions that commissions will eat
    if (cost < CONFIG.minPurchase) {
      ns.print(`DEBUG: ${entry.symbol} - skipped, position too small (${ns.nFormat(cost, "$0.00a")} < ${ns.nFormat(CONFIG.minPurchase, "$0.00a")})`);
      continue;
    }

    ns.print(`DEBUG: ${entry.symbol} - price: ${price}, askPrice: ${askPrice}, shares: ${maxAffordable}, cost: ${cost}, available: ${available}`);

    ns.print(`DEBUG: ${entry.symbol} - BUYING ${maxAffordable} shares`);
    const bought = ns.stock.buyStock(stock.symbol, maxAffordable);
    if (bought > 0) {
      available -= cost;
      ns.print(
        `Bought ${bought} ${stock.symbol} (${entry.classification.label}, vol ${entry.volatility.toFixed(3)})`
      );
    }

    if (available <= CONFIG.commission) break;
  }
}

function shouldEngageShorts(ns) {
  return ns.getServerMoneyAvailable("home") > CONFIG.excessCashForShorts;
}

function executeShorts(ns, shortPriority, marketState) {
  let available = ns.getServerMoneyAvailable("home") - CONFIG.cashReserve;
  if (available <= CONFIG.commission) return;

  for (const entry of shortPriority) {
    const stock = marketState.get(entry.symbol);
    if (!stock || stock.longShares > 0) continue;

    const headroom = stock.maxShares - stock.shortShares;
    if (headroom <= 0) continue;

    const price = ns.stock.getPrice(stock.symbol);
    const maxAffordable = Math.min(
      headroom,
      Math.floor((available - CONFIG.commission) / price)
    );
    if (maxAffordable <= 0) continue;

    const cost = ns.stock.getPurchaseCost(stock.symbol, maxAffordable, "Short");
    if (cost > available) continue;

    if (cost < CONFIG.minPurchase) {
      ns.print(`DEBUG: ${entry.symbol} - skipped, position too small`);
      continue;
    }

    const shorted = ns.stock.buyShort(stock.symbol, maxAffordable);
    if (shorted > 0) {
      available -= cost;
      ns.print(
        `Shorted ${shorted} ${stock.symbol} (${entry.classification.label}, vol ${entry.volatility.toFixed(
          3
        )})`
      );
    }

    if (available <= CONFIG.commission) break;
  }
}

function logPrioritySummary(ns, buyPriority, shortPriority) {
  const summarize = (list) =>
    list
      .slice(0, 5)
      .map(
        (entry) =>
          `${entry.symbol}:${entry.classification.label}/${entry.volatility.toFixed(3)}`
      )
      .join(", ");

  ns.print(`BUY: ${summarize(buyPriority)} | SHORT: ${summarize(shortPriority)}`);
}

function hasShortAccess(ns) {
  if (ns.getResetInfo().currentNode === 8) {
    return true;
  }

  if (typeof ns.getOwnedSourceFiles === "function") {
    try {
      const files = ns.getOwnedSourceFiles();
      if (Array.isArray(files)) {
        return files.some((sf) => sf.n === 8 && sf.lvl >= 2);
      }
    } catch {
      // Access might be restricted without SF-5; treat as locked.
    }
  }

  return false;
}