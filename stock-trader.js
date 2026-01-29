/** @param {NS} ns */

/**
 * Stock Trader (Non-4S Version)
 * 
 * Strategy: Moving Average Crossover with Value Entry
 * - Buy when short MA crosses above long MA AND price is in lower half of recent range
 * - Sell on profit target, stop loss, or MA cross back down
 * - No directional prediction - just follow trends and manage risk
 */

const CONFIG = {
  commission: 100_000,
  cycleDelay: 6_000,
  cashReserve: 10_000_000,
  
  // MA settings
  shortMA: 5,
  longMA: 15,
  historyLength: 25,
  warmupCycles: 20,
  
  // Exit thresholds - conservative for non-4S
  profitTarget: 0.10,     // 10% - let winners run more
  stopLoss: 0.12,         // 12% - wider to avoid noise shakeouts
  trailingStopActivation: 0.05,  // Activate trailing stop after 5% gain
  trailingStopDistance: 0.03,    // Trail by 3%
  
  // Position sizing
  maxPositionPercent: 0.25,  // Max 25% of portfolio in one stock
  minPositionSize: 5_000_000,
  
  // Risk management
  cooldownCycles: 10,        // Wait after a stop loss before re-entering
  maxVolatility: 0.03,       // Don't enter during high volatility
  valueEntryThreshold: 0.6,  // Only buy when price is in lower 60% of range
};

let state = {
  priceHistory: new Map(),
  positions: new Map(),  // Track entry info for trailing stops
  cooldowns: new Map(),
  cycleCount: 0,
  stats: { wins: 0, losses: 0, totalPL: 0 }
};

export async function main(ns) {
  ns.disableLog("ALL");
  ns.ui.openTail();

  if (!ns.stock.hasTIXAPIAccess()) {
    ns.tprint("ERROR: TIX API access required");
    return;
  }

  if (ns.stock.has4SDataTIXAPI()) {
    ns.tprint("WARN: You have 4S access. Consider using stock-trader-4s.js instead.");
  }

  ns.print("Stock Trader v6 (MA Crossover) starting...");
  ns.print(`Settings: TP ${CONFIG.profitTarget * 100}% | SL ${CONFIG.stopLoss * 100}% | Max position ${CONFIG.maxPositionPercent * 100}%`);

  while (true) {
    const market = analyzeMarket(ns);
    
    if (state.cycleCount >= CONFIG.warmupCycles) {
      processExits(ns, market);
      processEntries(ns, market);
    } else {
      ns.print(`Warming up... ${state.cycleCount + 1}/${CONFIG.warmupCycles}`);
    }

    if (state.cycleCount % 10 === 0) {
      logStatus(ns, market);
    }

    state.cycleCount++;
    await ns.sleep(CONFIG.cycleDelay);
  }
}

function analyzeMarket(ns) {
  const symbols = ns.stock.getSymbols();
  const market = new Map();

  for (const symbol of symbols) {
    const price = ns.stock.getPrice(symbol);
    const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(symbol);
    
    // Update price history
    if (!state.priceHistory.has(symbol)) {
      state.priceHistory.set(symbol, []);
    }
    const history = state.priceHistory.get(symbol);
    history.push(price);
    if (history.length > CONFIG.historyLength) {
      history.shift();
    }

    // Calculate indicators
    const indicators = calculateIndicators(history);
    
    market.set(symbol, {
      symbol,
      price,
      maxShares: ns.stock.getMaxShares(symbol),
      longShares,
      longAvg,
      shortShares,
      shortAvg,
      ...indicators
    });
  }

  return market;
}

function calculateIndicators(history) {
  if (history.length < CONFIG.longMA) {
    return { ready: false, signal: "wait", shortMA: 0, longMA: 0, rangePosition: 0.5, volatility: 0 };
  }

  // Moving averages
  const shortMA = average(history.slice(-CONFIG.shortMA));
  const longMA = average(history.slice(-CONFIG.longMA));
  
  // Price range position (0 = at min, 1 = at max)
  const min = Math.min(...history);
  const max = Math.max(...history);
  const current = history[history.length - 1];
  const rangePosition = max > min ? (current - min) / (max - min) : 0.5;
  
  // Volatility (average absolute % change)
  const changes = [];
  for (let i = 1; i < history.length; i++) {
    changes.push(Math.abs((history[i] - history[i - 1]) / history[i - 1]));
  }
  const volatility = average(changes);
  
  // Generate signal
  let signal = "hold";
  const maCrossUp = shortMA > longMA;
  const maCrossDown = shortMA < longMA;
  const isValueEntry = rangePosition < CONFIG.valueEntryThreshold;
  const isLowVolatility = volatility < CONFIG.maxVolatility;
  
  if (maCrossUp && isValueEntry && isLowVolatility) {
    signal = "buy";
  } else if (maCrossDown) {
    signal = "sell";
  }

  return {
    ready: true,
    signal,
    shortMA,
    longMA,
    rangePosition,
    volatility,
    maCrossUp,
    maCrossDown
  };
}

