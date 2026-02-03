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
  setNexusHost,
  getNexusTargetRam,
  getNexusInfo,
  copyScriptsToNexus,
  hasHacknetServers,
  getBestHacknetBoostTarget,
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
  
  // BN9 studying optimization
  STUDYING_HASH_RATE_THRESHOLD: 1.0,  // Start prioritizing studying at 1 hash/sec production
  STUDYING_MAX_MULTIPLIER: 4,        // Cap studying boosts at 4x (diminishing returns)
  STUDYING_BOOST_PER_USE: 0.20,       // Each "Improve Studying" adds 20% (additive)
  
  // Upgrade stopping threshold
  MAX_PAYBACK_TIME_SEC: 4 * 3600,     // Stop upgrades if payback time > 4 hours
  
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
let nexusScriptsLaunched = false;
let lastHashSpend = 0;
let studyingBoostsPurchased = 0;  // Track studying boosts for diminishing returns

/**
 * Get the best server to target for max money/min security upgrades
 * Uses server-utils.js for centralized target selection that:
 * - Persists across script restarts (stable for entire reset)
 * - Picks highest-value reachable server based on estimated max hacking level
 * - Excludes n00dles (too low max money, soft cap makes boosts worthless)
 * @param {NS} ns
 * @returns {string}
 */
