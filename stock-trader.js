/** @param {NS} ns */

const CONFIG = {
  commission: 100_000,
  cycleDelay: 6_000,
  cashReserve: 10_000_000,
  allowShorting: false,
  excessCashForShorts: 10_000_000,
  stopLossPercent: 0.15,
  takeProfitPercent: 0.20,  // Lowered from 0.50 - lock in gains earlier
  minPositionSize: 10_000_000
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

const HISTORY_LENGTH = 20;
const SHORT_TERM_WINDOW = 5;
const WARMUP_CYCLES = 15;
const COOLDOWN_CYCLES = 5;
const PREDICTION_HORIZON = 5;
const STRATEGY = "momentum"; // "momentum" or "contrarian"

let state;

function resetState() {
  state = {
    shortAccessWarned: false,
    priceHistory: new Map(),
    exitCooldowns: new Map(),
    cycleCount: 0,
    pendingPredictions: [],
    momentumStats: { correct: 0, total: 0, hypotheticalGain: 0 },
    contrarianStats: { correct: 0, total: 0, hypotheticalGain: 0 },
    perSymbolStats: new Map(),
    actualTrades: { wins: 0, losses: 0, totalPL: 0, totalCostBasis: 0 },
    exitReasons: { signal: 0, stopLoss: 0, takeProfit: 0, neutral: 0 }
  };
}

function initSymbolStats(symbol) {
  if (!state.perSymbolStats.has(symbol)) {
    state.perSymbolStats.set(symbol, {
      momentum: { correct: 0, total: 0 },
      contrarian: { correct: 0, total: 0 }
    });
  }
}

function recordPrediction(symbol, momentumLabel, contrarianLabel, momentumForecast, contrarianForecast, price) {
  if (momentumLabel === "" && contrarianLabel === "") return;
  
  state.pendingPredictions.push({
    cycle: state.cycleCount,
    symbol,
    momentumLabel,
    contrarianLabel,
    momentumForecast,
    contrarianForecast,
    priceAtPrediction: price
  });
}

function evaluatePendingPredictions(ns, marketState) {
  const toRemove = [];
  
  for (let i = 0; i < state.pendingPredictions.length; i++) {
    const pred = state.pendingPredictions[i];
    
    if (state.cycleCount - pred.cycle < PREDICTION_HORIZON) continue;
    
    const stock = marketState.get(pred.symbol);
    if (!stock) continue;
    
    const currentPrice = stock.price;
    const priceChange = (currentPrice - pred.priceAtPrediction) / pred.priceAtPrediction;
    
    initSymbolStats(pred.symbol);
    const stats = state.perSymbolStats.get(pred.symbol);
    
    if (pred.momentumLabel !== "") {
      const isBuy = pred.momentumLabel.includes("+");
      const isShort = pred.momentumLabel.includes("-") && !pred.momentumLabel.includes("+");
      
      let correct = false;
      let hypotheticalReturn = 0;
      
      if (isBuy) {
        correct = priceChange > 0;
        hypotheticalReturn = priceChange;
      } else if (isShort) {
        correct = priceChange < 0;
        hypotheticalReturn = -priceChange;
      }
      
      state.momentumStats.total++;
      if (correct) state.momentumStats.correct++;
      state.momentumStats.hypotheticalGain += hypotheticalReturn;
      
      stats.momentum.total++;
      if (correct) stats.momentum.correct++;
    }
    
    if (pred.contrarianLabel !== "") {
      const isBuy = pred.contrarianLabel.includes("+");
      const isShort = pred.contrarianLabel.includes("-") && !pred.contrarianLabel.includes("+");
      
      let correct = false;
      let hypotheticalReturn = 0;
      
      if (isBuy) {
        correct = priceChange > 0;
        hypotheticalReturn = priceChange;
      } else if (isShort) {
        correct = priceChange < 0;
        hypotheticalReturn = -priceChange;
      }
      
      state.contrarianStats.total++;
      if (correct) state.contrarianStats.correct++;
      state.contrarianStats.hypotheticalGain += hypotheticalReturn;
      
      stats.contrarian.total++;
      if (correct) stats.contrarian.correct++;
    }
    
    toRemove.push(i);
  }
  
  for (let i = toRemove.length - 1; i >= 0; i--) {
    state.pendingPredictions.splice(toRemove[i], 1);
  }
}

function logPredictionStats(ns) {
  if (state.momentumStats.total === 0 && state.contrarianStats.total === 0) return;
  
  ns.print(`━━━ STRATEGY COMPARISON ━━━`);
  
  if (state.momentumStats.total > 0) {
    const acc = ((state.momentumStats.correct / state.momentumStats.total) * 100).toFixed(1);
    const avgRet = ((state.momentumStats.hypotheticalGain / state.momentumStats.total) * 100).toFixed(3);
    const marker = STRATEGY === "momentum" ? " ◄ ACTIVE" : "";
    ns.print(`MOMENTUM:   ${state.momentumStats.correct}/${state.momentumStats.total} (${acc}%) | Avg return: ${avgRet}%${marker}`);
  }
  
  if (state.contrarianStats.total > 0) {
    const acc = ((state.contrarianStats.correct / state.contrarianStats.total) * 100).toFixed(1);
    const avgRet = ((state.contrarianStats.hypotheticalGain / state.contrarianStats.total) * 100).toFixed(3);
    const marker = STRATEGY === "contrarian" ? " ◄ ACTIVE" : "";
    ns.print(`CONTRARIAN: ${state.contrarianStats.correct}/${state.contrarianStats.total} (${acc}%) | Avg return: ${avgRet}%${marker}`);
  }
  
  // Show actual trade performance
  const totalTrades = state.actualTrades.wins + state.actualTrades.losses;
  if (totalTrades > 0) {
    const winRate = ((state.actualTrades.wins / totalTrades) * 100).toFixed(1);
    
    // Calculate actual average return percentage
    let avgActualReturn = "N/A";
    if (state.actualTrades.totalCostBasis > 0) {
      avgActualReturn = ((state.actualTrades.totalPL / state.actualTrades.totalCostBasis) * 100 / totalTrades).toFixed(3);
    }
    
    ns.print(`ACTUAL:     ${state.actualTrades.wins}W/${state.actualTrades.losses}L (${winRate}%) | Avg return: ${avgActualReturn}% | Total P/L: ${ns.nFormat(state.actualTrades.totalPL, "$0.00a")}`);
    
    // Show exit reason breakdown
    const { signal, stopLoss, takeProfit, neutral } = state.exitReasons;
    ns.print(`Exits: Signal ${signal}, StopLoss ${stopLoss}, TakeProfit ${takeProfit}, Neutral ${neutral}`);
  }
  
  // Show which strategy is winning per symbol
  const symbolComparison = [];
  for (const [symbol, stats] of state.perSymbolStats.entries()) {
    if (stats.momentum.total >= 5 && stats.contrarian.total >= 5) {
      const momAcc = stats.momentum.correct / stats.momentum.total;
      const conAcc = stats.contrarian.correct / stats.contrarian.total;
      symbolComparison.push({ 
        symbol, 
        momAcc: (momAcc * 100).toFixed(0),
        conAcc: (conAcc * 100).toFixed(0)
      });
    }
  }
  
  if (symbolComparison.length > 0) {
    const contrarianWins = symbolComparison.filter(s => parseInt(s.conAcc) > parseInt(s.momAcc)).length;
    const momentumWins = symbolComparison.filter(s => parseInt(s.momAcc) > parseInt(s.conAcc)).length;
    ns.print(`Symbol winners: Momentum ${momentumWins}, Contrarian ${contrarianWins}`);
  }
  
  ns.print(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

export async function main(ns) {
  resetState();
  
  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");
  ns.ui.openTail();

  if (!ns.stock.hasTIXAPIAccess()) {
    ns.tprint("ERROR: TIX API access is required for stock-trader.js");
    return;
  }

  const has4S = ns.stock.has4SDataTIXAPI();
  if (!has4S) {
    ns.tprint(`INFO: Running WITHOUT 4S data. Using ${STRATEGY.toUpperCase()} strategy.`);
    ns.tprint(`INFO: Take profit: ${(CONFIG.takeProfitPercent * 100).toFixed(0)}%, Stop loss: ${(CONFIG.stopLossPercent * 100).toFixed(0)}%`);
  }

  ns.print(`stock-trader v5 online. Strategy: ${STRATEGY.toUpperCase()} | TP: ${(CONFIG.takeProfitPercent * 100)}% SL: ${(CONFIG.stopLossPercent * 100)}%`);

  while (true) {
    const marketState = captureMarketState(ns, has4S);
    const { buyPriority, shortPriority } = buildPriorityLists(marketState);

    evaluatePendingPredictions(ns, marketState);

    for (const stock of marketState.values()) {
      recordPrediction(
        stock.symbol,
        stock.momentumClassification.label,
        stock.contrarianClassification.label,
        stock.momentumForecast,
        stock.contrarianForecast,
        stock.price
      );
    }

    liquidatePositions(ns, marketState);

    const readyToTrade = has4S || state.cycleCount >= WARMUP_CYCLES;
    
    if (readyToTrade) {
      executePurchases(ns, buyPriority, marketState);

      const shortingUnlocked = hasShortAccess(ns);
      if (CONFIG.allowShorting && shortingUnlocked && shouldEngageShorts(ns)) {
        executeShorts(ns, shortPriority, marketState);
      } else if (CONFIG.allowShorting && !shortingUnlocked && !state.shortAccessWarned) {
        ns.print("Shorting disabled: requires BitNode-8 or Source-File 8 level 2.");
        state.shortAccessWarned = true;
      }
    } else {
      ns.print(`Warming up... (${state.cycleCount + 1}/${WARMUP_CYCLES})`);
    }

    logPrioritySummary(ns, buyPriority, shortPriority);
    
    if (state.cycleCount > 0 && state.cycleCount % 10 === 0) {
      logPredictionStats(ns);
    }
    
    state.cycleCount++;
    await ns.sleep(CONFIG.cycleDelay);
  }
}

function captureMarketState(ns, has4S) {
  const symbols = ns.stock.getSymbols();
  const map = new Map();

  for (const symbol of symbols) {
    const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(symbol);
    const currentPrice = ns.stock.getPrice(symbol);
    
    let momentumForecast, contrarianForecast, volatility;
    
    if (has4S) {
      const forecast = ns.stock.getForecast(symbol);
      momentumForecast = forecast;
      contrarianForecast = forecast;
      volatility = ns.stock.getVolatility(symbol);
    } else {
      if (!state.priceHistory.has(symbol)) {
        state.priceHistory.set(symbol, []);
      }
      const history = state.priceHistory.get(symbol);
      history.push(currentPrice);
      if (history.length > HISTORY_LENGTH) {
        history.shift();
      }
      
      if (history.length >= 5) {
        const recentHistory = history.slice(-5);
        const changes = [];
        for (let i = 1; i < recentHistory.length; i++) {
          const change = Math.abs((recentHistory[i] - recentHistory[i-1]) / recentHistory[i-1]);
          changes.push(change);
        }
        volatility = changes.reduce((a, b) => a + b, 0) / changes.length;
      } else {
        volatility = 0;
      }
      
      if (history.length >= 10) {
        const n = history.length;
        
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (let i = 0; i < n; i++) {
          sumX += i;
          sumY += history[i];
          sumXY += i * history[i];
          sumX2 += i * i;
        }
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const avgPrice = sumY / n;
        const trendPercent = slope / avgPrice;
        
        const recentAvg = history.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const historicalAvg = history.slice(0, -5).reduce((a, b) => a + b, 0) / Math.max(1, n - 5);
        const meanReversionSignal = (recentAvg - historicalAvg) / historicalAvg;
        
        const momentumRaw = 0.5 + (trendPercent * 50);
        momentumForecast = Math.max(0.1, Math.min(0.9, momentumRaw));
        
        const contrarianRaw = 0.5 - (trendPercent * 50) - (meanReversionSignal * 30);
        contrarianForecast = Math.max(0.1, Math.min(0.9, contrarianRaw));
        
      } else {
        momentumForecast = 0.5;
        contrarianForecast = 0.5;
      }
    }
    
    const momentumClassification = classifyForecast(momentumForecast);
    const contrarianClassification = classifyForecast(contrarianForecast);
    
    const activeClassification = STRATEGY === "contrarian" ? contrarianClassification : momentumClassification;
    const activeForecast = STRATEGY === "contrarian" ? contrarianForecast : momentumForecast;

    map.set(symbol, {
      symbol,
      price: currentPrice,
      maxShares: ns.stock.getMaxShares(symbol),
      forecast: activeForecast,
      momentumForecast,
      contrarianForecast,
      volatility,
      classification: activeClassification,
      momentumClassification,
      contrarianClassification,
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
    return b.volatility - a.volatility;
  };

  buyPriority.sort(comparator);
  shortPriority.sort(comparator);

  return { buyPriority, shortPriority };
}

function liquidatePositions(ns, marketState) {
  for (const stock of marketState.values()) {
    liquidateLong(ns, stock);
    liquidateShort(ns, stock);
  }
}

function liquidateLong(ns, stock) {
  if (stock.longShares <= 0) return false;

  const saleGain = ns.stock.getSaleGain(stock.symbol, stock.longShares, "Long");
  const costBasis = stock.longShares * stock.longAvg;
  const profitPercent = (saleGain - costBasis) / costBasis;

  const hitStopLoss = profitPercent < -CONFIG.stopLossPercent;
  const hitTakeProfit = profitPercent > CONFIG.takeProfitPercent;
  
  const shouldExit = stock.classification.bias === "sell" && stock.classification.priority >= 2;
  const exitNeutralWithProfit = stock.classification.bias === "neutral" && profitPercent > 0.02;
  
  if (!shouldExit && !exitNeutralWithProfit && !hitStopLoss && !hitTakeProfit) {
    return false;
  }

  const soldShares = ns.stock.sellStock(stock.symbol, stock.longShares);
  if (soldShares > 0) {
    const delta = saleGain - costBasis;
    let reason = "📊 SIGNAL";
    
    if (hitStopLoss) {
      reason = "🛑 STOP LOSS";
      state.exitReasons.stopLoss++;
      state.exitCooldowns.set(stock.symbol, state.cycleCount + COOLDOWN_CYCLES);
    } else if (hitTakeProfit) {
      reason = "💰 TAKE PROFIT";
      state.exitReasons.takeProfit++;
    } else if (exitNeutralWithProfit) {
      reason = "⚖️ NEUTRAL+PROFIT";
      state.exitReasons.neutral++;
    } else {
      state.exitReasons.signal++;
    }
    
    ns.print(
      `${reason}: Sold ${ns.nFormat(soldShares, "0.00a")} ${stock.symbol} (${(profitPercent * 100).toFixed(1)}%, P/L ${ns.nFormat(delta, "$0.00a")})`
    );
    
    if (delta > 0) state.actualTrades.wins++;
    else state.actualTrades.losses++;
    state.actualTrades.totalPL += delta;
    state.actualTrades.totalCostBasis += costBasis;
    
    return true;
  }

  return false;
}

function liquidateShort(ns, stock) {
  if (stock.shortShares <= 0) return false;

  const saleGain = ns.stock.getSaleGain(stock.symbol, stock.shortShares, "Short");
  const costBasis = stock.shortShares * stock.shortAvg;
  const profitPercent = (saleGain - costBasis) / costBasis;

  const hitStopLoss = profitPercent < -CONFIG.stopLossPercent;
  const hitTakeProfit = profitPercent > CONFIG.takeProfitPercent;
  
  const shouldExit = stock.classification.bias === "buy" && stock.classification.priority >= 2;
  const exitNeutralWithProfit = stock.classification.bias === "neutral" && profitPercent > 0.02;
  
  if (!shouldExit && !exitNeutralWithProfit && !hitStopLoss && !hitTakeProfit) {
    return false;
  }

  const covered = ns.stock.sellShort(stock.symbol, stock.shortShares);
  if (covered > 0) {
    const delta = saleGain - costBasis;
    let reason = "📊 SIGNAL";
    
    if (hitStopLoss) {
      reason = "🛑 STOP LOSS";
      state.exitReasons.stopLoss++;
      state.exitCooldowns.set(stock.symbol, state.cycleCount + COOLDOWN_CYCLES);
    } else if (hitTakeProfit) {
      reason = "💰 TAKE PROFIT";
      state.exitReasons.takeProfit++;
    } else if (exitNeutralWithProfit) {
      reason = "⚖️ NEUTRAL+PROFIT";
      state.exitReasons.neutral++;
    } else {
      state.exitReasons.signal++;
    }
    
    ns.print(
      `${reason}: Covered ${ns.nFormat(covered, "0.00a")} ${stock.symbol} (${(profitPercent * 100).toFixed(1)}%, P/L ${ns.nFormat(delta, "$0.00a")})`
    );
    
    if (delta > 0) state.actualTrades.wins++;
    else state.actualTrades.losses++;
    state.actualTrades.totalPL += delta;
    state.actualTrades.totalCostBasis += costBasis;
    
    return true;
  }

  return false;
}

function executePurchases(ns, buyPriority, marketState) {  
  let available = ns.getServerMoneyAvailable("home") - CONFIG.cashReserve;

  if (available <= CONFIG.commission) {
    return;
  }

  for (const entry of buyPriority) {
    const stock = marketState.get(entry.symbol);
    if (!stock || stock.shortShares > 0) continue;

    const cooldownUntil = state.exitCooldowns.get(stock.symbol);
    if (cooldownUntil && state.cycleCount < cooldownUntil) {
      continue;
    }

    const headroom = stock.maxShares - stock.longShares;
    if (headroom <= 0) continue;

    const price = ns.stock.getPrice(stock.symbol);
    const maxAffordable = Math.min(
      headroom,
      Math.floor((available - CONFIG.commission) / price)
    );

    if (maxAffordable <= 0) continue;

    const cost = ns.stock.getPurchaseCost(stock.symbol, maxAffordable, "Long");
    if (cost > available) continue;
    
    if (cost < CONFIG.minPositionSize) {
      continue;
    }

    const bought = ns.stock.buyStock(stock.symbol, maxAffordable);
    if (bought > 0) {
      available -= cost;
      ns.print(
        `[${STRATEGY.toUpperCase()}] Bought ${ns.nFormat(bought, "0.00a")} ${stock.symbol} (${entry.classification.label}, forecast ${stock.forecast.toFixed(2)})`
      );
    }

    if (available <= CONFIG.commission) break;
  }
}

function shouldEngageShorts(ns) {
  if (ns.getResetInfo().currentNode === 8) {
    return ns.getServerMoneyAvailable("home") > CONFIG.cashReserve;
  }
  return ns.getServerMoneyAvailable("home") > CONFIG.excessCashForShorts;
}

function executeShorts(ns, shortPriority, marketState) {
  let available = ns.getServerMoneyAvailable("home") - CONFIG.cashReserve;
  if (available <= CONFIG.commission) return;

  for (const entry of shortPriority) {
    const stock = marketState.get(entry.symbol);
    if (!stock || stock.longShares > 0) continue;

    const cooldownUntil = state.exitCooldowns.get(stock.symbol);
    if (cooldownUntil && state.cycleCount < cooldownUntil) {
      continue;
    }

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
    
    if (cost < CONFIG.minPositionSize) {
      continue;
    }

    const shorted = ns.stock.buyShort(stock.symbol, maxAffordable);
    if (shorted > 0) {
      available -= cost;
      ns.print(
        `[${STRATEGY.toUpperCase()}] Shorted ${ns.nFormat(shorted, "0.00a")} ${stock.symbol} (${entry.classification.label}, forecast ${stock.forecast.toFixed(2)})`
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
      // Access might be restricted without SF-5
    }
  }

  return false;
}