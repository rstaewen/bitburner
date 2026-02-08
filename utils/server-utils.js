/** @param {NS} ns */

import { getAllServers } from '/utils/scanner.js';
import {
  isInBitNode,
  getSourceFileLevel,
  getLastAugReset
} from "utils/bitnode-cache.js";

/**
 * server-utils.js - Centralized server knowledge and management
 * 
 * Replaces nexus-utils.js with expanded functionality:
 * - Returns list of runnable servers (excluding reserved/hacknet as appropriate)
 * - Handles BitNode 9 (Hacknet) special cases
 * - Manages the "nexus" designation for special scripts
 * - Provides server copying utilities
 */

// Cache the designated nexus until soft reset
let designatedNexus = null;
let nexusDesignatedAt = null;

// Constants
const NEXUS_DEFAULT_NAME = "nexus";
const NEXUS_DESIGNATION_FILE = '/data/nexus-designation.json';
const NEXUS_TARGET_RAM_BASE = 512; // GB - base target before SF4 multipliers

/**
 * Execute a script as a singleton - checks both target server AND common locations
 * (home, nexus) to prevent duplication across server migrations.
 * @param {NS} ns
 * @param {string} script
 * @param {string} targetServer
 * @param {boolean} withRestart - If true, kills existing instance on targetServer before starting
 * @returns {number} PID if started, 0 if already running somewhere
 */
export function execSingleton(ns, script, targetServer, withRestart) {
  // Check if running on target
  const runningOnTarget = ns.isRunning(script, targetServer);
  
  // Check common singleton locations to prevent cross-server duplication
  const runningOnHome = targetServer !== "home" && ns.isRunning(script, "home");
  const nexus = getNexusHost(ns);
  const runningOnNexus = nexus && targetServer !== nexus && ns.isRunning(script, nexus);
  
  if (withRestart) {
    // Only kill on target server, not other locations
    ns.kill(script, targetServer);
    return ns.exec(script, targetServer);
  } else {
    // Don't start if running ANYWHERE
    if (runningOnTarget || runningOnHome || runningOnNexus) {
      return 0;
    }
    return ns.exec(script, targetServer);
  }
}

/**
 * Check if we're in BitNode 9 (Hacktocracy)
 * @param {NS} ns
 * @returns {boolean}
 */
export function isHacknetBitNode(ns) {
  return isInBitNode(ns, 9)
}

/**
 * Check if we can purchase regular servers in this bitnode
 * @param {NS} ns
 * @returns {boolean}
 */
export function canPurchaseServers(ns) {
  // Server limit of 0 means we can't buy servers
  return ns.getPurchasedServerLimit() > 0;
}

/**
 * Check if hacknets are purchasable in this bitnode
 * @param {NS} ns
 * @returns {boolean}
 */
export function canPurchaseHacknets(ns) {
  // In most bitnodes, hacknets are available
  // Check if we can afford the cost (exists = purchasable)
  try {
    const cost = ns.hacknet.getPurchaseNodeCost();
    return cost > 0 && cost < Infinity;
  } catch {
    return false;
  }
}

/**
 * Check if hacknet servers exist (vs hacknet nodes)
 * Hacknet servers exist in BN9 and when you have SF9
 * @param {NS} ns
 * @returns {boolean}
 */
export function hasHacknetServers(ns) {
  // If we're in BN9 or have SF9, hacknet "nodes" are actually servers
  return isInBitNode(ns, 9) || getSourceFileLevel(ns, 9) > 0;
}

/**
 * Get all hacknet server hostnames
 * @param {NS} ns
 * @returns {string[]}
 */
export function getHacknetServers(ns) {
  if (!hasHacknetServers(ns)) {
    return [];
  }
  
  const servers = [];
  const numNodes = ns.hacknet.numNodes();
  
  for (let i = 0; i < numNodes; i++) {
    // Hacknet servers are named "hacknet-server-N"
    servers.push(`hacknet-server-${i}`);
  }
  
  return servers;
}

/**
 * Get the RAM cost multiplier for singularity functions based on SF4 level
 * Based on actual game mechanics:
 * - BN4: 1x (no penalty)
 * - SF4-1: 16x RAM cost
 * - SF4-2: 4x RAM cost  
 * - SF4-3: 1x RAM cost (no penalty)
 * @param {NS} ns
 * @returns {number}
 */
export function getSingularityRamMultiplier(ns) {
  // In BN4, no penalty
  if (isInBitNode(ns, 4)) return 1;
  
  // SF4 levels reduce the RAM cost
  // These are the actual game multipliers
  switch (getSourceFileLevel(ns, 4)) {
    case 0: return 16;  // No SF4 = 16x RAM cost
    case 1: return 16;  // SF4-1 = 16x
    case 2: return 4;   // SF4-2 = 4x
    default: return 1;  // SF4-3+ = 1x (no penalty)
  }
}

/**
 * Get target RAM for nexus server based on singularity costs
 * @param {NS} ns
 * @returns {number}
 */
export function getNexusTargetRam(ns) {
  const multiplier = getSingularityRamMultiplier(ns);
  return NEXUS_TARGET_RAM_BASE * multiplier;
}

