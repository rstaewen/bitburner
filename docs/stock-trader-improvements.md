# Stock Trader (Non-4S) Improvement Ideas

## Current Problems

### 1. Backtest vs Reality Gap
```
MOMENTUM:   56.6% accuracy in backtest
ACTUAL:     46.7% win rate
```
The backtest measures "did price go up after 5 cycles?" but actual trades:
- Pay the bid/ask spread (~2-3%) on entry
- Hold for variable durations (not 5 cycles)
- Exit based on noisy signals that may not align with the backtest horizon

### 2. Signal Quality Issues
The current momentum calculation:
```javascript
const trendPercent = slope / avgPrice;
const momentumRaw = 0.5 + (trendPercent * 50);
```
This is overly sensitive to recent noise. A stock that bounced 1% creates strong signals that don't persist.

### 3. Exit Strategy Problems
- **Signal exits** (9): Based on the same noisy forecast → often exit right before recovery
- **Take profit** (3): 20% is rarely hit without 4S edge
- **Stop loss** (0): 15% is too wide for our holding period
- **Neutral exits** (3): Exit at 2% profit is reasonable but rare

### 4. The Fundamental Challenge
Without 4S data, we're essentially blind to the true market mechanics. Bitburner stocks have:
- A hidden "probability of increase" that 4S reveals
- Random walks within that probability
- Periodic inversions (the probability flips)

We can only observe price history, which is extremely noisy.

---

## Improvement Strategies

### Strategy A: Passive Index Approach (Simplest)
**Idea**: Don't try to predict. Just buy and hold everything.

```javascript
// Buy equal portions of all stocks
// Never sell (or sell only when we need cash)
// Rely on the market's slight long-term positive drift
```

**Pros**:
- Zero prediction errors
- Minimal commission waste
- Works if market has any positive expected value

**Cons**:
- Slow returns
- Ties up all capital
- Doesn't exploit any edge

### Strategy B: Volatility Harvesting
**Idea**: Instead of predicting direction, exploit price oscillation.

```javascript
// For each stock:
// 1. Track its typical price range (e.g., 20-cycle min/max)
// 2. Buy when price is near the bottom of its range
// 3. Sell when price is near the top of its range
// 4. Don't care about direction prediction
```

**Implementation sketch**:
```javascript
const priceRange = {
  min: Math.min(...history),
  max: Math.max(...history),
  current: currentPrice
};
const position = (current - min) / (max - min); // 0 = bottom, 1 = top

if (position < 0.25 && !holding) buy();
if (position > 0.75 && holding) sell();
```

**Pros**:
- Doesn't require directional prediction
- Exploits natural price oscillation
- Clear entry/exit rules

**Cons**:
- Fails during strong trends (buys falling knives)
- Range can shift

### Strategy C: Momentum with Confirmation
**Idea**: Only trade when multiple signals align.

```javascript
// Require ALL of:
// 1. Short-term trend (5 cycles) is positive
// 2. Medium-term trend (15 cycles) is positive  
// 3. Current price > moving average
// 4. Recent volatility is moderate (not spiking)

// Exit when ANY fails
```

**Pros**:
- Fewer false signals
- More confident entries

**Cons**:
- Fewer trades overall
- May miss opportunities

### Strategy D: Adaptive Kelly Criterion
**Idea**: Size positions based on our confidence, not all-in every time.

```javascript
// Track our actual win rate and average win/loss size
// Use Kelly formula to size positions:
// f* = (bp - q) / b
// where b = odds, p = win prob, q = loss prob

// Start with tiny positions, scale up as we prove edge
```

**Pros**:
- Limits damage from bad predictions
- Compounds gains efficiently if we have edge

**Cons**:
- Requires edge to exist

### Strategy E: Pattern Recognition (Advanced)
**Idea**: Look for specific patterns that historically precede moves.

```javascript
// Examples:
// - "V-bottom": sharp drop followed by recovery start
// - "Breakout": price exceeds recent range
// - "Consolidation break": low volatility period ending

// Catalog patterns and track their success rates
// Only trade patterns that prove profitable
```

### Strategy F: Simple Moving Average Crossover
**Idea**: Classic technical analysis approach.

```javascript
const shortMA = average(history.slice(-5));
const longMA = average(history.slice(-15));

// Buy signal: shortMA crosses above longMA
// Sell signal: shortMA crosses below longMA
```

**Pros**:
- Well-understood strategy
- Filters out noise better than raw slope
- Clear signals

**Cons**:
- Lags behind price moves
- Whipsaws in ranging markets

---

## Recommended Approach: Hybrid Strategy

Combine the best elements:

### Entry Rules
1. **Primary signal**: Short MA > Long MA (trend following)
2. **Confirmation**: Price in lower half of recent range (value entry)
3. **Filter**: Volatility not spiking (avoid chaos)

### Exit Rules
1. **Profit target**: 5-8% (achievable without 4S edge)
2. **Stop loss**: 8-10% (tighter than current)
3. **Signal exit**: Short MA < Long MA
4. **Time stop**: Exit after N cycles if no progress (prevent capital lock-up)

### Position Sizing
1. Never put more than 20% of capital in one stock
2. Scale position size by signal strength
3. Keep 20% cash reserve for opportunities

### Additional Mechanics
1. **Cooldown**: After a loss, wait before re-entering that stock
2. **Diversification**: Hold 3-5 positions minimum when possible
3. **Rebalancing**: Periodically trim winners, add to laggards

---

## Implementation Priority

1. **Phase 1**: Simplify to MA crossover strategy
   - Remove momentum/contrarian complexity
   - Implement clean entry/exit rules
   - Track performance

2. **Phase 2**: Add volatility filtering
   - Don't trade during high-volatility periods
   - Implement range-based value entries

3. **Phase 3**: Position sizing
   - Kelly-based sizing
   - Portfolio diversification rules

4. **Phase 4**: Pattern recognition (if warranted)
   - Only if Phase 1-3 show promise

---

## Code Structure Suggestion

```javascript
// Simplified architecture
const CONFIG = {
  shortMA: 5,
  longMA: 15,
  profitTarget: 0.06,
  stopLoss: 0.08,
  maxPositionPct: 0.20,
  minHistoryLength: 20,
  volatilityThreshold: 0.03
};

// Core functions:
// - calculateIndicators(history) → { shortMA, longMA, volatility, rangePosition }
// - generateSignal(indicators) → "buy" | "sell" | "hold"
// - shouldEnter(stock, indicators, portfolio) → boolean
// - shouldExit(position, indicators) → { exit: boolean, reason: string }
// - calculatePositionSize(signal, available, portfolio) → shares
```

---

## Key Metrics to Track

1. **Win rate** by signal type
2. **Average win** vs **average loss** (risk/reward ratio)
3. **Max drawdown**
4. **Sharpe ratio** (if we track over time)
5. **Commission as % of profits**

---

## Questions to Resolve

1. What's the actual bid/ask spread in Bitburner? (Affects minimum profit target)
2. How often do stocks invert their hidden probability? (Affects hold duration)
3. Is there any seasonality or pattern to inversions?
4. Does volatility predict anything useful?
