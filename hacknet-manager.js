/** @param {NS} ns */

/**
 * hacknet-manager.js - Hacknet purchasing, upgrading, and hash spending
 * 
 * Features:
 * - Intelligent hash spending based on game state
 * - Smart upgrade purchasing (best hash/$ ratio)
 * - BN9 nexus designation and management
 * - Early game vs late game strategy switching
 */

import {
  getNexusHost,
  getNexusTargetRam,
  getNexusInfo,
  copyScriptsToNexus,
  hasHacknetServers,
} from "utils/server-utils.js";

import {
  isInBitNode,
  getMultiplier,
  isCacheValid,
} from "utils/bitnode-cache.js";

// Configuration
const CONFIG = {
  CYCLE_DELAY_MS: 2000,           // 2 seconds between cycles
  HASH_RESERVE: 4,                // Minimum hashes to keep in reserve
  MONEY_SELL_THRESHOLD: 0.5,      // Sell hashes if online income < 50% of hash income potential
  NEXUS_SCRIPT: "nexus.js",
  
  // Hash costs (as of current game version)
  HASH_COSTS: {
    SELL_FOR_MONEY: 4,            // $1m per 4 hashes
    INCREASE_MAX_MONEY: 50,       // 2% increase to server max money
    REDUCE_MIN_SECURITY: 50,      // 2% reduction to server min security
    IMPROVE_STUDYING: 50,         // 20% improvement to studying
    IMPROVE_GYM: 50,              // 20% improvement to gym
    COMPANY_FAVOR: 250,           // +5 favor with company
    GENERATE_CODING_CONTRACT: 200,
    // Corporation and Bladeburner stubs
    CORP_FUNDS: 150,
    CORP_RESEARCH: 100,
    BLADEBURNER_RANK: 250,
    BLADEBURNER_SP: 250,
  },
  
  // Upgrade types for hacknet servers
  UPGRADE_TYPES: ['level', 'ram', 'cores', 'cache'],
};

// State tracking
let nexusDesignated = null;
let nexusScriptsLaunched = false;
let lastHashSpend = 0;

/**
 * Get the best server to target for max money/min security upgrades
 * Prioritizes fastest hack time servers, with n00dles being ideal
 * @param {NS} ns
 * @returns {string}
 */
function getBestTargetServer(ns) {
  // n00dles is always the best for max money upgrades
  // (soft cap of 10t means all servers cap at same amount)
  if (ns.serverExists("n00dles") && ns.hasRootAccess("n00dles")) {
    return "n00dles";
  }
  
  // Fallback: find server with lowest required hacking level
  const visited = new Set();
  const queue = ["home"];
  let best = null;
  let bestLevel = Infinity;
  
  while (queue.length > 0) {
    const server = queue.shift();
    if (visited.has(server)) continue;
    visited.add(server);
    
    if (server !== "home" && ns.hasRootAccess(server) && ns.getServerMaxMoney(server) > 0) {
      const level = ns.getServerRequiredHackingLevel(server);
      if (level < bestLevel) {
        bestLevel = level;
        best = server;
      }
    }
    
    for (const neighbor of ns.scan(server)) {
      if (!visited.has(neighbor)) queue.push(neighbor);
    }
  }
  
  return best || "n00dles";
}

/**
 * Get current online hacking income rate ($/sec)
 * @param {NS} ns
 * @returns {number}
 */
function getOnlineIncomeRate(ns) {
  // This is an approximation - could be enhanced by reading from orchestrator
  const moneyMult = ns.getPlayer().mults.hacking_money;
  const scriptIncome = ns.getTotalScriptIncome()[0]; // $/sec from scripts
  return scriptIncome;
}

/**
 * Get theoretical money rate from selling all hashes
 * @param {NS} ns
 * @returns {number} $/sec if all hash production was converted to money
 */
function getHashMoneyRate(ns) {
  if (!hasHacknetServers(ns)) return 0;
  
  const production = ns.hacknet.hashCapacity() > 0 
    ? ns.formulas.hacknetServers.hashGainRate(
        ns.hacknet.getNodeStats(0).level,
        0, // ramUsed
        ns.hacknet.getNodeStats(0).ram,
        ns.hacknet.getNodeStats(0).cores,
        ns.getPlayer().mults.hacknet_node_money
      )
    : 0;
  
  // Total hash production across all servers
  let totalProduction = 0;
  for (let i = 0; i < ns.hacknet.numNodes(); i++) {
    const stats = ns.hacknet.getNodeStats(i);
    totalProduction += stats.production;
  }
  
  // $1m per 4 hashes
  return (totalProduction / CONFIG.HASH_COSTS.SELL_FOR_MONEY) * 1e6;
}