/**
 * Get the default name for the nexus server
 * @param {NS} ns
 * @returns {string}
 */
export function getNexusDefaultName(ns) {
  return NEXUS_DEFAULT_NAME;
}

/**
 * Read the nexus designation from file (single source of truth)
 * @param {NS} ns
 * @returns {{server: string|null, designatedAt: number|null}}
 */
function readNexusDesignation(ns) {
  try {
    if (ns.fileExists(NEXUS_DESIGNATION_FILE, 'home')) {
      const data = JSON.parse(ns.read(NEXUS_DESIGNATION_FILE));
      if (data.server && ns.serverExists(data.server)) {
        return data;
      }
    }
  } catch (e) {
    // File doesn't exist or is corrupt, return null
  }
  return { server: null, designatedAt: null };
}

/**
 * Write the nexus designation to file (single source of truth)
 * @param {NS} ns
 * @param {string} server
 */
function writeNexusDesignation(ns, server) {
  const data = {
    server,
    designatedAt: Date.now()
  };
  ns.write(NEXUS_DESIGNATION_FILE, JSON.stringify(data), 'w');
}

/**
 * Find the best hacknet server to use as nexus in BN9
 * Strategy: prefer hacknet-server-1 to avoid wasting heavily-upgraded server-0
 * @param {NS} ns
 * @returns {string|null}
 */
function findBestHacknetNexus(ns) {
  if (!hasHacknetServers(ns)) return null;
  const numNodes = ns.hacknet.numNodes();
  if (numNodes === 0) return null;

  // Need at least two nodes so server-0 can focus on hash production
  if (numNodes < 2) {
    return null;
  }

  const preferred = "hacknet-server-1";
  if (ns.serverExists(preferred)) {
    return preferred;
  }

  // Fallback: pick the lowest production server (skipping server-0 when possible)
  let bestServer = null;
  let lowestProduction = Infinity;

  for (let i = 0; i < numNodes; i++) {
    if (i === 0 && numNodes > 1) continue;
    const hostname = `hacknet-server-${i}`;
    const stats = ns.hacknet.getNodeStats(i);
    if (stats.production < lowestProduction) {
      lowestProduction = stats.production;
      bestServer = hostname;
    }
  }

  return bestServer;
}

/**
 * Find the nexus server among purchased servers
 * @param {NS} ns
 * @param {number} minRam - Minimum RAM required (default 0)
 * @returns {string|null}
 */
function findPurchasedNexus(ns, minRam = 0) {
  const servers = ns.getPurchasedServers();
  
  // Look for servers with nexus-like names
  const nexusNames = [NEXUS_DEFAULT_NAME, `${NEXUS_DEFAULT_NAME}-0`];
  
  for (const name of nexusNames) {
    if (servers.includes(name)) {
      const ram = ns.getServerMaxRam(name);
      if (ram >= minRam) {
        return name;
      }
    }
  }
  
  return null;
}

/**
 * Get the designated nexus host
 * Uses file-based storage for cross-script consistency
 * @param {NS} ns
 * @param {number} minRam - Minimum RAM required (default 0)
 * @returns {string|null}
 */
export function getNexusHost(ns, minRam = 0) {
  // First check file-based designation (single source of truth)
  const fileDesignation = readNexusDesignation(ns);
  if (fileDesignation.server && ns.serverExists(fileDesignation.server)) {
    const ram = ns.getServerMaxRam(fileDesignation.server);
    if (ram >= minRam) {
      designatedNexus = fileDesignation.server;
      nexusDesignatedAt = fileDesignation.designatedAt;
      return designatedNexus;
    }
  }

  // Return cached nexus if still valid (fallback)
  if (designatedNexus && ns.serverExists(designatedNexus)) {
    const ram = ns.getServerMaxRam(designatedNexus);
    if (ram >= minRam) {
      return designatedNexus;
    }
  }

  // PRIORITY: Purchased server named "nexus" (if purchasable)
  if (canPurchaseServers(ns)) {
    const purchasedNexus = findPurchasedNexus(ns, minRam);
    if (purchasedNexus) {
      designatedNexus = purchasedNexus;
      nexusDesignatedAt = Date.now();
      writeNexusDesignation(ns, designatedNexus);
      return designatedNexus;
    }

    // Let server-manager create one instead of falling back to hacknet
    return null;
  }

  // BN9 fallback: only use hacknet nexus when regular servers aren't possible
  if (hasHacknetServers(ns)) {
    const hacknetNexus = findBestHacknetNexus(ns);
    if (hacknetNexus) {
      const ram = ns.getServerMaxRam(hacknetNexus);
      if (ram >= minRam) {
        designatedNexus = hacknetNexus;
        nexusDesignatedAt = Date.now();
        writeNexusDesignation(ns, designatedNexus);
        return designatedNexus;
      }
    }
  }

  return null;
}

/**
 * Designate a specific server as the nexus (for hacknet-manager to set)
 * @param {NS} ns
 * @param {string} server
 * @returns {boolean} Success
 */
