/** @param {NS} ns */

const MIN_RAM = 2;        // Minimum RAM for new servers (2GB)
const CYCLE_DELAY = 5000; // 5 seconds between cycles

/**
 * Get the next RAM tier (double current)
 * @param {number} currentRam
 * @returns {number}
 */
function getNextRamTier(currentRam) {
  return currentRam * 2;
}

/**
 * Find the best action to take with available money
 * Returns either a purchase action, upgrade action, or null if nothing affordable
 * @param {NS} ns
 * @returns {{type: "buy"|"upgrade", cost: number, ram: number, server?: string} | null}
 */
function findBestAction(ns) {
  const money = ns.getServerMoneyAvailable("home");
  const servers = ns.getPurchasedServers();
  const maxServers = ns.getPurchasedServerLimit();
  const maxRam = ns.getPurchasedServerMaxRam();
  
  let bestAction = null;
  let bestCostPerRam = Infinity;
  
  // Option 1: Buy a new server (if we haven't hit the limit)
  if (servers.length < maxServers) {
    const buyCost = ns.getPurchasedServerCost(MIN_RAM);
    if (buyCost <= money) {
      const costPerRam = buyCost / MIN_RAM;
      if (costPerRam < bestCostPerRam) {
        bestCostPerRam = costPerRam;
        bestAction = {
          type: "buy",
          cost: buyCost,
          ram: MIN_RAM
        };
      }
    }
  }
  
  // Option 2: Upgrade an existing server
  for (const server of servers) {
    const currentRam = ns.getServerMaxRam(server);
    const nextRam = getNextRamTier(currentRam);
    
    // Skip if already at max
    if (nextRam > maxRam) continue;
    
    const upgradeCost = ns.getPurchasedServerUpgradeCost(server, nextRam);
    if (upgradeCost <= money && upgradeCost > 0) {
      const ramGain = nextRam - currentRam;
      const costPerRam = upgradeCost / ramGain;
      
      if (costPerRam < bestCostPerRam) {
        bestCostPerRam = costPerRam;
        bestAction = {
          type: "upgrade",
          cost: upgradeCost,
          ram: nextRam,
          server: server,
          currentRam: currentRam
        };
      }
    }
  }
  
  return bestAction;
}

/**
 * Calculate total RAM across all purchased servers
 * @param {NS} ns
 * @returns {number}
 */
function getTotalPurchasedRam(ns) {
  const servers = ns.getPurchasedServers();
  let total = 0;
  for (const server of servers) {
    total += ns.getServerMaxRam(server);
  }
  return total;
}

/**
 * Calculate how much money is required to finish upgrading owned servers
 * and acquire remaining slots at max RAM
 * @param {NS} ns
 * @returns {{existing: number, missing: number, total: number}}
 */
function getRemainingUpgradeCost(ns) {
  const servers = ns.getPurchasedServers();
  const maxServers = ns.getPurchasedServerLimit();
  const maxRam = ns.getPurchasedServerMaxRam();
  let existingCost = 0;

  for (const server of servers) {
    let currentRam = ns.getServerMaxRam(server);
    while (currentRam < maxRam) {
      const nextRam = Math.min(maxRam, getNextRamTier(currentRam));
      const upgradeCost = ns.getPurchasedServerUpgradeCost(server, nextRam);
      if (!isFinite(upgradeCost) || upgradeCost <= 0) {
        break;
      }
      existingCost += upgradeCost;
      currentRam = nextRam;
    }
  }

  const remainingSlots = Math.max(0, maxServers - servers.length);
  const costPerMaxServer = ns.getPurchasedServerCost(maxRam);
  const missingCost = remainingSlots * costPerMaxServer;

  return {
    existing: existingCost,
    missing: missingCost,
    total: existingCost + missingCost
  };
}

/**
 * Print current status
 * @param {NS} ns
 */
