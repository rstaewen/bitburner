/** @param {NS} ns */
export async function main(ns) {
  const traderScript = "stock-trader.js";
  ns.disableLog("sleep");

  if (!ns.stock || !ns.stock.hasTIXAPIAccess()) {
    ns.tprint("ERROR: sellAll.js requires TIX API access.");
    return;
  }

  stopTrader(ns, traderScript);
  liquidateAll(ns);
}

function stopTrader(ns, traderScript) {
  const hosts = new Set(["home", ...ns.getPurchasedServers()]);
  let killedAny = false;

  for (const host of hosts) {
    for (const proc of ns.ps(host)) {
      if (proc.filename === traderScript) {
        ns.kill(proc.pid);
        killedAny = true;
        ns.print(`Killed ${traderScript} on ${host} (pid ${proc.pid}).`);
      }
    }
  }

  if (!killedAny) {
    ns.print(`${traderScript} not running.`);
  }
}

function liquidateAll(ns) {
  const symbols = ns.stock.getSymbols();
  let totalLong = 0;
  let totalShort = 0;

  for (const symbol of symbols) {
    const [longShares, , shortShares] = ns.stock.getPosition(symbol);

    if (longShares > 0) {
      const proceeds = ns.stock.sellStock(symbol, longShares);
      if (proceeds > 0) {
        ns.print(`Sold ${longShares} ${symbol} for $${ns.formatNumber(proceeds)}.`);
        totalLong += proceeds;
      }
    }

    if (shortShares > 0) {
      const cost = ns.stock.sellShort(symbol, shortShares);
      if (cost > 0) {
        ns.print(`Covered ${shortShares} ${symbol} for $${ns.formatNumber(cost)}.`);
        totalShort += cost;
      }
    }
  }

  ns.tprint(
    `Liquidation complete. Long proceeds $${ns.formatNumber(totalLong)}, short cover cost $${ns.formatNumber(totalShort)}.`
  );
}