export function setNexusHost(ns, server) {
  if (!ns.serverExists(server)) {
    return false;
  }
  designatedNexus = server;
  nexusDesignatedAt = Date.now();
  writeNexusDesignation(ns, server);
  return true;
}

/**
 * Designate a nexus server with conflict detection
 * @param {NS} ns
 * @param {string} server
 * @param {string} caller
 * @returns {boolean}
 */
export function tryDesignateNexus(ns, server, caller = "unknown") {
  const existing = readNexusDesignation(ns);

  if (existing.server && existing.server !== server && ns.serverExists(existing.server)) {
    ns.print(`[SERVER-UTILS] Nexus already designated to ${existing.server}, rejecting ${server} from ${caller}`);
    return false;
  }

  const success = setNexusHost(ns, server);
  if (success) {
    ns.print(`[SERVER-UTILS] ${caller} designated ${server} as nexus`);
  }
  return success;
}

/**
 * Get all servers reserved for special scripts (not for worker deployment)
 * @param {NS} ns
 * @returns {string[]}
 */
export function getReservedServers(ns) {
  const reserved = [];
  
  // Add any nexus-named servers
  const servers = ns.getPurchasedServers();
  const nexusNames = [NEXUS_DEFAULT_NAME, `${NEXUS_DEFAULT_NAME}-0`];
  
  for (const name of nexusNames) {
    if (servers.includes(name)) {
      reserved.push(name);
    }
  }
  
  // In BN9, the designated hacknet nexus is also reserved
  if (hasHacknetServers(ns) && designatedNexus?.startsWith('hacknet-server-')) {
    reserved.push(designatedNexus);
  }
  
  return reserved;
}

/**
 * Get all servers that can run worker scripts (for orchestrator)
 * Excludes: home, reserved servers, hacknet servers (in most cases)
 * @param {NS} ns
 * @param {boolean} includeHome - Whether to include home (default false)
 * @returns {string[]}
 */
export function getRunnerServers(ns, includeHome = false) {
  const runners = [];
  const reserved = new Set(getReservedServers(ns));
  const hacknetSet = new Set(getHacknetServers(ns));
  
  // Add purchased servers (excluding reserved)
  for (const server of ns.getPurchasedServers()) {
    if (!reserved.has(server)) {
      runners.push(server);
    }
  }
  
  // Add rooted world servers with RAM
  const visited = new Set();
  const queue = ["home"];
  
  while (queue.length > 0) {
    const server = queue.shift();
    if (visited.has(server)) continue;
    visited.add(server);
    
    // Skip home unless requested
    if (server === "home" && !includeHome) {
      // Still scan neighbors
      for (const neighbor of ns.scan(server)) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
      continue;
    }
    
    // Skip hacknet servers (they're for hash production, not workers)
    if (hacknetSet.has(server)) continue;
    
    // Skip purchased servers (already handled above)
    if (ns.getPurchasedServers().includes(server)) continue;
    
    // Check if rooted and has RAM
    if (ns.hasRootAccess(server) && ns.getServerMaxRam(server) > 0) {
      runners.push(server);
    }
    
    // Scan neighbors
    for (const neighbor of ns.scan(server)) {
      if (!visited.has(neighbor)) queue.push(neighbor);
    }
  }
  
  return runners;
}

/**
 * Get all .js files from home
 * @param {NS} ns
 * @returns {string[]}
 */
function getAllHomeFiles(ns) {
  return ns.ls("home").filter(f => f.endsWith(".js") || f.endsWith(".json"));
}

/**
 * Copy all home scripts to the designated nexus server
 * @param {NS} ns
 * @param {string} nexusServer - The server to copy to (if not provided, uses getNexusHost)
 * @returns {boolean} Success
 */
export function copyScriptsToNexus(ns, nexusServer = null) {
  const target = nexusServer || getNexusHost(ns);
  
  if (!target) {
    ns.print("[SERVER-UTILS] No nexus server available for script copy");
    return false;
  }
  
  const files = getAllHomeFiles(ns);
  
  if (files.length === 0) {
    ns.print("[SERVER-UTILS] No .js files found on home");
    return false;
  }
  
  ns.print(`[SERVER-UTILS] Copying ${files.length} files to ${target}...`);
  
  const success = ns.scp(files, target, "home");
  
  if (success) {
    ns.print(`[SERVER-UTILS] ✅ Successfully copied scripts to ${target}`);
  } else {
    ns.print(`[SERVER-UTILS] ⚠️ Some files may not have copied`);
  }
  
  return success;
}

/**
 * Clear the cached nexus designation (for testing or manual reset)
 */
export function clearNexusCache() {
  designatedNexus = null;
  nexusDesignatedAt = null;
}

/**
 * Get info about the current nexus designation
 * @param {NS} ns
 * @returns {{server: string|null, ram: number, ready: boolean, designatedAt: number|null}}
 */
export function getNexusInfo(ns) {
  const server = getNexusHost(ns);
  const targetRam = getNexusTargetRam(ns);
  
  if (!server) {
    return {
      server: null,
      ram: 0,
      targetRam,
      ready: false,
      designatedAt: null
    };
  }
  
  const ram = ns.getServerMaxRam(server);
  
  return {
    server,
    ram,
    targetRam,
    ready: ram >= targetRam,
    designatedAt: nexusDesignatedAt
  };
}

