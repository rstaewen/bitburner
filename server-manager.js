/** @param {NS} ns */

/**
 * server-manager.js - Persistent server management
 * 
 * Replaces server-upgrader.js with:
 * - Persistent responsibility (doesn't exit on saturation)
 * - Sticky sleep behavior (sleep after saturation, wake when needed)
 * - Spawns hacknet-manager.js when hacknets are available
 * - Handles BN9 special case (no regular servers)
 */

import {
  getNexusHost,
  getNexusDefaultName,
  getNexusTargetRam,
  getNexusInfo,
  copyScriptsToNexus,
  canPurchaseServers,
  canPurchaseHacknets,
  hasHacknetServers,
  isHacknetBitNode,
  execSingleton
} from "utils/server-utils.js";

import { isRamSaturated } from "utils/ram.js";

import { getCurrentNode } from "utils/bitnode-cache.js"

// Configuration
const CONFIG = {
  MIN_RAM: 2,                    // Minimum RAM for new servers (2GB)
  CYCLE_DELAY_MS: 5000,          // 5 seconds between cycles
  SATURATION_THRESHOLD_MS: 60000, // 1 minute before entering sleep mode
  WAKE_THRESHOLD_MS: 60000,       // 1 minute of non-saturation before waking
  HACKNET_MANAGER_SCRIPT: "hacknet-manager.js",
  HACKING_ORCHESTRATOR_SCRIPT: "orchestratorv2.js",
  NEXUS_SCRIPT: "nexus.js",
};

// State tracking
let saturatedSince = null;
let unsaturatedSince = null;
let isSleeping = false;
let nexusSetupComplete = false;
let nexusScriptsLaunched = false;
let hacknetManagerSpawned = false;

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
 * Priority: Upgrade nexus to target RAM first, then optimize cost/RAM
 * @param {NS} ns
 * @returns {{type: "buy"|"upgrade", cost: number, ram: number, server?: string, currentRam?: number, priority?: boolean} | null}
 */
