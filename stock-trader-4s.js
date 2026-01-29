/** @param {NS} ns */

const CONFIG = {
  commission: 100_000,
  cycleDelay: 10_000,
  cashReserve: 0.01,
  allowShorting: false,
  excessCashForShorts: 1_000_000_000,
  minPurchase: 10_000_000,  // Don't buy positions smaller than this
  weakPositionMinProfit: 0.03,  // 3% min profit for weak positions to cover buy/sell spread
  strongPositionThreshold: 2  // Priority >= this is considered "strong" (++ or better)
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

    liquidatePositions(ns, marketState, buyPriority, shortPriority);

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

function liquidatePositions(ns, marketState, buyPriority, shortPriority) {
  let soldAnything = false;

  // Check if strong positions are available (priority >= threshold)
  const hasStrongBuyPosition = buyPriority.some(
    e => e.classification.priority >= CONFIG.strongPositionThreshold &&
         marketState.get(e.symbol).longShares < marketState.get(e.symbol).maxShares
  );
  const hasStrongShortPosition = shortPriority.some(
    e => e.classification.priority >= CONFIG.strongPositionThreshold &&
         marketState.get(e.symbol).shortShares < marketState.get(e.symbol).maxShares
  );

  for (const stock of marketState.values()) {
    const longSold = liquidateLong(ns, stock, hasStrongBuyPosition);
    const shortSold = liquidateShort(ns, stock, hasStrongShortPosition);
    soldAnything = soldAnything || longSold || shortSold;
  }

  return soldAnything;
}

function liquidateLong(ns, stock, hasStrongBuyPosition) {
  if (stock.longShares <= 0) return false;

  const saleGain = ns.stock.getSaleGain(stock.symbol, stock.longShares, "Long");
  const costBasis = stock.longShares * stock.longAvg;
  const profit = saleGain - costBasis;
  const profitPercent = profit / costBasis;

  // IMMEDIATE EXIT: If forecast dropped below 0.50, dump it now regardless of profit
  // This catches both "sell" bias (<0.45) and neutral positions trending down (0.45-0.50)
  if (stock.forecast < 0.50) {
    const soldShares = ns.stock.sellStock(stock.symbol, stock.longShares);
    if (soldShares > 0) {
      ns.print(
        `EMERGENCY SOLD ${soldShares} ${stock.symbol} - forecast below 0.50 (${stock.forecast.toFixed(3)}, profit ${ns.nFormat(profit, "$0.00a")})`
      );
      return true;
    }
    return false;
  }

  // For strong positions (++ or better), don't sell - let them ride
  if (stock.classification.priority >= CONFIG.strongPositionThreshold) {
    return false;
  }

  // For weak positions (+ or neutral):
  // - If strong positions are available to buy, sell as soon as profitable (free up cash)
  // - If no strong positions available, hold until we recover the spread (~3%)
  const isWeakPosition = stock.classification.priority <= 1 || stock.classification.bias === "neutral";
  if (!isWeakPosition) return false;

  // Determine minimum profit threshold
  let minProfitThreshold;
  if (hasStrongBuyPosition) {
    // Strong positions available - sell weak ones as soon as profitable to free up cash
    minProfitThreshold = CONFIG.commission;
  } else {
    // No strong positions - hold weak ones until we recover the spread
    minProfitThreshold = Math.max(CONFIG.commission, costBasis * CONFIG.weakPositionMinProfit);
  }

  if (profit <= minProfitThreshold) {
    return false;
  }

  const soldShares = ns.stock.sellStock(stock.symbol, stock.longShares);
  if (soldShares > 0) {
    ns.print(
      `Sold ${soldShares} ${stock.symbol} @ ${ns.nFormat(saleGain / soldShares, "$0.00a")} (profit ${ns.nFormat(profit, "$0.00a")}, ${(profitPercent * 100).toFixed(1)}%)`
    );
    return true;
  }

  return false;
}

function liquidateShort(ns, stock, hasStrongShortPosition) {
  if (stock.shortShares <= 0) return false;

  const repurchaseCost = ns.stock.getSaleGain(stock.symbol, stock.shortShares, "Short");
  const entryProceeds = stock.shortShares * stock.shortAvg;
  const profit = entryProceeds - repurchaseCost;
  const profitPercent = profit / entryProceeds;

  // IMMEDIATE EXIT: If forecast rose above 0.50, cover now regardless of profit
  // This catches both "buy" bias (>0.55) and neutral positions trending up (0.50-0.55)
  if (stock.forecast > 0.50) {
    const covered = ns.stock.sellShort(stock.symbol, stock.shortShares);
    if (covered > 0) {
      ns.print(
        `EMERGENCY COVERED ${covered} ${stock.symbol} - forecast above 0.50 (${stock.forecast.toFixed(3)}, profit ${ns.nFormat(profit, "$0.00a")})`
      );
      return true;
    }
    return false;
  }

  // For strong positions (-- or better), don't cover - let them ride
  if (stock.classification.priority >= CONFIG.strongPositionThreshold) {
    return false;
  }

  // For weak positions (- or neutral):
  // - If strong short positions are available, cover as soon as profitable (free up cash)
  // - If no strong positions available, hold until we recover the spread (~3%)
  const isWeakPosition = stock.classification.priority <= 1 || stock.classification.bias === "neutral";
  if (!isWeakPosition) return false;

  // Determine minimum profit threshold
  let minProfitThreshold;
  if (hasStrongShortPosition) {
    // Strong positions available - cover weak ones as soon as profitable to free up cash
    minProfitThreshold = CONFIG.commission;
  } else {
    // No strong positions - hold weak ones until we recover the spread
    minProfitThreshold = Math.max(CONFIG.commission, entryProceeds * CONFIG.weakPositionMinProfit);
  }

  if (profit <= minProfitThreshold) {
    return false;
  }

  const covered = ns.stock.sellShort(stock.symbol, stock.shortShares);
  if (covered > 0) {
    ns.print(
      `Covered ${covered} ${stock.symbol} @ ${ns.nFormat(repurchaseCost / covered, "$0.00a")} (profit ${ns.nFormat(profit, "$0.00a")}, ${(profitPercent * 100).toFixed(1)}%)`
    );
    return true;
  }

  return false;
}

function executePurchases(ns, buyPriority, marketState) {
  let available = getAvailableCash(ns);

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

// Returns the amount of cash available for trading. 
// Reserves at between 10M (minimum) and 100% - CONFIG.cashReserve (maximum) (default 99% of cash)
function getAvailableCash(ns) {
  return Math.max(0, Math.min(ns.getServerMoneyAvailable("home") - 10_000_000, ns.getServerMoneyAvailable("home") * (1.0 - CONFIG.cashReserve)));
}

function shouldEngageShorts(ns) {
  return ns.getServerMoneyAvailable("home") > CONFIG.excessCashForShorts;
}

function executeShorts(ns, shortPriority, marketState) {
  let available = getAvailableCash(ns);
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