/**
 * Check if a script is running on the nexus
 * @param {NS} ns
 * @param {string} scriptName
 * @param {any[]} args - Optional args to match
 * @returns {boolean}
 */
export function isRunningOnNexus(ns, scriptName, ...args) {
  const nexus = getNexusHost(ns);
  if (!nexus) return false;
  
  if (args.length > 0) {
    return ns.isRunning(scriptName, nexus, ...args);
  }
  
  return ns.isRunning(scriptName, nexus);
}

/**
 * Execute a script on the nexus server
 * @param {NS} ns
 * @param {string} scriptName
 * @param {number} threads
 * @param {...any} args
 * @returns {number} PID or 0 if failed
 */
export function execOnNexus(ns, scriptName, threads = 1, ...args) {
  const nexus = getNexusHost(ns);
  if (!nexus) {
    ns.print(`[SERVER-UTILS] Cannot exec ${scriptName}: no nexus available`);
    return 0;
  }
  
  // Make sure the script exists on nexus
  if (!ns.fileExists(scriptName, nexus)) {
    ns.print(`[SERVER-UTILS] Script ${scriptName} not found on ${nexus}, copying...`);
    ns.scp(scriptName, nexus, "home");
  }
  
  return ns.exec(scriptName, nexus, threads, ...args);
}

// =============================================================================
// SERVER TARGETING DATA (Single source of truth)
// =============================================================================

// Blacklisted servers - never hack these, they're not worth the thread cost
// Generated from server-analyzer.js: servers with growthRate <= 10
const BLACKLIST_SERVERS = [
  "fulcrumassets",  // growth=1, needs 67k threads to grow, earns $368/s - absolute worst
  "foodnstuff",     // growth=5, needs 3.9k threads, deceptively bad early game trap
  "sigma-cosmetics", // growth=10, needs 1.9k threads
  // NOTE: n00dles is NOT blacklisted despite low max money ($1.75m)
  // Its growth rate of 3000 means only ~7 threads to fully grow
  // Perfect bootstrapper: minimal thread cost, instant cycling, good early XP
];

// Priority prep targets by hacking level tier
// From server-analyzer.js output - best $/sec servers at each level range
const PRIORITY_PREP_TARGETS_BY_LEVEL = {
  // Level 1-100: Very early game - n00dles is the ultimate bootstrapper
  // Only needs ~10 threads total to cycle, generates seed money while real targets prep
  0: ["n00dles", "joesguns", "harakiri-sushi", "hong-fang-tea", "nectar-net", "neo-net"],
  
  // Level 101-300: Early game - n00dles still useful but diminishing returns
  100: ["n00dles", "max-hardware", "joesguns", "harakiri-sushi", "zer0", "phantasy", "nectar-net"],
  
  // Level 301-500: Early-mid game - n00dles becomes irrelevant, drop from list
  300: ["omega-net", "phantasy", "silver-helix", "crush-fitness", "max-hardware", "iron-gym"],
  
  // Level 501-700: Mid game
  500: ["computek", "the-hub", "catalyst", "summit-uni", "rho-construction", "omega-net"],
  
  // Level 701-900: Mid-late game
  700: ["rho-construction", "alpha-ent", "computek", "the-hub", "catalyst", "lexo-corp"],
  
  // Level 901-1100: Late game
  900: ["alpha-ent", "rho-construction", "lexo-corp", "global-pharm", "zb-institute", "computek"],
  
  // Level 1101-1300: End game begins
  1100: ["kuai-gong", "b-and-a", "4sigma", "blade", "nwo", "clarkinc", "megacorp", "omnitek"],
  
  // Level 1301-1500: End game
  1300: ["ecorp", "megacorp", "nwo", "blade", "clarkinc", "b-and-a", "4sigma", "kuai-gong"],
  
  // Level 1501+: Max level
  1500: ["ecorp", "megacorp", "nwo", "clarkinc", "blade", "b-and-a", "4sigma", "kuai-gong", "omnitek"],
};