function processExits(ns, market) {
  for (const [symbol, stock] of market) {
    if (stock.longShares <= 0) continue;

    const saleGain = ns.stock.getSaleGain(symbol, stock.longShares, "Long");
    const costBasis = stock.longShares * stock.longAvg;
    const profitPercent = (saleGain - costBasis) / costBasis;
    
    // Track high water mark for trailing stop
    const position = state.positions.get(symbol) || { highWaterMark: profitPercent };
    if (profitPercent > position.highWaterMark) {
      position.highWaterMark = profitPercent;
      state.positions.set(symbol, position);
    }

    let exitReason = null;

    // Check exit conditions in priority order
    if (profitPercent <= -CONFIG.stopLoss) {
      exitReason = "🛑 STOP LOSS";
      state.cooldowns.set(symbol, state.cycleCount + CONFIG.cooldownCycles);
    } else if (profitPercent >= CONFIG.profitTarget) {
      exitReason = "💰 PROFIT TARGET";
    } else if (position.highWaterMark >= CONFIG.trailingStopActivation && 
               profitPercent < position.highWaterMark - CONFIG.trailingStopDistance) {
      exitReason = "📉 TRAILING STOP";
    }

    if (exitReason) {
      const sold = ns.stock.sellStock(symbol, stock.longShares);
      if (sold > 0) {
        const pl = saleGain - costBasis;
        ns.print(`${exitReason}: ${symbol} | ${(profitPercent * 100).toFixed(1)}% | P/L ${ns.nFormat(pl, "$0.00a")}`);
        
        if (pl > 0) state.stats.wins++;
        else state.stats.losses++;
        state.stats.totalPL += pl;
        
        state.positions.delete(symbol);
      }
    }
  }
}

function processEntries(ns, market) {
  const available = ns.getServerMoneyAvailable("home") - CONFIG.cashReserve;
  if (available <= CONFIG.commission) return;

  // Get buy candidates sorted by signal strength
  const candidates = [];
  for (const [symbol, stock] of market) {
    if (stock.signal !== "buy") continue;
    if (stock.longShares > 0 || stock.shortShares > 0) continue;
    
    // Check cooldown
    const cooldownUntil = state.cooldowns.get(symbol);
    if (cooldownUntil && state.cycleCount < cooldownUntil) continue;

    // Score by: how far above long MA, how low in range, how low volatility
    const maStrength = (stock.shortMA - stock.longMA) / stock.longMA;
    const valueScore = 1 - stock.rangePosition;
    const stabilityScore = 1 - (stock.volatility / CONFIG.maxVolatility);
    const score = maStrength + valueScore * 0.5 + stabilityScore * 0.3;
    
    candidates.push({ symbol, stock, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Calculate max position size
  const portfolio = getPortfolioValue(ns, market);
  const maxPositionValue = portfolio * CONFIG.maxPositionPercent;

  let remainingCash = available;
  for (const { symbol, stock, score } of candidates) {
    if (remainingCash <= CONFIG.commission) break;

    const price = ns.stock.getAskPrice(symbol);
    const maxByPortfolio = Math.floor(maxPositionValue / price);
    const maxByHeadroom = stock.maxShares - stock.longShares;
    const maxByCash = Math.floor((remainingCash - CONFIG.commission) / price);
    const shares = Math.min(maxByPortfolio, maxByHeadroom, maxByCash);

    if (shares <= 0) continue;

    const cost = ns.stock.getPurchaseCost(symbol, shares, "Long");
    if (cost < CONFIG.minPositionSize) continue;
    if (cost > remainingCash) continue;

    const bought = ns.stock.buyStock(symbol, shares);
    if (bought > 0) {
      remainingCash -= cost;
      state.positions.set(symbol, { highWaterMark: 0 });
      ns.print(`BUY: ${symbol} | ${ns.nFormat(bought, "0.00a")} shares | Range ${(stock.rangePosition * 100).toFixed(0)}% | Score ${score.toFixed(2)}`);
    }
  }
}

function getPortfolioValue(ns, market) {
  let value = ns.getServerMoneyAvailable("home");
  for (const [symbol, stock] of market) {
    if (stock.longShares > 0) {
      value += ns.stock.getSaleGain(symbol, stock.longShares, "Long");
    }
  }
  return value;
}

function logStatus(ns, market) {
  const total = state.stats.wins + state.stats.losses;
  const winRate = total > 0 ? ((state.stats.wins / total) * 100).toFixed(1) : "N/A";
  
  // Count positions and signals
  let positions = 0;
  let buySignals = 0;
  let sellSignals = 0;
  
  for (const [, stock] of market) {
    if (stock.longShares > 0) positions++;
    if (stock.signal === "buy") buySignals++;
    if (stock.signal === "sell") sellSignals++;
  }

  ns.print(`━━━ STATUS ━━━`);
  ns.print(`Trades: ${state.stats.wins}W/${state.stats.losses}L (${winRate}%) | P/L: ${ns.nFormat(state.stats.totalPL, "$0.00a")}`);
  ns.print(`Positions: ${positions} | Signals: ${buySignals} buy, ${sellSignals} sell`);
  ns.print(`━━━━━━━━━━━━━━`);
}

function average(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}