function printStatus(ns) {
  ns.clearLog();
  
  const servers = ns.getPurchasedServers();
  const maxServers = ns.getPurchasedServerLimit();
  const money = ns.getServerMoneyAvailable("home");
  const totalRam = getTotalPurchasedRam(ns);
  const maxRam = ns.getPurchasedServerMaxRam();
  const remainingCost = getRemainingUpgradeCost(ns);
  
  ns.print("═══════════════════════════════════════════");
  ns.print("            SERVER UPGRADER                ");
  ns.print("═══════════════════════════════════════════");
  ns.print("");
  ns.print(`💰 Available: $${ns.formatNumber(money)}`);
  ns.print(`🖥️  Servers: ${servers.length}/${maxServers}`);
  ns.print(`📊 Total RAM: ${ns.formatNumber(totalRam)} GB`);
  ns.print(`💸 Needed (owned → max): $${ns.formatNumber(remainingCost.existing)}`);
  if (remainingCost.missing > 0) {
    ns.print(`💸 Needed (missing max-tier servers): $${ns.formatNumber(remainingCost.missing)}`);
  }
  ns.print(`💵 Total to finish: $${ns.formatNumber(remainingCost.total)}`);
  ns.print("");
  
  // Show each server's RAM
  ns.print("─── SERVER RAM ───");
  if (servers.length === 0) {
    ns.print("  (no servers purchased)");
  } else {
    // Group servers by RAM tier for cleaner display
    const ramTiers = new Map();
    for (const server of servers) {
      const ram = ns.getServerMaxRam(server);
      ramTiers.set(ram, (ramTiers.get(ram) || 0) + 1);
    }
    
    // Sort by RAM descending
    const sortedTiers = [...ramTiers.entries()].sort((a, b) => b[0] - a[0]);
    for (const [ram, count] of sortedTiers) {
      const maxedOut = ram >= maxRam ? " (MAX)" : "";
      ns.print(`  ${ns.formatNumber(ram)} GB: ${count} server${count > 1 ? 's' : ''}${maxedOut}`);
    }
  }
  
  // Show next affordable action
  ns.print("");
  ns.print("─── NEXT ACTION ───");
  const nextAction = findBestAction(ns);
  if (nextAction) {
    if (nextAction.type === "buy") {
      ns.print(`  BUY new server (${nextAction.ram} GB) for $${ns.formatNumber(nextAction.cost)}`);
    } else {
      ns.print(`  UPGRADE ${nextAction.server}: ${ns.formatNumber(nextAction.currentRam)}→${ns.formatNumber(nextAction.ram)} GB`);
      ns.print(`  Cost: $${ns.formatNumber(nextAction.cost)}`);
    }
  } else if (servers.length >= maxServers) {
    // Check if all maxed
    let allMaxed = true;
    for (const server of servers) {
      if (ns.getServerMaxRam(server) < maxRam) {
        allMaxed = false;
        break;
      }
    }
    if (allMaxed) {
      ns.print("  ✅ All servers at maximum RAM!");
    } else {
      ns.print("  ⏳ Waiting for funds...");
    }
  } else {
    ns.print("  ⏳ Waiting for funds...");
  }
  
  ns.print("");
  ns.print(`Last update: ${new Date().toLocaleTimeString()}`);
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();
  
  ns.print("Starting Server Upgrader...");
  
  let serverIndex = ns.getPurchasedServers().length;
  
  while (true) {
    // Find and execute the best action
    const action = findBestAction(ns);
    
    if (action) {
      if (action.type === "buy") {
        const hostname = ns.purchaseServer(`pserv-${serverIndex}`, action.ram);
        if (hostname) {
          ns.print(`[+] Purchased ${hostname} with ${action.ram} GB RAM`);
          serverIndex++;
        }
      } else if (action.type === "upgrade") {
        const success = ns.upgradePurchasedServer(action.server, action.ram);
        if (success) {
          ns.print(`[+] Upgraded ${action.server} to ${ns.formatNumber(action.ram)} GB RAM`);
        }
      }
    }
    
    // Print status
    printStatus(ns);
    
    // Check if we're done (all servers at max RAM)
    const servers = ns.getPurchasedServers();
    const maxServers = ns.getPurchasedServerLimit();
    const maxRam = ns.getPurchasedServerMaxRam();
    
    if (servers.length >= maxServers) {
      let allMaxed = true;
      for (const server of servers) {
        if (ns.getServerMaxRam(server) < maxRam) {
          allMaxed = false;
          break;
        }
      }
      if (allMaxed) {
        ns.print("");
        ns.print("🎉 All servers purchased and maxed out!");
        ns.print("Script complete.");
        return;
      }
    }
    
    await ns.sleep(CYCLE_DELAY);
  }
}