// Server required hacking levels (for hacknet boost target selection)
// These are the minimum hacking levels needed to hack each server
const SERVER_REQUIRED_LEVELS = {
  "n00dles": 1,
  "foodnstuff": 1,
  "sigma-cosmetics": 5,
  "joesguns": 10,
  "nectar-net": 20,
  "hong-fang-tea": 30,
  "harakiri-sushi": 40,
  "neo-net": 50,
  "zer0": 75,
  "max-hardware": 80,
  "iron-gym": 100,
  "phantasy": 100,
  "silver-helix": 150,
  "omega-net": 187,
  "crush-fitness": 225,
  "johnson-ortho": 250,
  "the-hub": 275,
  "computek": 300,
  "netlink": 375,
  "catalyst": 400,
  "summit-uni": 400,
  "syscore": 450,
  "rothman-uni": 475,
  "aevum-police": 500,
  "millenium-fitness": 525,
  "lexo-corp": 550,
  "alpha-ent": 600,
  "rho-construction": 650,
  "snap-fitness": 700,
  "zb-institute": 725,
  "global-pharm": 750,
  "unitalife": 775,
  "zb-def": 775,
  "nova-med": 800,
  "deltaone": 800,
  "applied-energetics": 850,
  "zeus-med": 850,
  "univ-energy": 875,
  "solaris": 900,
  "taiyang-digital": 925,
  "aerocorp": 925,
  "titan-labs": 950,
  "galactic-cyber": 950,
  "vitalife": 975,
  "omnia": 975,
  "icarus": 1000,
  "defcomm": 1000,
  "helios": 1000,
  "microdyne": 1000,
  "stormtech": 1025,
  "infocomm": 1050,
  "fulcrumtech": 1050,
  "powerhouse-fitness": 1075,
  "omnitek": 1100,
  "b-and-a": 1100,
  "blade": 1150,
  "nwo": 1200,
  "clarkinc": 1200,
  "4sigma": 1200,
  "kuai-gong": 1250,
  "fulcrumassets": 1250,
  "megacorp": 1300,
  "ecorp": 1350,
};

// Cache for hacknet boost target (stable for entire reset)
let cachedHacknetBoostTarget = null;
let cachedHacknetBoostTargetResetTime = 0;  // Track which reset the cache is for
const HACKNET_BOOST_TARGET_FILE = '/data/hacknet-boost-target.json';

/**
 * Get the blacklisted servers array
 * @returns {string[]}
 */
export function getBlacklistServers() {
  return [...BLACKLIST_SERVERS];
}

/**
 * Check if a server is blacklisted
 * @param {string} server
 * @returns {boolean}
 */
export function isServerBlacklisted(server) {
  return BLACKLIST_SERVERS.includes(server);
}

/**
 * Get priority prep targets for the current hacking level
 * @param {NS} ns
 * @returns {string[]}
 */
export function getPriorityTargets(ns) {
  const hackLevel = ns.getHackingLevel();
  
  // Find the appropriate tier
  const levelTiers = Object.keys(PRIORITY_PREP_TARGETS_BY_LEVEL)
    .map(Number)
    .sort((a, b) => b - a); // Sort descending
  
  for (const tier of levelTiers) {
    if (hackLevel >= tier) {
      return [...PRIORITY_PREP_TARGETS_BY_LEVEL[tier]];
    }
  }
  
  return [...PRIORITY_PREP_TARGETS_BY_LEVEL[0]];
}

/**
 * Get the full priority prep targets table
 * @returns {Object}
 */
export function getPriorityTargetsByLevel() {
  // Return a copy to prevent mutation
  return JSON.parse(JSON.stringify(PRIORITY_PREP_TARGETS_BY_LEVEL));
}

// =============================================================================
// HACKNET BOOST TARGET SELECTION
// =============================================================================

/**
 * Read the cached hacknet boost target from file
 * @param {NS} ns
 * @returns {string|null}
 */
function readHacknetBoostTarget(ns) {
  try {
    if (ns.fileExists(HACKNET_BOOST_TARGET_FILE, 'home')) {
      const data = JSON.parse(ns.read(HACKNET_BOOST_TARGET_FILE));
      if (data.target && typeof data.target === 'string') {
        // Validate that this cache was created in the current reset
        const resetTime = getLastAugReset(ns);
        if (data.selectedAt && data.selectedAt > resetTime) {
          return data.target;
        }
        // Stale cache from previous reset - will be cleared by caller
        return null;
      }
    }
  } catch (e) {
    // File doesn't exist or is corrupt
  }
  return null;
}

/**
 * Write the hacknet boost target to file (persists across script restarts)
 * @param {NS} ns
 * @param {string} target
 */
function writeHacknetBoostTarget(ns, target) {
  const data = {
    target,
    selectedAt: Date.now(),
    reason: `Selected based on expected reachable max money potential`
  };
  ns.write(HACKNET_BOOST_TARGET_FILE, JSON.stringify(data, null, 2), 'w');
}

// =============================================================================
// SERVER VALUE AND EFFICIENCY CALCULATIONS
// =============================================================================

/**
 * Calculate the "value" of each hackable server
 * 
 * Value = 95% of maxMoney / (max(weakenTime, growTime, hackTime) + 0.3)
 * 
 * The 0.3s buffer accounts for the orchestrator's layered algorithm which
 * spaces grow/weaken/hack threads with 150ms between landing times.
 * This represents the theoretical minimum cycle time for 95% money extraction.
 * 
 * @param {NS} ns
 * @returns {Map<string, {server: string, maxMoney: number, cycleTime: number, value: number, reqLevel: number}>}
 */