function getBestTargetServer(ns) {
  return getBestHacknetBoostTarget(ns);
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
 * Get total hash production rate across all hacknet servers
 * @param {NS} ns
 * @returns {number} hashes/sec
 */
function getTotalHashProduction(ns) {
  if (!hasHacknetServers(ns)) return 0;
  
  let totalProduction = 0;
  for (let i = 0; i < ns.hacknet.numNodes(); i++) {
    totalProduction += ns.hacknet.getNodeStats(i).production;
  }
  return totalProduction;
}

/**
 * Calculate studying upgrade costs (cost increases by 50 each time: 50, 100, 150...)
 * @param {number} upgradesPurchased - Number of upgrades already purchased
 * @returns {{nextCost: number, totalCostToMax: number, upgradesRemaining: number}}
 */
function getStudyingCosts(upgradesPurchased) {
  const baseCost = CONFIG.HASH_COSTS.IMPROVE_STUDYING;  // 50
  // Cost for upgrade n (1-indexed) = baseCost * n
  // So if we've done 0 upgrades, next is upgrade 1, cost = 50*1 = 50
  // If we've done 1 upgrade, next is upgrade 2, cost = 50*2 = 100
  const nextCost = baseCost * (upgradesPurchased + 1);
  
  // Number of upgrades to reach 10x (45 total, since 1 + 45*0.2 = 10)
  const targetMultiplier = CONFIG.STUDYING_MAX_MULTIPLIER;
  const boostPerUse = CONFIG.STUDYING_BOOST_PER_USE;
  const totalUpgradesNeeded = Math.ceil((targetMultiplier - 1) / boostPerUse);  // 45
  const upgradesRemaining = Math.max(0, totalUpgradesNeeded - upgradesPurchased);
  
  // Total cost for remaining upgrades = sum of baseCost * (k+1) for k from upgradesPurchased to totalUpgradesNeeded-1
  // = baseCost * sum from (upgradesPurchased+1) to totalUpgradesNeeded
  // = baseCost * (sum 1 to totalUpgradesNeeded - sum 1 to upgradesPurchased)
  // = baseCost * (n*(n+1)/2 - m*(m+1)/2) where n=totalUpgradesNeeded, m=upgradesPurchased
  const sumToTotal = totalUpgradesNeeded * (totalUpgradesNeeded + 1) / 2;
  const sumToPurchased = upgradesPurchased * (upgradesPurchased + 1) / 2;
  const totalCostToMax = baseCost * (sumToTotal - sumToPurchased);
  
  return { nextCost, totalCostToMax, upgradesRemaining, totalUpgradesNeeded };
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
  
  // Get actual hash costs (these scale with purchases)
  const actualCosts = {
    sellForMoney: ns.hacknet.hashCost("Sell for Money"),
    increaseMaxMoney: ns.hacknet.hashCost("Increase Maximum Money"),
    reduceMinSecurity: ns.hacknet.hashCost("Reduce Minimum Security"),
    improveStudying: ns.hacknet.hashCost("Improve Studying"),
    improveGym: ns.hacknet.hashCost("Improve Gym Training"),
    generateContract: ns.hacknet.hashCost("Generate Coding Contract"),
  };
  
  // Check BN9 studying priority FIRST to determine if we should skip selling
  let skipSellingForStudying = false;
  if (isInBitNode(ns, 9)) {
    const hashProduction = getTotalHashProduction(ns);
    const currentMultiplier = 1 + (studyingBoostsPurchased * CONFIG.STUDYING_BOOST_PER_USE);
    const hasEnoughProduction = hashProduction >= CONFIG.STUDYING_HASH_RATE_THRESHOLD;
    const notAtCap = currentMultiplier < CONFIG.STUDYING_MAX_MULTIPLIER;
    skipSellingForStudying = hasEnoughProduction && notAtCap;
  }
  
  // Sell for money - only if we're not making money from hacking
  // AND not prioritizing studying in BN9
  if (shouldSellHashesForMoney(ns) && !skipSellingForStudying) {
    actions.push({
      action: "Sell for Money",
      priority: 100,  // High priority early game
      cost: actualCosts.sellForMoney,
      available: hashes >= actualCosts.sellForMoney,
      execute: () => ns.hacknet.spendHashes("Sell for Money"),
    });
  }
  
  // Improve studying - critical in BN9 where hacking XP is gimped (5%)
  // Only prioritize once we have decent hash production (1 hash/sec)
  // Stop once we hit diminishing returns (5x boost)
  if (isInBitNode(ns, 9)) {
    const hashProduction = getTotalHashProduction(ns);
    const currentMultiplier = 1 + (studyingBoostsPurchased * CONFIG.STUDYING_BOOST_PER_USE);
    const hasEnoughProduction = hashProduction >= CONFIG.STUDYING_HASH_RATE_THRESHOLD;
    const notAtCap = currentMultiplier < CONFIG.STUDYING_MAX_MULTIPLIER;
    
    if (hasEnoughProduction && notAtCap) {
      // HIGHEST priority - studying is critical for BN9 progression
      // Must be higher than selling for money (100)
      actions.push({
        action: "Improve Studying",
        priority: 150,  // Higher than selling for money (100)
        cost: actualCosts.improveStudying,
        available: hashes >= actualCosts.improveStudying,
        execute: () => {
          const success = ns.hacknet.spendHashes("Improve Studying");
          if (success) studyingBoostsPurchased++;
          return success;
        },
      });
    } else if (notAtCap) {
      // Low production - add as lower priority option (still better than nothing if at hash cap)
      actions.push({
        action: "Improve Studying",
        priority: 25,  // Lower priority until we hit 1 hash/sec
        cost: actualCosts.improveStudying,
        available: hashes >= actualCosts.improveStudying,
        execute: () => {
          const success = ns.hacknet.spendHashes("Improve Studying");
          if (success) studyingBoostsPurchased++;
          return success;
        },
      });
    }
    // If at cap, don't add studying action at all
  }
  
  // Improve gym - same priority as server boosts, cost tiebreaker handles alternation
  actions.push({
    action: "Improve Gym Training",
    priority: 50,  // Same as server boosts - cost determines order
    cost: actualCosts.improveGym,
    available: hashes >= actualCosts.improveGym,
    execute: () => ns.hacknet.spendHashes("Improve Gym Training"),
  });
  
  // Increase max money / reduce min security - only if we have a valid target
  // Target is null during early reset while leveling rate stabilizes
  // All boost actions share priority 50 - cost tiebreaker ensures natural alternation
  const targetServer = getBestTargetServer(ns);
  if (targetServer) {
    const minSec = ns.getServerMinSecurityLevel(targetServer);
    const maxMoney = ns.getServerMaxMoney(targetServer);
    const MAX_MONEY_CAP = 10e12;  // 10 trillion soft cap
    
    const canReduceSec = minSec > 1;
    const canIncreaseMoney = maxMoney < MAX_MONEY_CAP;
    
    if (canIncreaseMoney) {
      actions.push({
        action: `Increase Maximum Money (${targetServer})`,
        priority: 50,  // Same priority as other boosts - cost determines order
        cost: actualCosts.increaseMaxMoney,
        available: hashes >= actualCosts.increaseMaxMoney,
        execute: () => ns.hacknet.spendHashes("Increase Maximum Money", targetServer),
      });
    }
    
    if (canReduceSec) {
      actions.push({
        action: `Reduce Minimum Security (${targetServer})`,
        priority: 50,  // Same priority as other boosts - cost determines order
        cost: actualCosts.reduceMinSecurity,
        available: hashes >= actualCosts.reduceMinSecurity,
        execute: () => ns.hacknet.spendHashes("Reduce Minimum Security", targetServer),
      });
    }
  }
  
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
    cost: actualCosts.generateContract,
    available: hashes >= actualCosts.generateContract,
    execute: () => ns.hacknet.spendHashes("Generate Coding Contract"),
  });
  
  // Sort ALL actions by priority first, then by cost (cheaper = better) as tiebreaker
  // This ensures natural alternation among equal-priority actions (e.g., server boosts)
  // After buying one action, its cost increases, making the other cheaper and thus preferred
  const allActionsSorted = actions.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.cost - b.cost;  // Cheaper action wins when priority is equal
  });
  
  // Check if the highest priority action needs more capacity than we have
  // This must happen BEFORE filtering by availability, otherwise we miss capacity-blocked actions
  if (allActionsSorted.length > 0) {
    const topAction = allActionsSorted[0];
    
    if (topAction.cost > capacity) {
      // Need to upgrade cache on node 0 (cheapest to keep upgrading same node)
      const cacheUpgradeCost = ns.hacknet.getCacheUpgradeCost(0);
      if (cacheUpgradeCost !== Infinity && cacheUpgradeCost > 0) {
        // Return immediately with cache upgrade as only action
        // This prevents any hash spending until capacity is upgraded
        return [{
          action: `⚠️ Need Cache Upgrade (node 0) for ${topAction.action}`,
          priority: 999,
          cost: topAction.cost,  // Show the hash cost we're trying to reach
          available: true,
          needsCacheUpgrade: true,
          cacheUpgradeCost: cacheUpgradeCost,
          execute: () => false,  // Don't execute hash spend, need $ upgrade first
        }];
      }
    } else if (!topAction.available && topAction.cost <= capacity) {
      // Top action CAN fit in capacity but we don't have enough hashes yet
      // Wait for it to accumulate rather than spending on lower priority actions
      return [{
        action: `⏳ Saving for ${topAction.action}`,
        priority: topAction.priority,
        cost: topAction.cost,
        available: false,
        isWaitingForHashes: true,
        execute: () => false,  // Don't execute anything, just wait
      }];
    }
  }
  
  // Now filter to available actions only
  const sortedActions = allActionsSorted.filter(a => a.available);
  
  return sortedActions;
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
  
  // Check if we're waiting for hashes to accumulate - don't spend anything
  const action = actions[0];
  if (action.isWaitingForHashes) {
    // Don't sell as fallback - we're saving up for a specific action
    return false;
  }
  
  // Execute highest priority available action
  const success = action.execute();
  
  if (success) {
    ns.print(`[HASH] Spent ${action.cost} hashes on: ${action.action}`);
    lastHashSpend = Date.now();
    return true;
  }
  
  return false;
}

