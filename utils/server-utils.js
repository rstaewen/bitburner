/** @param {NS} ns */

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
const NEXUS_TARGET_RAM_BASE = 512; // GB - base target before SF4 multipliers

/**
 * Check if we're in BitNode 9 (Hacktocracy)
 * @param {NS} ns
 * @returns {boolean}
 */
export function isHacknetBitNode(ns) {
  return ns.getResetInfo().currentNode === 9;
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
  const currentNode = ns.getResetInfo().currentNode;
  const sf9Level = ns.getResetInfo().ownedSF[9] || 0;
  return currentNode === 9 || sf9Level > 0;
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
 * Get the SF4 (Singularity) source file level
 * @param {NS} ns
 * @returns {number}
 */
function getSF4Level(ns) {
  const ownedSF = ns.getResetInfo().ownedSF;
  
  // ownedSF is a Map, not a plain object
  if (ownedSF instanceof Map) {
    return ownedSF.get(4) ?? 0;
  }
  
  // Fallback for potential future API changes
  if (ownedSF && typeof ownedSF === 'object') {
    return ownedSF[4] ?? ownedSF["4"] ?? 0;
  }
  
  return 0;
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
  const currentNode = ns.getResetInfo().currentNode;
  const sf4Level = getSF4Level(ns);
  
  // In BN4, no penalty
  if (currentNode === 4) return 1;
  
  // SF4 levels reduce the RAM cost
  // These are the actual game multipliers
  switch (sf4Level) {
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
 * Find the best hacknet server to use as nexus in BN9
 * Criteria: Largest RAM with smallest level/cores (least "upgraded" for hash production)
 * @param {NS} ns
 * @returns {string|null}
 */
function findBestHacknetNexus(ns) {
  if (!hasHacknetServers(ns)) return null;
  
  const numNodes = ns.hacknet.numNodes();
  if (numNodes === 0) return null;
  
  let bestServer = null;
  let bestScore = -Infinity;
  
  for (let i = 0; i < numNodes; i++) {
    const hostname = `hacknet-server-${i}`;
    const stats = ns.hacknet.getNodeStats(i);
    
    // We want: high RAM, low level, low cores
    // Score = RAM / (level * cores) - higher is better for nexus role
    // More RAM = more scripts we can run
    // Lower level/cores = less valuable for hash production
    const ram = stats.ram;
    const productionValue = stats.level * stats.cores;
    
    // Only consider servers with enough RAM for nexus role
    if (ram < 64) continue; // Minimum useful RAM
    
    const score = ram / Math.max(1, productionValue);
    
    if (score > bestScore) {
      bestScore = score;
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
 * Caches the result until soft reset
 * @param {NS} ns
 * @param {number} minRam - Minimum RAM required (default 0)
 * @returns {string|null}
 */
export function getNexusHost(ns, minRam = 0) {
  // Return cached nexus if still valid
  if (designatedNexus && ns.serverExists(designatedNexus)) {
    const ram = ns.getServerMaxRam(designatedNexus);
    if (ram >= minRam) {
      return designatedNexus;
    }
  }
  
  // In BN9 or with SF9, check hacknet servers first
  if (hasHacknetServers(ns) && !canPurchaseServers(ns)) {
    const hacknetNexus = findBestHacknetNexus(ns);
    if (hacknetNexus) {
      const ram = ns.getServerMaxRam(hacknetNexus);
      if (ram >= minRam) {
        designatedNexus = hacknetNexus;
        nexusDesignatedAt = Date.now();
        return designatedNexus;
      }
    }
  }
  
  // Check purchased servers
  const purchasedNexus = findPurchasedNexus(ns, minRam);
  if (purchasedNexus) {
    designatedNexus = purchasedNexus;
    nexusDesignatedAt = Date.now();
    return designatedNexus;
  }
  
  return null;
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
  return ns.ls("home").filter(f => f.endsWith(".js"));
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