export function getServerValues(ns) {
  const allServers = getAllServers(ns);
  const player = ns.getPlayer();
  const results = new Map();
  
  for (const server of allServers) {
    const maxMoney = ns.getServerMaxMoney(server);
    
    // Skip servers with no money (purchased servers, special servers, etc.)
    if (maxMoney <= 0) continue;
    
    // Skip n00dles - too low max money, not worth boosting
    if (server === "n00dles") continue;
    
    const reqLevel = ns.getServerRequiredHackingLevel(server);
    
    // Get timing info - use server at min security for accurate timing
    const serverObj = ns.getServer(server);
    serverObj.hackDifficulty = serverObj.minDifficulty; // Simulate prepped state
    
    const hackTime = ns.formulas.hacking.hackTime(serverObj, player);
    const growTime = ns.formulas.hacking.growTime(serverObj, player);
    const weakenTime = ns.formulas.hacking.weakenTime(serverObj, player);
    
    // Cycle time = max of all times + 0.3s buffer for thread layering
    const cycleTimeMs = Math.max(hackTime, growTime, weakenTime) + 300;
    const cycleTimeSec = cycleTimeMs / 1000;
    
    // Value = 95% of max money per cycle time
    const value = (maxMoney * 0.95) / cycleTimeSec;
    
    results.set(server, {
      server,
      maxMoney,
      cycleTime: cycleTimeSec,
      value,
      reqLevel
    });
  }
  
  return results;
}

/**
 * Calculate the "efficiency" of each hackable server (value per thread)
 * 
 * Efficiency = value / weighted_average_threads
 * 
 * Where weighted_average_threads accounts for:
 * - Hack threads + weaken threads to go from 100% to 5% money and restore security
 * - Grow threads + weaken threads to go from 5% to 100% money and restore security
 * - Weighted by hack time vs grow time (longer operations need more sustained threads)
 * 
 * This metric is ideal for RAM-constrained scenarios where we want max $/sec/thread.
 * 
 * @param {NS} ns
 * @returns {Map<string, {server: string, value: number, efficiency: number, hackThreads: number, growThreads: number, weakenThreads: number, reqLevel: number}>}
 */
export function getServerEfficiencies(ns) {
  const serverValues = getServerValues(ns);
  const player = ns.getPlayer();
  const results = new Map();
  
  // Constants for thread calculation
  const HACK_SECURITY_INCREASE = 0.002;  // Per thread
  const GROW_SECURITY_INCREASE = 0.004;  // Per thread
  const WEAKEN_SECURITY_DECREASE = 0.05; // Per thread
  
  for (const [server, data] of serverValues) {
    const serverObj = ns.getServer(server);
    serverObj.hackDifficulty = serverObj.minDifficulty; // Prepped state
    serverObj.moneyAvailable = serverObj.moneyMax;      // Full money
    
    // Calculate hack percent per thread
    const hackPercent = ns.formulas.hacking.hackPercent(serverObj, player);
    
    // Threads to hack from 100% to 5% (take 95%)
    const hackThreads = Math.ceil(0.95 / Math.max(hackPercent, 0.0001));
    
    // Security increase from hacking
    const hackSecurityIncrease = hackThreads * HACK_SECURITY_INCREASE;
    const weakenThreadsForHack = Math.ceil(hackSecurityIncrease / WEAKEN_SECURITY_DECREASE);
    
    // Calculate grow threads to go from 5% to 100% (need 20x multiplier)
    // Using formulas to get accurate thread count
    serverObj.moneyAvailable = serverObj.moneyMax * 0.05; // Simulate post-hack state
    const growThreads = Math.ceil(ns.formulas.hacking.growThreads(serverObj, player, serverObj.moneyMax));
    
    // Security increase from growing
    const growSecurityIncrease = growThreads * GROW_SECURITY_INCREASE;
    const weakenThreadsForGrow = Math.ceil(growSecurityIncrease / WEAKEN_SECURITY_DECREASE);
    
    // Total threads for each phase
    const hackPhaseThreads = hackThreads + weakenThreadsForHack;
    const growPhaseThreads = growThreads + weakenThreadsForGrow;
    
    // Get timing for weighting
    serverObj.hackDifficulty = serverObj.minDifficulty;
    serverObj.moneyAvailable = serverObj.moneyMax;
    const hackTime = ns.formulas.hacking.hackTime(serverObj, player);
    const growTime = ns.formulas.hacking.growTime(serverObj, player);
    
    // Weight by time (longer operations tie up threads longer)
    const totalTime = hackTime + growTime;
    const hackWeight = hackTime / totalTime;
    const growWeight = growTime / totalTime;
    
    // Weighted average threads
    const weightedThreads = (hackPhaseThreads * hackWeight) + (growPhaseThreads * growWeight);
    
    // Efficiency = value per thread
    const efficiency = data.value / Math.max(weightedThreads, 1);
    
    results.set(server, {
      server,
      value: data.value,
      efficiency,
      hackThreads,
      growThreads,
      weakenThreadsForHack,
      weakenThreadsForGrow,
      totalThreads: hackPhaseThreads + growPhaseThreads,
      reqLevel: data.reqLevel
    });
  }
  
  return results;
}