/**
 * Find the least-upgraded non-nexus server to use as upgrade target for new servers
 * @param {NS} ns
 * @param {number} nexusIndex - Index of nexus server to exclude
 * @returns {{index: number, stats: object, totalUpgradeCost: number} | null}
 */
function getLeastUpgradedServer(ns, nexusIndex) {
  const numNodes = ns.hacknet.numNodes();
  if (numNodes === 0) return null;
  
  let least = null;
  let lowestProduction = Infinity;
  
  for (let i = 0; i < numNodes; i++) {
    if (i === nexusIndex) continue;  // Skip nexus
    
    const stats = ns.hacknet.getNodeStats(i);
    if (stats.production < lowestProduction) {
      lowestProduction = stats.production;
      least = { index: i, stats };
    }
  }
  
  return least;
}

/**
 * Calculate cost to upgrade a new server (level 1, 1GB RAM, 1 core) to match target stats
 * Uses formulas API for accurate cost calculation
 * @param {NS} ns
 * @param {object} targetStats - Stats to match {level, ram, cores}
 * @returns {number} Total upgrade cost
 */
function getUpgradeCostToMatch(ns, targetStats) {
  const player = ns.getPlayer();
  let totalCost = 0;
  
  // Cost to upgrade level from 1 to target
  // Each level upgrade cost: use formulas
  for (let lvl = 1; lvl < targetStats.level; lvl++) {
    totalCost += ns.formulas.hacknetServers.levelUpgradeCost(lvl, 1, player.mults.hacknet_node_level_cost);
  }
  
  // Cost to upgrade RAM from 1GB to target
  // RAM is in powers of 2: 1, 2, 4, 8, 16, 32, 64...
  let currentRam = 1;
  while (currentRam < targetStats.ram) {
    totalCost += ns.formulas.hacknetServers.ramUpgradeCost(currentRam, 1, player.mults.hacknet_node_ram_cost);
    currentRam *= 2;
  }
  
  // Cost to upgrade cores from 1 to target
  for (let core = 1; core < targetStats.cores; core++) {
    totalCost += ns.formulas.hacknetServers.coreUpgradeCost(core, 1, player.mults.hacknet_node_core_cost);
  }
  
  return totalCost;
}

/**
 * Get the best hacknet upgrade to purchase
 * Returns the upgrade with the best hash production per cost ratio
 * Compares downstream ROI of new server vs single upgrade ROI
 * Skips upgrades on nexus server (cores, level, and RAM beyond target)
 * @param {NS} ns
 * @returns {{nodeIndex: number, upgradeType: string, cost: number, hashGain: number, isAccumulating?: boolean} | null}
 */