/**
 * Check if we should sell hashes for money (early game strategy)
 * @param {NS} ns
 * @returns {boolean}
 */
function shouldSellHashesForMoney(ns) {
  const onlineIncome = getOnlineIncomeRate(ns);
  const hashMoneyRate = getHashMoneyRate(ns);
  
  // If online income is less than half of what we could make selling hashes
  return onlineIncome < hashMoneyRate * CONFIG.MONEY_SELL_THRESHOLD;
}

/**
 * Get available hash spending actions based on game state
 * @param {NS} ns
 * @returns {Array<{action: string, priority: number, cost: number, available: boolean}>}
 */
function getHashActions(ns) {
  const actions = [];
  const hashes = ns.hacknet.numHashes();
  const capacity = ns.hacknet.hashCapacity();
  
  // Sell for money - only if we're not making money from hacking
  if (shouldSellHashesForMoney(ns)) {
    actions.push({
      action: "Sell for Money",
      priority: 100,  // High priority early game
      cost: CONFIG.HASH_COSTS.SELL_FOR_MONEY,
      available: hashes >= CONFIG.HASH_COSTS.SELL_FOR_MONEY,
      execute: () => ns.hacknet.spendHashes("Sell for Money"),
    });
  }
  
  // Improve studying - critical in BN9 where hacking XP is gimped (5%)
  // Use cached bitnode check (0 GB) instead of expensive getBitNodeMultipliers() (4 GB)
  if (isInBitNode(ns, 9)) {
    actions.push({
      action: "Improve Studying",
      priority: 90,
      cost: CONFIG.HASH_COSTS.IMPROVE_STUDYING,
      available: hashes >= CONFIG.HASH_COSTS.IMPROVE_STUDYING,
      execute: () => ns.hacknet.spendHashes("Improve Studying"),
    });
  }
  
  // Improve gym - lower priority than studying
  actions.push({
    action: "Improve Gym Training",
    priority: 30,
    cost: CONFIG.HASH_COSTS.IMPROVE_GYM,
    available: hashes >= CONFIG.HASH_COSTS.IMPROVE_GYM,
    execute: () => ns.hacknet.spendHashes("Improve Gym Training"),
  });
  
  // Increase max money - good late game when hash capacity is high
  const targetServer = getBestTargetServer(ns);
  actions.push({
    action: "Increase Maximum Money",
    priority: 50,
    cost: CONFIG.HASH_COSTS.INCREASE_MAX_MONEY,
    available: hashes >= CONFIG.HASH_COSTS.INCREASE_MAX_MONEY,
    execute: () => ns.hacknet.spendHashes("Increase Maximum Money", targetServer),
  });
  
  // Reduce min security - always include, harmless if not needed
  actions.push({
    action: "Reduce Minimum Security",
    priority: 40,
    cost: CONFIG.HASH_COSTS.REDUCE_MIN_SECURITY,
    available: hashes >= CONFIG.HASH_COSTS.REDUCE_MIN_SECURITY,
    execute: () => ns.hacknet.spendHashes("Reduce Minimum Security", targetServer),
  });
  
  // Company favor - great for mid/late game
  // TODO: Connect to priorityJobs to find best company
  actions.push({
    action: "Exchange for Corporation Research",
    priority: 20,  // Stub priority
    cost: CONFIG.HASH_COSTS.CORP_RESEARCH,
    available: false,  // Stub - requires corporation
    execute: () => { /* Stub */ },
  });
  
  // Generate coding contract - low priority filler
  actions.push({
    action: "Generate Coding Contract",
    priority: 10,
    cost: CONFIG.HASH_COSTS.GENERATE_CODING_CONTRACT,
    available: hashes >= CONFIG.HASH_COSTS.GENERATE_CODING_CONTRACT,
    execute: () => ns.hacknet.spendHashes("Generate Coding Contract"),
  });
  
  return actions.filter(a => a.available).sort((a, b) => b.priority - a.priority);
}