/**
 * Calculate the XP efficiency of each hackable server (XP per thread per second)
 * 
 * In Bitburner, hack/grow/weaken all give the same XP per thread based on server difficulty.
 * XP = baseDifficulty * hackExpMult * bitnodeMults (via ns.formulas.hacking.hackExp)
 * 
 * XP Efficiency = hackExp / cycleTime
 * 
 * This gives XP per thread per second, useful for optimizing hacking XP gain.
 * Higher difficulty servers give more XP but also take longer - this metric
 * finds the optimal balance.
 * 
 * @param {NS} ns
 * @returns {Map<string, {server: string, xpPerThread: number, cycleTime: number, xpEfficiency: number, reqLevel: number}>}
 */
export function getServerXPEfficiencies(ns) {
  const allServers = getAllServers(ns);
  const player = ns.getPlayer();
  const results = new Map();
  
  for (const server of allServers) {
    const maxMoney = ns.getServerMaxMoney(server);
    
    // Skip servers with no money (purchased servers, special servers, etc.)
    if (maxMoney <= 0) continue;
    
    const reqLevel = ns.getServerRequiredHackingLevel(server);
    
    // Get server at min security for accurate calculations
    const serverObj = ns.getServer(server);
    serverObj.hackDifficulty = serverObj.minDifficulty; // Simulate prepped state
    
    // XP per thread (same for hack, grow, weaken)
    const xpPerThread = ns.formulas.hacking.hackExp(serverObj, player);
    
    // Get timing info
    const hackTime = ns.formulas.hacking.hackTime(serverObj, player);
    const growTime = ns.formulas.hacking.growTime(serverObj, player);
    const weakenTime = ns.formulas.hacking.weakenTime(serverObj, player);
    
    // Cycle time = max of all times + 0.3s buffer for thread layering
    const cycleTimeMs = Math.max(hackTime, growTime, weakenTime) + 300;
    const cycleTimeSec = cycleTimeMs / 1000;
    
    // XP efficiency = XP per thread per second
    // Since all operations give the same XP, this is simply xpPerThread / cycleTime
    const xpEfficiency = xpPerThread / cycleTimeSec;
    
    results.set(server, {
      server,
      xpPerThread,
      cycleTime: cycleTimeSec,
      xpEfficiency,
      reqLevel,
      baseDifficulty: serverObj.baseDifficulty,
      minDifficulty: serverObj.minDifficulty
    });
  }
  
  return results;
}

/**
 * Estimate the max hacking level achievable in this reset
 * 
 * CONSERVATIVE approach: It's much better to pick a lower-tier reachable server
 * than to pick a high-tier server we can't reach. Unreachable servers waste
 * all the hashes spent on max money/min security boosts.
 * 
 * Strategy:
 * - Project to hour 4 (short horizon = more reliable)
 * - Use pessimistic decay factor (XP requirements grow exponentially)
 * - If we're past hour 4, just use current level (we have real data)
 * 
 * @param {NS} ns
 * @returns {number}
 */
function estimateMaxHackingLevel(ns) {
  const player = ns.getPlayer();
  const currentLevel = player.skills.hacking;
  
  // Short projection horizon - only project to hour 4
  // This gives us a reliable estimate without wild speculation
  const PROJECTION_HORIZON_HOURS = 4;
  
  // Conservative decay - XP requirements grow exponentially
  // At higher levels, each level takes significantly more XP
  const DECAY_FACTOR = 0.15;  // Very conservative
  
  // Calculate time since last aug reset
  const lastAugReset = getLastAugReset(ns);
  const hoursElapsed = (Date.now() - lastAugReset) / (1000 * 60 * 60);
  
  // If we're past the projection horizon, just use current level
  // We have real data - no need to speculate
  if (hoursElapsed >= PROJECTION_HORIZON_HOURS) {
    return currentLevel;
  }
  
  // Avoid division by zero in very early game (< 1 minute)
  if (hoursElapsed < 0.017) {  // ~1 minute
    return currentLevel;
  }
  
  // Calculate current leveling rate
  const currentRate = currentLevel / hoursElapsed;  // levels per hour
  
  // Project to hour 4 only (short, reliable horizon)
  const remainingHours = PROJECTION_HORIZON_HOURS - hoursElapsed;
  const projectedGain = currentRate * remainingHours * DECAY_FACTOR;
  const estimatedMax = Math.floor(currentLevel + projectedGain);
  
  // Never estimate lower than current level
  return Math.max(currentLevel, estimatedMax);
}

/**
 * Select the best server for hacknet max money and min security boosts
 * 
 * Criteria:
 * - Must NOT be n00dles (too low max money, soft cap makes it worthless)
 * - Must be reachable (required hacking level <= estimated max level)
 * - Should have high max money potential
 * - Should be from priority targets (known good servers)
 * - Stable for entire reset (won't change mid-run)
 * 
 * The max money upgrade is percentage-based (2% per hash) but hits a severe
 * soft cap at $10T where returns drop to 0.04%. We want a server that:
 * 1. Has high enough base max money to be worth boosting
 * 2. Is reachable within the reset
 * 
 * @param {NS} ns
 * @returns {string}
 */