function getBestUpgrade(ns) {
  const money = ns.getServerMoneyAvailable("home");
  const numNodes = ns.hacknet.numNodes();
  
  // Check if we need a cache upgrade to afford the next hash action
  const hashActions = getHashActions(ns);
  if (hashActions.length > 0 && hashActions[0].needsCacheUpgrade) {
    const cacheUpgradeCost = hashActions[0].cacheUpgradeCost;
    // Return cache upgrade as highest priority
    return {
      nodeIndex: 0,
      upgradeType: 'cache',
      cost: cacheUpgradeCost,
      hashGain: 0,  // Cache doesn't add production
      isAccumulating: money < cacheUpgradeCost,
      isCacheForCapacity: true,  // Flag for display
      targetHashCost: hashActions[0].cost,
      roiDebug: { cacheUpgradeNeeded: true }
    };
  }
  
  // Get nexus info to skip upgrades on nexus server
  const nexusInfo = getNexusInfo(ns);
  const nexusIndex = nexusInfo.server?.startsWith('hacknet-server-') 
    ? parseInt(nexusInfo.server.split('-').pop()) 
    : -1;
  const nexusTargetRam = getNexusTargetRam(ns);
  
  let best = null;
  let bestRatio = 0;
  
  // Track new server option separately - we'll compare after finding best affordable upgrade
  let newServerOption = null;
  let newServerRatio = 0;
  
  // Calculate downstream ROI for buying a new server
  // New server value = production once upgraded to match least-upgraded existing server
  // New server cost = purchase cost + upgrade cost to match that server
  if (numNodes < ns.hacknet.maxNumNodes()) {
    const newNodeCost = ns.hacknet.getPurchaseNodeCost();
    const leastUpgraded = getLeastUpgradedServer(ns, nexusIndex);
    
    if (leastUpgraded) {
      // Calculate total cost: purchase + upgrades to match least-upgraded server
      const upgradeCost = getUpgradeCostToMatch(ns, leastUpgraded.stats);
      const totalNewServerCost = newNodeCost + upgradeCost;
      
      // Benefit: production equivalent to the least-upgraded server
      const newServerProduction = leastUpgraded.stats.production;
      newServerRatio = newServerProduction / totalNewServerCost;
      
      newServerOption = {
        nodeIndex: -1,  // -1 means buy new
        upgradeType: 'new',
        cost: newNodeCost,  // Immediate cost is just purchase
        totalCost: totalNewServerCost,  // Full downstream cost
        hashGain: newServerProduction,
        canAfford: money >= newNodeCost
      };
      
      // Only set as best if we can afford it
      if (newServerOption.canAfford && newServerRatio > bestRatio) {
        bestRatio = newServerRatio;
        best = newServerOption;
      }
    } else {
      // No existing non-nexus servers - calculate actual new server production using formulas
      // New server starts at level 1, 1GB RAM, 1 core
      const player = ns.getPlayer();
      const baseProduction = ns.formulas.hacknetServers.hashGainRate(1, 0, 1, 1, player.mults.hacknet_node_money);
      const newNodeCost = ns.hacknet.getPurchaseNodeCost();
      const ratio = baseProduction / newNodeCost;
      
      newServerOption = {
        nodeIndex: -1,
        upgradeType: 'new',
        cost: newNodeCost,
        totalCost: newNodeCost,
        hashGain: baseProduction,
        canAfford: money >= newNodeCost
      };
      newServerRatio = ratio;
      
      if (money >= newNodeCost && ratio > bestRatio) {
        bestRatio = ratio;
        best = newServerOption;
      }
    }
  }
  
  // Track best upgrade by ROI, and best ROI unaffordable upgrade for comparison
  let bestUnaffordable = null;
  
  // Check upgrades for each existing node
  for (let i = 0; i < numNodes; i++) {
    const stats = ns.hacknet.getNodeStats(i);
    const currentProduction = stats.production;
    const isNexus = (i === nexusIndex);
    
    // Check if nexus has scripts running (using RAM)
    const nexusHasScripts = isNexus && ns.getServerUsedRam(nexusInfo.server) > 0;
    
    for (const type of CONFIG.UPGRADE_TYPES) {
      // Skip cores and level upgrades on nexus server ONLY if scripts are running
      // (can't upgrade level/cores while RAM is in use)
      if (nexusHasScripts && (type === 'cores' || type === 'level')) {
        continue;
      }
      
      // Skip RAM upgrades on nexus beyond target (waste of money)
      if (isNexus && type === 'ram' && stats.ram >= nexusTargetRam) {
        continue;
      }
      
      let cost, newProduction;
      
      // Hacknet server production formula:
      // production = level * 1.035^(log2(ram) - 1) * ((cores + 5) / 6) * multipliers
      // We use ratios to calculate new production based on current production
      const ramExp = Math.log2(stats.ram);
      
      switch (type) {
        case 'level':
          cost = ns.hacknet.getLevelUpgradeCost(i, 1);
          // Level is linear: new_prod = current_prod * (level + 1) / level
          newProduction = currentProduction * (stats.level + 1) / stats.level;
          break;
        case 'ram':
          cost = ns.hacknet.getRamUpgradeCost(i, 1);
          // RAM doubles, so ramExp increases by 1: new_prod = current_prod * 1.035^1
          newProduction = currentProduction * 1.035;
          break;
        case 'cores':
          cost = ns.hacknet.getCoreUpgradeCost(i, 1);
          // Cores: new_prod = current_prod * ((cores + 1 + 5) / 6) / ((cores + 5) / 6)
          //                 = current_prod * (cores + 6) / (cores + 5)
          newProduction = currentProduction * (stats.cores + 6) / (stats.cores + 5);
          break;
        case 'cache':
          cost = ns.hacknet.getCacheUpgradeCost(i, 1);
          // Cache doesn't affect production, skip for ratio calc
          continue;
        default:
          continue;
      }
      
      if (cost === Infinity) continue;
      
      const hashGain = newProduction - currentProduction;
      const ratio = hashGain / cost;
      
      if (cost <= money) {
        // Affordable - check if best ROI
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = {
            nodeIndex: i,
            upgradeType: type,
            cost,
            hashGain
          };
        }
      } else {
        // Unaffordable - track best ROI for comparison
        if (!bestUnaffordable || ratio > bestUnaffordable.ratio) {
          bestUnaffordable = {
            nodeIndex: i,
            upgradeType: type,
            cost,
            hashGain,
            ratio
          };
        }
      }
    }
  }
  
  // Build debug info for ROI comparison
  const roiDebug = {
    newServer: newServerOption ? {
      cost: newServerOption.cost,
      totalCost: newServerOption.totalCost,
      production: newServerOption.hashGain,
      ratio: newServerRatio,
      canAfford: newServerOption.canAfford
    } : null,
    bestUpgrade: best ? {
      node: best.nodeIndex,
      type: best.upgradeType,
      cost: best.cost,
      hashGain: best.hashGain,
      ratio: bestRatio
    } : null,
    bestUnaffordable: bestUnaffordable ? {
      node: bestUnaffordable.nodeIndex,
      type: bestUnaffordable.upgradeType,
      cost: bestUnaffordable.cost,
      hashGain: bestUnaffordable.hashGain,
      ratio: bestUnaffordable.ratio
    } : null
  };
  
  // Compare all options: best affordable, best unaffordable, new server
  // Pick the one with highest ROI to determine what to do
  const bestUnaffordableRatio = bestUnaffordable ? bestUnaffordable.ratio : 0;
  const newServerAffordable = newServerOption?.canAfford ?? false;
  
  // Find the highest ROI among all options
  let highestRatio = bestRatio;  // Best affordable (or 0 if none)
  let winner = 'affordable';
  
  if (bestUnaffordableRatio > highestRatio) {
    highestRatio = bestUnaffordableRatio;
    winner = 'unaffordable';
  }
  if (newServerRatio > highestRatio) {
    highestRatio = newServerRatio;
    winner = 'newserver';
  }
  
  // If we have an affordable option and it's the best, just return it
  if (best && winner === 'affordable') {
    best.roiDebug = roiDebug;
    return best;
  }
  
  // If new server is affordable and wins, return it
  if (newServerAffordable && winner === 'newserver') {
    return { ...newServerOption, roiDebug };
  }
  
  // Otherwise, we need to save for the winner
  if (winner === 'newserver') {
    return {
      ...newServerOption,
      isAccumulating: true,
      roiDebug
    };
  }
  
  if (winner === 'unaffordable') {
    return {
      ...bestUnaffordable,
      isAccumulating: true,
      roiDebug
    };
  }
  
  // Fallback: return best affordable if exists
  if (best) {
    best.roiDebug = roiDebug;
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
 * Uses shared designation from server-utils.js
 * @param {NS} ns
 * @returns {number} Node index to designate as nexus, or -1 to buy new
 */
function findBestNexusCandidate(ns) {
  const numNodes = ns.hacknet.numNodes();
  
  if (numNodes === 0) {
    return -1;  // Need to buy first node
  }
  
  // Check if there's already a designated nexus
  const existingNexus = getNexusHost(ns);
  if (existingNexus?.startsWith('hacknet-server-')) {
    return parseInt(existingNexus.split('-').pop());
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
  if (!hasHacknetServers(ns)) return;
  
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
  
  // Get current nexus designation from shared source
  let nexusDesignated = getNexusHost(ns);
  
  // Designate nexus if not done
  if (!nexusDesignated) {
    const nexusIndex = findBestNexusCandidate(ns);
    if (nexusIndex >= 0) {
      nexusDesignated = `hacknet-server-${nexusIndex}`;
      setNexusHost(ns, nexusDesignated);
      ns.print(`[HACKNET] Designated ${nexusDesignated} as nexus`);
    }
    return;
  }
  
  // Only handle hacknet nexus servers
  if (!nexusDesignated.startsWith('hacknet-server-')) {
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
  
  // Show hash spending strategy
  if (isInBitNode(ns, 9)) {
    const studyMult = 1 + (studyingBoostsPurchased * CONFIG.STUDYING_BOOST_PER_USE);
    const prioritizingStudy = totalProduction >= CONFIG.STUDYING_HASH_RATE_THRESHOLD && 
                              studyMult < CONFIG.STUDYING_MAX_MULTIPLIER;
    if (prioritizingStudy) {
      ns.print("   → Prioritizing study boosts (BN9)");
    } else if (studyMult >= CONFIG.STUDYING_MAX_MULTIPLIER) {
      ns.print("   → Study boost maxed, using other upgrades");
    } else if (shouldSellHashesForMoney(ns)) {
      ns.print("   → Selling hashes for money (low production)");
    }
  } else if (shouldSellHashesForMoney(ns)) {
    ns.print("   → Selling hashes for money (early game)");
  }
  ns.print("");
  
  // BN9 nexus status
  if (isInBitNode(ns, 9)) {
    ns.print("─── BN9 NEXUS STATUS ───");
    const nexusInfo = getNexusInfo(ns);
    if (nexusInfo.server?.startsWith('hacknet-server-')) {
      const nexusIndex = parseInt(nexusInfo.server.split('-').pop());
      const stats = ns.hacknet.getNodeStats(nexusIndex);
      const targetRam = getNexusTargetRam(ns);
      const ready = stats.ram >= targetRam;
      
      ns.print(`  Server: ${nexusInfo.server}`);
      ns.print(`  RAM: ${stats.ram}GB / ${targetRam}GB ${ready ? '✅' : '⏳'}`);
      ns.print(`  Scripts: ${nexusScriptsLaunched ? '✅ Running' : '⏳ Pending'}`);
    } else if (nexusInfo.server) {
      ns.print(`  Server: ${nexusInfo.server} (non-hacknet)`);
    } else {
      ns.print("  Awaiting designation...");
    }
    
    // Studying boost status
    const studyMult = 1 + (studyingBoostsPurchased * CONFIG.STUDYING_BOOST_PER_USE);
    const studyIcon = studyMult >= CONFIG.STUDYING_MAX_MULTIPLIER ? '✅' : 
                      (totalProduction >= CONFIG.STUDYING_HASH_RATE_THRESHOLD ? '📚' : '⏳');
    ns.print(`  ${studyIcon} Study Boost: ${studyMult.toFixed(1)}x (${studyingBoostsPurchased} purchased)`);
    
    // Studying cost breakdown
    if (studyMult < CONFIG.STUDYING_MAX_MULTIPLIER) {
      const costs = getStudyingCosts(studyingBoostsPurchased);
      const finalCost = CONFIG.HASH_COSTS.IMPROVE_STUDYING * costs.totalUpgradesNeeded;  // Cost of last upgrade
      const timeToFinal = totalProduction > 0 ? finalCost / totalProduction : Infinity;
      const timeToFinalStr = timeToFinal < Infinity ? ns.tFormat(timeToFinal * 1000) : '∞';
      
      ns.print(`  📊 Next: ${costs.nextCost}h | Final: ${finalCost}h | Remaining: ${ns.formatNumber(costs.totalCostToMax)}h total`);
      ns.print(`  ⏱️  Time to final: ${timeToFinalStr} | Cache needed: ${finalCost}h`);
    }
    ns.print("");
  }
  
  // Next actions
  ns.print("─── NEXT ACTIONS ───");
  
  // Show hacknet boost target status
  const boostTarget = getBestTargetServer(ns);
  if (boostTarget) {
    ns.print(`  Boost Target: ${boostTarget}`);
  } else {
    const resetInfo = ns.getResetInfo();
    const hoursElapsed = (Date.now() - resetInfo.lastAugReset) / (1000 * 60 * 60);
    ns.print(`  ⏳ Boost Target: None (${hoursElapsed.toFixed(1)}h < 1h min)`);
    ns.print(`     → Max money/security boosts disabled until 1h into reset`);
  }
  
  // Hash spending
  const hashActions = getHashActions(ns);
  if (hashActions.length > 0) {
    const topAction = hashActions[0];
    if (topAction.needsCacheUpgrade) {
      // Show cache upgrade needed
      ns.print(`  Hash: ${topAction.action}`);
      ns.print(`     → Need ${ns.formatNumber(topAction.cost)}h capacity (current: ${ns.formatNumber(ns.hacknet.hashCapacity())}h)`);
      ns.print(`     → Cache upgrade cost: $${ns.formatNumber(topAction.cacheUpgradeCost)}`);
    } else if (topAction.isWaitingForHashes) {
      // Show waiting for hashes with progress
      const currentHashes = ns.hacknet.numHashes();
      const pct = ((currentHashes / topAction.cost) * 100).toFixed(1);
      ns.print(`  Hash: ${topAction.action} (${ns.formatNumber(currentHashes)}/${ns.formatNumber(topAction.cost)}h - ${pct}%)`);
    } else {
      ns.print(`  Hash: ${topAction.action} (${ns.formatNumber(topAction.cost)}h)`);
    }
  } else {
    ns.print("  Hash: Accumulating...");
  }
  
  // Upgrade purchasing
  const bestUpgrade = getBestUpgrade(ns);
  if (bestUpgrade) {
    const money = ns.getServerMoneyAvailable("home");
    
    if (bestUpgrade.isCacheForCapacity) {
      // Cache upgrade needed for hash capacity
      if (bestUpgrade.isAccumulating) {
        ns.print(`  💰 Saving: Cache upgrade node 0 ($${ns.formatNumber(bestUpgrade.cost)} / $${ns.formatNumber(money)})`);
      } else {
        ns.print(`  Buy: Cache upgrade node 0 ($${ns.formatNumber(bestUpgrade.cost)})`);
      }
      ns.print(`     → Needed for ${ns.formatNumber(bestUpgrade.targetHashCost)}h hash action`);
    } else if (bestUpgrade.nodeIndex === -1) {
      // New node
      if (bestUpgrade.isAccumulating) {
        ns.print(`  💰 Saving for: New node ($${ns.formatNumber(bestUpgrade.cost)} / $${ns.formatNumber(money)})`);
      } else {
        ns.print(`  Buy: New node ($${ns.formatNumber(bestUpgrade.cost)})`);
      }
      if (bestUpgrade.totalCost) {
        ns.print(`     → Downstream: $${ns.formatNumber(bestUpgrade.totalCost)} for ${ns.formatNumber(bestUpgrade.hashGain)}/sec`);
      }
    } else if (bestUpgrade.isAccumulating) {
      // Saving for an existing node upgrade
      ns.print(`  💰 Saving: Node ${bestUpgrade.nodeIndex} ${bestUpgrade.upgradeType} ($${ns.formatNumber(bestUpgrade.cost)} / $${ns.formatNumber(money)})`);
    } else {
      // Affordable upgrade on existing node
      ns.print(`  Upgrade: Node ${bestUpgrade.nodeIndex} ${bestUpgrade.upgradeType} ($${ns.formatNumber(bestUpgrade.cost)})`);
    }
    
    // Show ROI debug info
    if (bestUpgrade.roiDebug) {
      const dbg = bestUpgrade.roiDebug;
      ns.print("─── ROI DEBUG ───");
      if (dbg.newServer) {
        const ns8 = dbg.newServer;
        ns.print(`  New Server: $${ns.formatNumber(ns8.cost)} purchase, $${ns.formatNumber(ns8.totalCost)} total`);
        ns.print(`    → Prod: ${ns.formatNumber(ns8.production)}/s, ROI: ${ns.formatNumber(ns8.ratio * 1e9, 3)}e-9`);
      } else {
        ns.print(`  New Server: N/A (max nodes or no ref server)`);
      }
      if (dbg.bestUpgrade) {
        const ba = dbg.bestUpgrade;
        ns.print(`  Best Affordable: Node ${ba.node} ${ba.type} ($${ns.formatNumber(ba.cost)})`);
        ns.print(`    → Gain: ${ns.formatNumber(ba.hashGain)}/s, ROI: ${ns.formatNumber(ba.ratio * 1e9, 3)}e-9`);
      } else {
        ns.print(`  Best Affordable: None`);
      }
      if (dbg.bestUnaffordable) {
        const bu = dbg.bestUnaffordable;
        ns.print(`  Best Unaffordable: Node ${bu.node} ${bu.type} ($${ns.formatNumber(bu.cost)})`);
        ns.print(`    → Gain: ${ns.formatNumber(bu.hashGain)}/s, ROI: ${ns.formatNumber(bu.ratio * 1e9, 3)}e-9`);
      }
      // Show winner comparison among all three options
      const ratios = [];
      if (dbg.newServer) ratios.push({ name: 'New Server', ratio: dbg.newServer.ratio });
      if (dbg.bestUpgrade) ratios.push({ name: 'Affordable', ratio: dbg.bestUpgrade.ratio });
      if (dbg.bestUnaffordable) ratios.push({ name: 'Unaffordable', ratio: dbg.bestUnaffordable.ratio });
      if (ratios.length > 0) {
        const winner = ratios.reduce((a, b) => a.ratio > b.ratio ? a : b);
        ns.print(`  Winner: ${winner.name} (ROI: ${ns.formatNumber(winner.ratio * 1e9, 3)}e-9)`);
      }
    }
  } else {
    ns.print("  Upgrade: Waiting for funds...");
  }
  
  // Payback heuristic - should we keep upgrading?
  ns.print("─── UPGRADE HEURISTIC ───");
  const hackingIncome = ns.getTotalScriptIncome()[0];  // Current $/sec from scripts
  const totalCashFlow = hashMoneyRate + hackingIncome;  // hashMoneyRate already declared above
  
  ns.print(`  Cash Flow: $${ns.formatNumber(totalCashFlow)}/sec`);
  ns.print(`    → Hash: $${ns.formatNumber(hashMoneyRate)}/sec | Hacking: $${ns.formatNumber(hackingIncome)}/sec`);
  
  if (bestUpgrade && bestUpgrade.roiDebug) {
    // Get the winning option's cost and hash gain
    const dbg = bestUpgrade.roiDebug;
    let targetCost = bestUpgrade.cost;
    let targetHashGain = bestUpgrade.hashGain || 0;
    let targetName = bestUpgrade.upgradeType;
    
    // If it's a new server, use downstream cost
    if (bestUpgrade.nodeIndex === -1 && bestUpgrade.totalCost) {
      targetCost = bestUpgrade.totalCost;
    }
    
    // Convert hash gain to $/sec (1 hash = $250k when sold)
    const hashToMoney = 1e6 / CONFIG.HASH_COSTS.SELL_FOR_MONEY;  // $250k per hash
    const hashIncomeGain = targetHashGain * hashToMoney;
    const adjustedOutsideIncome = Math.pow(Math.max(0, hackingIncome), 0.7);
    
    // Effective income considers hash value PLUS sqrt(online income)
    // This reflects that hashes support overall operations (max money boosts, etc.)
    // sqrt() ensures we don't overspend when online income is low, but scale reasonably when high
    const effectiveIncomeGain = hashIncomeGain + adjustedOutsideIncome;
    
    // Payback time = cost / effective income gain from this upgrade
    const paybackTime = effectiveIncomeGain > 0 ? targetCost / effectiveIncomeGain : Infinity;
    const paybackStr = paybackTime < Infinity ? ns.tFormat(paybackTime * 1000) : '∞';
    
    // Time to afford = cost / cash flow
    const timeToAfford = totalCashFlow > 0 ? targetCost / totalCashFlow : Infinity;
    const affordStr = timeToAfford < Infinity ? ns.tFormat(timeToAfford * 1000) : '∞';
    
    ns.print(`  Next Target: ${targetName} ($${ns.formatNumber(targetCost)})`);
    ns.print(`    → Effective value of next upgrade: $${ns.formatNumber(hashIncomeGain)}/sec hash + $${ns.formatNumber(adjustedOutsideIncome)}/sec (√online)`);
    ns.print(`    → +${ns.formatNumber(targetHashGain)}/sec hash production`);
    ns.print(`    → Time to afford: ${affordStr}`);
    ns.print(`    → Payback time: ${paybackStr}`);
    
    // Show upgrade status based on payback time
    if (paybackTime > CONFIG.MAX_PAYBACK_TIME_SEC) {
      ns.print(`  🛑 UPGRADES STOPPED - Payback > ${CONFIG.MAX_PAYBACK_TIME_SEC / 3600}hr`);
    } else if (paybackTime > 3600) {
      ns.print(`  ⚠️  Payback > 1hr - approaching stop threshold`);
    } else if (paybackTime > 1800) {
      ns.print(`  ⏳ Payback 30-60min - upgrades slowing down`);
    } else {
      ns.print(`  ✅ Payback < 30min - upgrades worthwhile`);
    }
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
  
  // Initialize studying boosts from current game state
  // Cost formula: cost = 50 * (level + 1), so level = (cost / 50) - 1
  if (isInBitNode(ns, 9)) {
    const currentCost = ns.hacknet.hashCost("Improve Studying");
    studyingBoostsPurchased = Math.round((currentCost / CONFIG.HASH_COSTS.IMPROVE_STUDYING) - 1);
    ns.print(`Studying boosts already purchased: ${studyingBoostsPurchased}`);
  }
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
    
    // Purchase upgrades (skip when accumulating or payback time too long)
    const upgrade = getBestUpgrade(ns);
    if (upgrade && !upgrade.isAccumulating) {
      // Check payback time before executing
      // Use hash income + adjusted online income to value upgrades beyond just selling hashes
      const hashGain = upgrade.hashGain || 0;
      const hashToMoney = 1e6 / CONFIG.HASH_COSTS.SELL_FOR_MONEY;
      const hashIncomeGain = hashGain * hashToMoney;
      const onlineIncome = ns.getTotalScriptIncome()[0];
      const adjustedOutsideIncome = Math.pow(onlineIncome, 0.7);
      const effectiveIncomeGain = hashIncomeGain + adjustedOutsideIncome;
      const upgradeCost = (upgrade.nodeIndex === -1 && upgrade.totalCost) ? upgrade.totalCost : upgrade.cost;
      const paybackTime = effectiveIncomeGain > 0 ? upgradeCost / effectiveIncomeGain : Infinity;
      
      if (paybackTime <= CONFIG.MAX_PAYBACK_TIME_SEC) {
        executeUpgrade(ns, upgrade);
      }
      // If payback > threshold, skip upgrade (will show in status)
    }
    
    // Print status
    printStatus(ns);
    
    await ns.sleep(CONFIG.CYCLE_DELAY_MS);
  }
}