/**
 * Spend hashes on the best available action
 * @param {NS} ns
 * @returns {boolean} Whether any hashes were spent
 */
function spendHashes(ns) {
  const hashes = ns.hacknet.numHashes();
  const capacity = ns.hacknet.hashCapacity();
  
  // Don't spend if we're below reserve and not near capacity
  if (hashes < CONFIG.HASH_RESERVE && hashes < capacity * 0.9) {
    return false;
  }
  
  const actions = getHashActions(ns);
  
  if (actions.length === 0) {
    // No actions available, sell for money as fallback if near capacity
    if (hashes >= capacity * 0.9 && hashes >= CONFIG.HASH_COSTS.SELL_FOR_MONEY) {
      ns.hacknet.spendHashes("Sell for Money");
      return true;
    }
    return false;
  }
  
  // Execute highest priority available action
  const action = actions[0];
  const success = action.execute();
  
  if (success) {
    ns.print(`[HASH] Spent ${action.cost} hashes on: ${action.action}`);
    lastHashSpend = Date.now();
    return true;
  }
  
  return false;
}

/**
 * Get the best hacknet upgrade to purchase
 * Returns the upgrade with the best hash production per cost ratio
 * @param {NS} ns
 * @returns {{nodeIndex: number, upgradeType: string, cost: number, hashGain: number} | null}
 */
function getBestUpgrade(ns) {
  const money = ns.getServerMoneyAvailable("home");
  const numNodes = ns.hacknet.numNodes();
  
  let best = null;
  let bestRatio = 0;
  
  // Check buying a new node
  const newNodeCost = ns.hacknet.getPurchaseNodeCost();
  if (newNodeCost <= money && numNodes < ns.hacknet.maxNumNodes()) {
    // Estimate hash production of a new level 1 node
    const baseProduction = 0.001;  // Approximate base production
    const ratio = baseProduction / newNodeCost;
    
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = {
        nodeIndex: -1,  // -1 means buy new
        upgradeType: 'new',
        cost: newNodeCost,
        hashGain: baseProduction
      };
    }
  }
  
  // Check upgrades for each existing node
  for (let i = 0; i < numNodes; i++) {
    const stats = ns.hacknet.getNodeStats(i);
    const currentProduction = stats.production;
    
    for (const type of CONFIG.UPGRADE_TYPES) {
      let cost, newProduction;
      
      switch (type) {
        case 'level':
          cost = ns.hacknet.getLevelUpgradeCost(i, 1);
          // Rough estimate: each level adds ~1% production
          newProduction = currentProduction * 1.01;
          break;
        case 'ram':
          cost = ns.hacknet.getRamUpgradeCost(i, 1);
          // RAM has diminishing returns
          newProduction = currentProduction * 1.02;
          break;
        case 'cores':
          cost = ns.hacknet.getCoreUpgradeCost(i, 1);
          // Cores have good scaling
          newProduction = currentProduction * 1.05;
          break;
        case 'cache':
          cost = ns.hacknet.getCacheUpgradeCost(i, 1);
          // Cache doesn't affect production, skip for ratio calc
          continue;
        default:
          continue;
      }
      
      if (cost > money || cost === Infinity) continue;
      
      const hashGain = newProduction - currentProduction;
      const ratio = hashGain / cost;
      
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = {
          nodeIndex: i,
          upgradeType: type,
          cost,
          hashGain
        };
      }
    }
  }
  
  return best;
}

/**
 * Get the best upgrade for the designated nexus server (BN9 priority)
 * @param {NS} ns
 * @param {number} nodeIndex
 * @returns {{upgradeType: string, cost: number} | null}
 */
function getBestNexusUpgrade(ns, nodeIndex) {
  const money = ns.getServerMoneyAvailable("home");
  const stats = ns.hacknet.getNodeStats(nodeIndex);
  const targetRam = getNexusTargetRam(ns);
  
  // Only upgrade RAM until we hit target
  if (stats.ram < targetRam) {
    const cost = ns.hacknet.getRamUpgradeCost(nodeIndex, 1);
    if (cost <= money && cost < Infinity) {
      return { upgradeType: 'ram', cost };
    }
  }
  
  return null;
}

/**
 * Find the best hacknet server to designate as nexus
 * In BN9, we need to balance getting a nexus quickly vs not wasting a good hash producer
 * @param {NS} ns
 * @returns {number} Node index to designate as nexus, or -1 to buy new
 */