function findBestAction(ns) {
  const money = ns.getServerMoneyAvailable("home");
  const servers = ns.getPurchasedServers();
  const maxServers = ns.getPurchasedServerLimit();
  const maxRam = ns.getPurchasedServerMaxRam();
  
  // Check if nexus exists and needs upgrading
  const nexusServer = getNexusHost(ns, 0);
  if (nexusServer) {
    const nexusRam = ns.getServerMaxRam(nexusServer);
    const targetRam = getNexusTargetRam(ns);
    
    // If nexus is below target RAM, prioritize upgrading it
    if (nexusRam < targetRam && nexusRam < maxRam) {
      const nextRam = getNextRamTier(nexusRam);
      const upgradeCost = ns.getPurchasedServerUpgradeCost(nexusServer, nextRam);
      
      if (upgradeCost <= money && upgradeCost > 0) {
        return {
          type: "upgrade",
          cost: upgradeCost,
          ram: nextRam,
          server: nexusServer,
          currentRam: nexusRam,
          priority: true
        };
      }
      
      // Can't afford nexus upgrade yet, return null to wait
      return null;
    }
  }
  
  // Nexus is ready (or doesn't exist yet), proceed with normal cost/RAM optimization
  let bestAction = null;
  let bestCostPerRam = Infinity;
  
  // Option 1: Buy a new server (if we haven't hit the limit)
  if (servers.length < maxServers) {
    const buyCost = ns.getPurchasedServerCost(CONFIG.MIN_RAM);
    if (buyCost <= money) {
      const costPerRam = buyCost / CONFIG.MIN_RAM;
      if (costPerRam < bestCostPerRam) {
        bestCostPerRam = costPerRam;
        bestAction = {
          type: "buy",
          cost: buyCost,
          ram: CONFIG.MIN_RAM
        };
      }
    }
  }
  
  // Option 2: Upgrade an existing server
  for (const server of servers) {
    const currentRam = ns.getServerMaxRam(server);
    const nextRam = getNextRamTier(currentRam);
    
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
  return ns.getPurchasedServers().reduce((sum, s) => sum + ns.getServerMaxRam(s), 0);
}

/**
 * Check if all servers are maxed out
 * @param {NS} ns
 * @returns {boolean}
 */
function areAllServersMaxed(ns) {
  const servers = ns.getPurchasedServers();
  const maxServers = ns.getPurchasedServerLimit();
  const maxRam = ns.getPurchasedServerMaxRam();
  
  if (servers.length < maxServers) return false;
  
  for (const server of servers) {
    if (ns.getServerMaxRam(server) < maxRam) return false;
  }
  
  return true;
}

function ensureHackingOrchestrator(ns) {
  const nexusInfo = getNexusInfo(ns);
  const isBN9 = isHacknetBitNode(ns);

  if (ns.isRunning(CONFIG.HACKING_ORCHESTRATOR_SCRIPT, "home")) {
    return true;
  }

  if (nexusInfo.server && ns.isRunning(CONFIG.HACKING_ORCHESTRATOR_SCRIPT, nexusInfo.server)) {
    return true;
  }

  if (isBN9) {
    if (nexusInfo.ready && nexusInfo.server) {
      copyScriptsToNexus(ns, nexusInfo.server);
      const pid = ns.exec(CONFIG.HACKING_ORCHESTRATOR_SCRIPT, nexusInfo.server, 1);
      if (pid > 0) {
        ns.print(`[ORCHESTRATOR] Spawned on ${nexusInfo.server} (BN9 mode), pid:[${pid}]`);
        return true;
      }
    }
    ns.print(`[ORCHESTRATOR] Waiting for nexus to be ready (BN9 mode)`);
    return false;
  }

  if (ns.fileExists(CONFIG.HACKING_ORCHESTRATOR_SCRIPT, "home")) {
    const pid = execSingleton(ns, CONFIG.HACKING_ORCHESTRATOR_SCRIPT, "home", false);
    if (pid > 0) {
      ns.print(`[ORCHESTRATOR] Spawned on home, pid:[${pid}]`);
      return true;
    }
    ns.print(`[ORCHESTRATOR] Failed to spawn on home - insufficient RAM`);
  }

  return false;
}

function isHacknetManagerRunningAnywhere(ns) {
  if (ns.isRunning(CONFIG.HACKNET_MANAGER_SCRIPT, "home")) {
    return "home";
  }

  for (const server of ns.getPurchasedServers()) {
    if (ns.isRunning(CONFIG.HACKNET_MANAGER_SCRIPT, server)) {
      return server;
    }
  }

  if (hasHacknetServers(ns)) {
    try {
      const nodes = ns.hacknet.numNodes();
      for (let i = 0; i < nodes; i++) {
        const hostname = `hacknet-server-${i}`;
        if (ns.serverExists(hostname) && ns.isRunning(CONFIG.HACKNET_MANAGER_SCRIPT, hostname)) {
          return hostname;
        }
      }
    } catch {
      // hacknet API not available
    }
  }

  return null;
}

/**
 * Spawn hacknet manager if not already running
 * @param {NS} ns
 * @returns {boolean} Whether spawn was successful or already running
 */
function ensureHacknetManager(ns) {
  if (hacknetManagerSpawned) {
    return true;
  }

  const existingHost = isHacknetManagerRunningAnywhere(ns);
  if (existingHost) {
    hacknetManagerSpawned = true;
    ns.print(`[MANAGER] hacknet-manager already running on ${existingHost}`);
    return true;
  }

  const nexusInfo = getNexusInfo(ns);
  const nexus = getNexusHost(ns, 64);
  const homeRamFree = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
  const hacknetRamCost = ns.getScriptRam(CONFIG.HACKNET_MANAGER_SCRIPT);

  if (nexusInfo.ready && nexus) {
    const nexusRamFree = ns.getServerMaxRam(nexus) - ns.getServerUsedRam(nexus);
    if (nexusRamFree >= hacknetRamCost && ns.fileExists(CONFIG.HACKNET_MANAGER_SCRIPT, nexus)) {
      const pid = ns.exec(CONFIG.HACKNET_MANAGER_SCRIPT, nexus, 1);
      if (pid > 0) {
        ns.print(`[MANAGER] Spawned hacknet-manager on ${nexus} (PID: ${pid})`);
        hacknetManagerSpawned = true;
        return true;
      }
    }
  }

  if (homeRamFree >= hacknetRamCost && ns.fileExists(CONFIG.HACKNET_MANAGER_SCRIPT, "home")) {
    const pid = ns.exec(CONFIG.HACKNET_MANAGER_SCRIPT, "home", 1);
    if (pid > 0) {
      ns.print(`[MANAGER] Spawned hacknet-manager on home (PID: ${pid})`);
      hacknetManagerSpawned = true;
      return true;
    }
  }

  ns.print(`[MANAGER] Cannot spawn hacknet-manager yet - insufficient RAM`);
  ns.print(`  Home free: ${ns.formatRam(homeRamFree)}, Nexus ready: ${nexusInfo.ready}, Need: ${ns.formatRam(hacknetRamCost)}`);
  return false;
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
  const nexusInfo = getNexusInfo(ns);
  
  ns.print("═══════════════════════════════════════════");
  ns.print("           SERVER MANAGER                  ");
  ns.print("═══════════════════════════════════════════");
  ns.print("");
  
  // BitNode info
  if (isHacknetBitNode(ns)) {
    ns.print("🌐 BitNode 9: Hacknet Mode");
  }
  
  // State indicator
  if (isSleeping) {
    ns.print("😴 STATE: Sleeping (RAM saturated)");
  } else if (areAllServersMaxed(ns)) {
    ns.print("✅ STATE: Complete (all maxed)");
  } else {
    ns.print("🔄 STATE: Active");
  }
  ns.print("");
  
  ns.print(`💰 Available: $${ns.formatNumber(money)}`);
  ns.print(`🖥️  Servers: ${servers.length}/${maxServers}`);
  ns.print(`📊 Total RAM: ${ns.formatRam(totalRam)}`);
  
  // Nexus status
  if (nexusInfo.server) {
    const statusIcon = nexusInfo.ready ? "✅" : "⏳";
    const statusText = nexusInfo.ready 
      ? "READY" 
      : `${ns.formatRam(nexusInfo.ram)}/${ns.formatRam(nexusInfo.targetRam)}`;
    ns.print(`${statusIcon} Nexus (${nexusInfo.server}): ${statusText}`);
  } else {
    ns.print("⏳ Nexus: Not yet purchased");
  }
  
  // Hacknet manager status
  if (canPurchaseHacknets(ns)) {
    const hacknetStatus = hacknetManagerSpawned ? "✅ Running" : "⏳ Pending";
    ns.print(`🔗 Hacknet Manager: ${hacknetStatus}`);
  }
  ns.print("");

  // RAM analysis
  ns.print("─── RAM STATUS ───");
  const homeRamTotal = ns.getServerMaxRam("home");
  const homeRamUsed = ns.getServerUsedRam("home");
  const homeRamFree = homeRamTotal - homeRamUsed;
  const orchestratorRam = ns.getScriptRam(CONFIG.HACKING_ORCHESTRATOR_SCRIPT);
  const hacknetRam = ns.getScriptRam(CONFIG.HACKNET_MANAGER_SCRIPT);
  const serverMgrRam = ns.getScriptRam("server-manager.js");
  ns.print(`  Home: ${ns.formatRam(homeRamUsed)}/${ns.formatRam(homeRamTotal)} (${ns.formatRam(homeRamFree)} free)`);
  ns.print(`  Scripts: orch=${ns.formatRam(orchestratorRam)}, hacknet=${ns.formatRam(hacknetRam)}, srvmgr=${ns.formatRam(serverMgrRam)}`);
  const canFitOrchestrator = homeRamFree >= orchestratorRam;
  const canFitHacknet = homeRamFree >= hacknetRam;
  ns.print(`  Can fit: orchestrator=${canFitOrchestrator ? '✅' : '❌'}, hacknet=${canFitHacknet ? '✅' : '❌'}`);
  ns.print("");
  
  // Server RAM tiers
  ns.print("─── SERVER RAM ───");
  if (servers.length === 0) {
    ns.print("  (no servers purchased)");
  } else {
    const ramTiers = new Map();
    for (const server of servers) {
      const ram = ns.getServerMaxRam(server);
      ramTiers.set(ram, (ramTiers.get(ram) || 0) + 1);
    }
    
    const sortedTiers = [...ramTiers.entries()].sort((a, b) => b[0] - a[0]);
    for (const [ram, count] of sortedTiers) {
      const maxedOut = ram >= maxRam ? " (MAX)" : "";
      ns.print(`  ${ns.formatRam(ram)}: ${count} server${count > 1 ? 's' : ''}${maxedOut}`);
    }
  }
  
  // Next action
  ns.print("");
  ns.print("─── NEXT ACTION ───");
  
  if (isSleeping) {
    ns.print("  💤 Sleeping until RAM needed...");
  } else if (!canPurchaseServers(ns)) {
    ns.print("  ⚠️ Cannot purchase servers in this BitNode");
  } else {
    const nextAction = findBestAction(ns);
    if (nextAction) {
      if (nextAction.type === "buy") {
        const serverName = servers.length === 0 ? getNexusDefaultName(ns) : `pserv-${servers.length}`;
        ns.print(`  BUY "${serverName}" (${ns.formatRam(nextAction.ram)}) for $${ns.formatNumber(nextAction.cost)}`);
      } else {
        const priorityTag = nextAction.priority ? " [PRIORITY]" : "";
        ns.print(`  UPGRADE ${nextAction.server}: ${ns.formatRam(nextAction.currentRam)}→${ns.formatRam(nextAction.ram)}${priorityTag}`);
        ns.print(`  Cost: $${ns.formatNumber(nextAction.cost)}`);
      }
    } else if (areAllServersMaxed(ns)) {
      ns.print("  ✅ All servers at maximum RAM!");
    } else {
      ns.print("  ⏳ Waiting for funds...");
      
      // Show what we're waiting for if nexus isn't ready
      if (!nexusInfo.ready && nexusInfo.server) {
        const nextRam = getNextRamTier(nexusInfo.ram);
        const cost = ns.getPurchasedServerUpgradeCost(nexusInfo.server, nextRam);
        ns.print(`  Need $${ns.formatNumber(cost)} for nexus upgrade`);
      }
    }
  }
  
  ns.print("");
  ns.print(`Last update: ${new Date().toLocaleTimeString()}`);
}

/**
 * Handle nexus becoming ready - launch nexus scripts
 * @param {NS} ns
 */
async function onNexusReady(ns) {
  const nexusInfo = getNexusInfo(ns);
  
  ns.print("");
  ns.print("═══════════════════════════════════════════");
  ns.print("🎉 NEXUS IS READY!");
  ns.print("═══════════════════════════════════════════");
  ns.print(`${nexusInfo.server} has reached ${ns.formatRam(nexusInfo.ram)} RAM`);
  ns.print("");
  
  // Kill any existing scripts on nexus to start fresh
  ns.killall(nexusInfo.server, true);
  await ns.sleep(1000);
  
  // Launch the main nexus script
  if (ns.fileExists(CONFIG.NEXUS_SCRIPT, nexusInfo.server)) {
    ns.exec(CONFIG.NEXUS_SCRIPT, nexusInfo.server, 1);
    ns.print(`[MANAGER] Launched ${CONFIG.NEXUS_SCRIPT} on ${nexusInfo.server}`);
  } else {
    ns.print(`[MANAGER] Warning: ${CONFIG.NEXUS_SCRIPT} not found on ${nexusInfo.server}`);
  }
  
  nexusScriptsLaunched = true;
}

/**
 * Main entry point
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();
  
  ns.print("Starting Server Manager...");
  ns.print(`BitNode: ${getCurrentNode(ns)}`);
  ns.print(`Can purchase servers: ${canPurchaseServers(ns)}`);
  ns.print(`Can purchase hacknets: ${canPurchaseHacknets(ns)}`);
  ns.print(`Nexus target RAM: ${ns.formatRam(getNexusTargetRam(ns))}`);
  ns.print("");

  await ns.sleep(1000);
  
  // Special handling for BN9 (or when servers aren't purchasable)
  if (!canPurchaseServers(ns)) {
    ns.print("⚠️ Cannot purchase servers in this BitNode");
    
    if (canPurchaseHacknets(ns)) {
      ns.print("Spawning hacknet manager and exiting...");
      ensureHacknetManager(ns);
      await ns.sleep(2000);
    }
    
    ns.print("Server Manager shutting down (no work to do)");
    return;
  }
  
  // Spawn hacknet manager if available
  if (canPurchaseHacknets(ns)) {
    ensureHacknetManager(ns);
  }
  
  // Spawn hacking orchestrator if needed
  ensureHackingOrchestrator(ns);
  
  // Main loop
  while (true) {
    const servers = ns.getPurchasedServers();
    const nexusInfo = getNexusInfo(ns);

    if (canPurchaseHacknets(ns) && !hacknetManagerSpawned) {
      ensureHacknetManager(ns);
    }
    
    // Check if nexus just became ready
    if (nexusInfo.ready && !nexusScriptsLaunched) {
      await onNexusReady(ns);
    }
    
    // Setup nexus with scripts when first purchased
    if (nexusInfo.server && !nexusSetupComplete) {
      copyScriptsToNexus(ns, nexusInfo.server);
      nexusSetupComplete = true;
    }
    
    // Check RAM saturation for sticky sleep behavior
    const saturated = isRamSaturated(ns);
    const now = Date.now();
    
    if (saturated) {
      unsaturatedSince = null;
      if (!saturatedSince) {
        saturatedSince = now;
      }
      
      // Enter sleep mode after threshold
      if (!isSleeping && (now - saturatedSince >= CONFIG.SATURATION_THRESHOLD_MS)) {
        isSleeping = true;
        ns.print("😴 Entering sleep mode (RAM saturated)");
      }
    } else {
      saturatedSince = null;
      if (!unsaturatedSince) {
        unsaturatedSince = now;
      }
      
      // Wake up after threshold
      if (isSleeping && (now - unsaturatedSince >= CONFIG.WAKE_THRESHOLD_MS)) {
        isSleeping = false;
        ns.print("🌅 Waking up (RAM needed)");
      }
    }
    
    // Skip buying if sleeping
    if (!isSleeping) {
      const action = findBestAction(ns);
      
      if (action) {
        if (action.type === "buy") {
          const existingNexus = getNexusHost(ns, 0);
          const desiredName = !existingNexus 
            ? getNexusDefaultName(ns) 
            : `pserv-${servers.length}`;
          
          const hostname = ns.purchaseServer(desiredName, action.ram);
          
          if (hostname) {
            ns.print(`[+] Purchased ${hostname} with ${ns.formatRam(action.ram)}`);
            
            // Setup nexus if this is it
            if (!nexusSetupComplete && hostname.includes(getNexusDefaultName(ns))) {
              await ns.sleep(100);
              copyScriptsToNexus(ns, hostname);
              nexusSetupComplete = true;
            }
          }
        } else if (action.type === "upgrade") {
          const success = ns.upgradePurchasedServer(action.server, action.ram);
          if (success) {
            ns.print(`[+] Upgraded ${action.server} to ${ns.formatRam(action.ram)}`);
            
            // Refresh nexus scripts after upgrade
            if (action.server === nexusInfo.server) {
              await ns.sleep(100);
              copyScriptsToNexus(ns, action.server);
            }
          }
        }
      }
    }
    
    // Print status
    printStatus(ns);
    
    // Check if completely done (all maxed)
    // In BN9, we never "complete" because hacknet manager handles things
    if (areAllServersMaxed(ns) && !isHacknetBitNode(ns) && nexusScriptsLaunched) {
      ns.print("");
      ns.print("🎉 All servers purchased and maxed out!");
      ns.print("Server Manager entering maintenance mode...");
      
      // Stay alive but check less frequently
      await ns.sleep(60000);
      continue;
    }
    
    await ns.sleep(CONFIG.CYCLE_DELAY_MS);
  }
}