export function getBestHacknetBoostTarget(ns) {
  // Minimum time before we commit to a cached target
  // Allows leveling rate to stabilize (e.g., after starting studying loop)
  const MIN_HOURS_BEFORE_CACHE = 1;
  
  // ALWAYS check elapsed time FIRST - this is the gate for early reset
  const hoursElapsed = (Date.now() - getLastAugReset(ns)) / (1000 * 60 * 60);
  
  if (hoursElapsed < MIN_HOURS_BEFORE_CACHE && estimateMaxHackingLevel(ns) < 1500) {
    // Too early - return null to signal "not ready yet"
    // Callers should skip boost actions when target is null
    // Clear any stale caches (memory and file)
    if (cachedHacknetBoostTarget) {
      cachedHacknetBoostTarget = null;
      cachedHacknetBoostTargetResetTime = 0;
    }
    if (ns.fileExists(HACKNET_BOOST_TARGET_FILE, 'home')) {
      ns.rm(HACKNET_BOOST_TARGET_FILE, 'home');
      ns.print(`[SERVER-UTILS] Cleared stale hacknet target cache from previous reset`);
    }
    ns.print(`[SERVER-UTILS] Too early to select hacknet target (${hoursElapsed.toFixed(2)}h < ${MIN_HOURS_BEFORE_CACHE}h)`);
    return null;
  }
  
  // Check memory cache - but validate it's from current reset
  if (cachedHacknetBoostTarget && cachedHacknetBoostTargetResetTime === getLastAugReset(ns)) {
    return cachedHacknetBoostTarget;
  }
  
  // Memory cache invalid or missing - check file cache
  // File cache validates reset time internally via selectedAt timestamp
  const fileTarget = readHacknetBoostTarget(ns);
  if (fileTarget) {
    cachedHacknetBoostTarget = fileTarget;
    cachedHacknetBoostTargetResetTime = getLastAugReset(ns);
    return cachedHacknetBoostTarget;
  }
  
  // Clear stale file cache if it exists but wasn't valid
  if (ns.fileExists(HACKNET_BOOST_TARGET_FILE, 'home')) {
    ns.rm(HACKNET_BOOST_TARGET_FILE, 'home');
  }
  
  // Need to select a new target
  const estimatedMaxLevel = estimateMaxHackingLevel(ns);
  
  // Get all server values dynamically (accounts for randomized stats each reset)
  const serverValues = getServerValues(ns);
  
  // Filter to reachable servers and sort by value (highest first)
  const reachableServers = Array.from(serverValues.values())
    .filter(s => s.reqLevel <= estimatedMaxLevel)
    .sort((a, b) => b.value - a.value);
  
  if (reachableServers.length > 0) {
    const best = reachableServers[0];
    cachedHacknetBoostTarget = best.server;
    cachedHacknetBoostTargetResetTime = getLastAugReset(ns);
    writeHacknetBoostTarget(ns, cachedHacknetBoostTarget);
    ns.print(`[SERVER-UTILS] Selected hacknet boost target: ${cachedHacknetBoostTarget}`);
    ns.print(`  → Value: $${ns.formatNumber(best.value)}/s, MaxMoney: $${ns.formatNumber(best.maxMoney)}, ReqLevel: ${best.reqLevel}`);
    ns.print(`  → Est max level: ${estimatedMaxLevel}, Cycle time: ${best.cycleTime.toFixed(1)}s`);
    return cachedHacknetBoostTarget;
  }
  
  // Fallback to joesguns if somehow nothing else matched
  // This should only happen very early in a reset
  cachedHacknetBoostTarget = "joesguns";
  cachedHacknetBoostTargetResetTime = getLastAugReset(ns);
  writeHacknetBoostTarget(ns, cachedHacknetBoostTarget);
  ns.print(`[SERVER-UTILS] Fallback hacknet boost target: joesguns (no reachable servers found)`);
  return cachedHacknetBoostTarget;
}

/**
 * Clear the hacknet boost target cache (for testing or after augmentation)
 * Call this after installing augmentations to re-evaluate the target
 * @param {NS} ns
 */
export function clearHacknetBoostTargetCache(ns) {
  cachedHacknetBoostTarget = null;
  cachedHacknetBoostTargetResetTime = 0;
  if (ns.fileExists(HACKNET_BOOST_TARGET_FILE, 'home')) {
    ns.rm(HACKNET_BOOST_TARGET_FILE, 'home');
  }
}

/**
 * Get info about the current hacknet boost target selection
 * @param {NS} ns
 * @returns {{target: string, estimatedMaxLevel: number, targetReqLevel: number, value: number}}
 */
export function getHacknetBoostTargetInfo(ns) {
  const target = getBestHacknetBoostTarget(ns);
  const estimatedMaxLevel = estimateMaxHackingLevel(ns);
  const targetReqLevel = target ? ns.getServerRequiredHackingLevel(target) : 0;
  
  // Get value info if target exists
  let value = 0;
  if (target) {
    const serverValues = getServerValues(ns);
    const targetData = serverValues.get(target);
    if (targetData) {
      value = targetData.value;
    }
  }
  
  return {
    target,
    estimatedMaxLevel,
    targetReqLevel,
    value,
    reachable: targetReqLevel <= estimatedMaxLevel
  };
}