function findBestNexusCandidate(ns) {
  const numNodes = ns.hacknet.numNodes();
  
  if (numNodes === 0) {
    return -1;  // Need to buy first node
  }
  
  // Strategy: Find the node with lowest "investment" (lowest production value)
  // This is the one we've spent least on for hash production
  let bestIndex = 0;
  let lowestProduction = Infinity;
  
  for (let i = 0; i < numNodes; i++) {
    const stats = ns.hacknet.getNodeStats(i);
    const productionValue = stats.production * (stats.level + stats.cores);
    
    if (productionValue < lowestProduction) {
      lowestProduction = productionValue;
      bestIndex = i;
    }
  }
  
  return bestIndex;
}

/**
 * Execute an upgrade purchase
 * @param {NS} ns
 * @param {{nodeIndex: number, upgradeType: string, cost: number}} upgrade
 * @returns {boolean}
 */
function executeUpgrade(ns, upgrade) {
  if (upgrade.nodeIndex === -1) {
    const index = ns.hacknet.purchaseNode();
    if (index !== -1) {
      ns.print(`[HACKNET] Purchased new node: hacknet-server-${index}`);
      return true;
    }
    return false;
  }
  
  let success = false;
  switch (upgrade.upgradeType) {
    case 'level':
      success = ns.hacknet.upgradeLevel(upgrade.nodeIndex, 1);
      break;
    case 'ram':
      success = ns.hacknet.upgradeRam(upgrade.nodeIndex, 1);
      break;
    case 'cores':
      success = ns.hacknet.upgradeCore(upgrade.nodeIndex, 1);
      break;
    case 'cache':
      success = ns.hacknet.upgradeCache(upgrade.nodeIndex, 1);
      break;
  }
  
  if (success) {
    ns.print(`[HACKNET] Upgraded node ${upgrade.nodeIndex} ${upgrade.upgradeType}`);
  }
  
  return success;
}

/**
 * Handle nexus setup in BN9
 * @param {NS} ns
 */
async function handleBN9Nexus(ns) {
  if (!isInBitNode(ns, 9)) return;
  
  const numNodes = ns.hacknet.numNodes();
  
  // Need at least one node first
  if (numNodes === 0) {
    const cost = ns.hacknet.getPurchaseNodeCost();
    const money = ns.getServerMoneyAvailable("home");
    
    if (cost <= money) {
      ns.hacknet.purchaseNode();
      ns.print("[HACKNET] Purchased first hacknet server");
    }
    return;
  }
  
  // Designate nexus if not done
  if (!nexusDesignated) {
    const nexusIndex = findBestNexusCandidate(ns);
    if (nexusIndex >= 0) {
      nexusDesignated = `hacknet-server-${nexusIndex}`;
      ns.print(`[HACKNET] Designated ${nexusDesignated} as nexus`);
    }
    return;
  }
  
  // Get nexus node index
  const nexusIndex = parseInt(nexusDesignated.split('-').pop());
  const nexusStats = ns.hacknet.getNodeStats(nexusIndex);
  const targetRam = getNexusTargetRam(ns);
  
  // Check if nexus is ready
  if (nexusStats.ram >= targetRam && !nexusScriptsLaunched) {
    ns.print(`[HACKNET] Nexus ${nexusDesignated} is ready!`);
    
    // Copy scripts and launch
    copyScriptsToNexus(ns, nexusDesignated);
    await ns.sleep(500);
    
    if (ns.fileExists(CONFIG.NEXUS_SCRIPT, nexusDesignated)) {
      ns.exec(CONFIG.NEXUS_SCRIPT, nexusDesignated, 1);
      ns.print(`[HACKNET] Launched ${CONFIG.NEXUS_SCRIPT}`);
    }
    
    nexusScriptsLaunched = true;
    return;
  }
  
  // Prioritize upgrading nexus RAM
  if (nexusStats.ram < targetRam) {
    const upgrade = getBestNexusUpgrade(ns, nexusIndex);
    if (upgrade) {
      executeUpgrade(ns, { nodeIndex: nexusIndex, ...upgrade });
      return;
    }
  }
}

/**
 * Print status
 * @param {NS} ns
 */
function printStatus(ns) {
  ns.clearLog();
  
  const numNodes = ns.hacknet.numNodes();
  const hashes = ns.hacknet.numHashes();
  const capacity = ns.hacknet.hashCapacity();
  const money = ns.getServerMoneyAvailable("home");
  
  ns.print("═══════════════════════════════════════════");
  ns.print("          HACKNET MANAGER                  ");
  ns.print("═══════════════════════════════════════════");
  ns.print("");
  
  ns.print(`💰 Money: $${ns.formatNumber(money)}`);
  ns.print(`🖥️  Nodes: ${numNodes}`);
  ns.print(`#️⃣  Hashes: ${ns.formatNumber(hashes)}/${ns.formatNumber(capacity)}`);
  
  // Hash production
  let totalProduction = 0;
  for (let i = 0; i < numNodes; i++) {
    totalProduction += ns.hacknet.getNodeStats(i).production;
  }
  ns.print(`📈 Production: ${ns.formatNumber(totalProduction)}/sec`);
  
  // Income comparison
  const onlineIncome = getOnlineIncomeRate(ns);
  const hashMoneyRate = getHashMoneyRate(ns);
  ns.print(`💵 Online Income: $${ns.formatNumber(onlineIncome)}/sec`);
  ns.print(`💵 Hash→Money: $${ns.formatNumber(hashMoneyRate)}/sec`);
  
  if (shouldSellHashesForMoney(ns)) {
    ns.print("   → Selling hashes for money (early game)");
  }
  ns.print("");
  
  // BN9 nexus status
  if (isInBitNode(ns, 9)) {
    ns.print("─── BN9 NEXUS STATUS ───");
    if (nexusDesignated) {
      const nexusIndex = parseInt(nexusDesignated.split('-').pop());
      const stats = ns.hacknet.getNodeStats(nexusIndex);
      const targetRam = getNexusTargetRam(ns);
      const ready = stats.ram >= targetRam;
      
      ns.print(`  Server: ${nexusDesignated}`);
      ns.print(`  RAM: ${stats.ram}GB / ${targetRam}GB ${ready ? '✅' : '⏳'}`);
      ns.print(`  Scripts: ${nexusScriptsLaunched ? '✅ Running' : '⏳ Pending'}`);
    } else {
      ns.print("  Awaiting designation...");
    }
    ns.print("");
  }
  
  // Next actions
  ns.print("─── NEXT ACTIONS ───");
  
  // Hash spending
  const hashActions = getHashActions(ns);
  if (hashActions.length > 0) {
    ns.print(`  Hash: ${hashActions[0].action} (${hashActions[0].cost}h)`);
  } else {
    ns.print("  Hash: Accumulating...");
  }
  
  // Upgrade purchasing
  const bestUpgrade = getBestUpgrade(ns);
  if (bestUpgrade) {
    if (bestUpgrade.nodeIndex === -1) {
      ns.print(`  Buy: New node ($${ns.formatNumber(bestUpgrade.cost)})`);
    } else {
      ns.print(`  Upgrade: Node ${bestUpgrade.nodeIndex} ${bestUpgrade.upgradeType} ($${ns.formatNumber(bestUpgrade.cost)})`);
    }
  } else {
    ns.print("  Upgrade: Waiting for funds...");
  }
  
  ns.print("");
  ns.print(`Last update: ${new Date().toLocaleTimeString()}`);
}

/**
 * Main entry point
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();
  
  ns.print("Starting Hacknet Manager...");
  ns.print(`BitNode: ${ns.getResetInfo().currentNode}`);
  ns.print(`Has hacknet servers: ${hasHacknetServers(ns)}`);
  ns.print("");
  
  if (!hasHacknetServers(ns)) {
    ns.print("Hacknet servers not available in this BitNode");
    ns.print("This script is designed for BN9 or when SF9 is owned");
    ns.print("Exiting...");
    return;
  }
  
  while (true) {
    // Handle BN9 nexus management
    await handleBN9Nexus(ns);
    
    // Spend hashes (multiple times if near capacity)
    let hashesSpent = 0;
    while (spendHashes(ns)) {
      hashesSpent++;
      if (hashesSpent >= 10) break;  // Safety limit
    }
    
    // Purchase upgrades
    const upgrade = getBestUpgrade(ns);
    if (upgrade) {
      executeUpgrade(ns, upgrade);
    }
    
    // Print status
    printStatus(ns);
    
    await ns.sleep(CONFIG.CYCLE_DELAY_MS);
  }
}