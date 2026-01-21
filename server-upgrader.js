/** @param {NS} ns */

const MIN_RAM = 2;        // Minimum RAM for new servers (2GB)
const CYCLE_DELAY = 5000; // 5 seconds between cycles
const NEXUS_NAME = "nexus"; // Name for the first purchased server
const NEXUS_TARGET_RAM = 512; // Minimum RAM before nexus is considered "ready"

/**
 * Get target ram based on singularity cost (nexus scripts are singularity heavy)
 * @param {NS} ns
 */
export function getNexusTargetRam(ns) {
  const singularitySourceFileLevel = ns.getResetInfo().ownedSF[4];
  const multiplier = ns.getResetInfo().currentNode === 4 ? 1 : singularitySourceFileLevel === 1 ? 4 : singularitySourceFileLevel === 2 ? 4 : singularitySourceFileLevel === 3 ? 2 : undefined;
  return NEXUS_TARGET_RAM * multiplier;
}
/**
 * Get the next RAM tier (double current)
 * @param {number} currentRam
 * @returns {number}
 */
function getNextRamTier(currentRam) {
  return currentRam * 2;
}

/**
 * Recursively get all files and directories from a path
 * @param {NS} ns
 * @param {string} path
 * @returns {string[]} Array of file paths
 */
function getAllFiles(ns, path = "/") {
  const files = [];
  const items = ns.ls("home", path);
  
  for (const item of items.filter(i => i.endsWith(".js"))) {
    
    files.push(item);
  }
  
  return files;
}

/**
 * Set up the nexus server with all home scripts
 * @param {NS} ns
 * @param {string} nexusServer
 */
function setupNexusServer(ns, nexusServer) {
  ns.print(`[NEXUS] Setting up ${nexusServer} as auxiliary script host...`);
  
  // Get all files from home
  const allFiles = getAllFiles(ns);
  
  ns.print(`[NEXUS] Found ${allFiles.length} files to copy`);
  
  // Copy all files to nexus
  const success = ns.scp(allFiles, nexusServer, "home");
  
  if (success) {
    ns.print(`[NEXUS] ✅ Successfully copied all scripts to ${nexusServer}`);
    ns.print(`[NEXUS] ${nexusServer} is now ready to run auxiliary scripts`);
  } else {
    ns.print(`[NEXUS] ⚠️  Some files may not have copied successfully`);
  }
}

/**
 * Get the nexus server name (might be "nexus" or "nexus-0" depending on game version)
 * @param {NS} ns
 * @returns {string|null} The actual nexus server name, or null if not found
 */
function findNexusServer(ns) {
  const servers = ns.getPurchasedServers();
  
  // Check for exact match first
  if (servers.includes(NEXUS_NAME)) {
    return NEXUS_NAME;
  }
  
  // Check for numbered variant (nexus-0)
  if (servers.includes(`${NEXUS_NAME}-0`)) {
    return `${NEXUS_NAME}-0`;
  }
  
  // If we have exactly 1 server and it starts with our prefix, assume it's nexus
  if (servers.length === 1 && servers[0].startsWith(NEXUS_NAME)) {
    return servers[0];
  }
  
  return null;
}

/**
 * Find the best action to take with available money
 * Returns either a purchase action, upgrade action, or null if nothing affordable
 * Priority: Upgrade nexus to target RAM first, then optimize cost/RAM for everything else
 * @param {NS} ns
 * @returns {{type: "buy"|"upgrade", cost: number, ram: number, server?: string} | null}
 */
function findBestAction(ns) {
  const money = ns.getServerMoneyAvailable("home");
  const servers = ns.getPurchasedServers();
  const maxServers = ns.getPurchasedServerLimit();
  const maxRam = ns.getPurchasedServerMaxRam();
  
  // Check if nexus exists and needs upgrading
  const nexusServer = findNexusServer(ns);
  if (nexusServer) {
    const nexusRam = ns.getServerMaxRam(nexusServer);
    
    // If nexus is below target RAM, prioritize upgrading it
    if (nexusRam < getNexusTargetRam(ns) && nexusRam < maxRam) {
      const nextRam = getNextRamTier(nexusRam);
      const upgradeCost = ns.getPurchasedServerUpgradeCost(nexusServer, nextRam);
      
      if (upgradeCost <= money && upgradeCost > 0) {
        return {
          type: "upgrade",
          cost: upgradeCost,
          ram: nextRam,
          server: nexusServer,
          currentRam: nexusRam,
          priority: true  // Mark as priority upgrade
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
  const nexusServer = findNexusServer(ns);
  
  ns.print("═══════════════════════════════════════════");
  ns.print("            SERVER UPGRADER                ");
  ns.print("═══════════════════════════════════════════");
  ns.print("");
  ns.print(`💰 Available: $${ns.formatNumber(money)}`);
  ns.print(`🖥️  Servers: ${servers.length}/${maxServers}`);
  ns.print(`📊 Total RAM: ${ns.formatNumber(totalRam)} GB`);
  
  if (nexusServer) {
    const nexusRam = ns.getServerMaxRam(nexusServer);
    const nexusReady = nexusRam >= getNexusTargetRam(ns);
    const statusIcon = nexusReady ? "✅" : "⏳";
    const statusText = nexusReady ? "READY" : `${ns.formatNumber(nexusRam)}/${ns.formatNumber(getNexusTargetRam(ns))} GB`;
    ns.print(`${statusIcon} Nexus (${nexusServer}): ${statusText}`);
  }
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
      const serverName = servers.length === 0 ? NEXUS_NAME : `pserv-${servers.length}`;
      ns.print(`  BUY new server "${serverName}" (${nextAction.ram} GB) for $${ns.formatNumber(nextAction.cost)}`);
    } else {
      const priorityTag = nextAction.priority ? " [PRIORITY]" : "";
      ns.print(`  UPGRADE ${nextAction.server}: ${ns.formatNumber(nextAction.currentRam)}→${ns.formatNumber(nextAction.ram)} GB${priorityTag}`);
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
    // If we're waiting and nexus isn't ready, show what we're waiting for
    if (nexusServer) {
      const nexusRam = ns.getServerMaxRam(nexusServer);
      if (nexusRam < getNexusTargetRam(ns)) {
        const nextRam = getNextRamTier(nexusRam);
        const cost = ns.getPurchasedServerUpgradeCost(nexusServer, nextRam);
        ns.print(`  Need $${ns.formatNumber(cost)} to upgrade ${nexusServer} to ${ns.formatNumber(nextRam)} GB`);
      }
    }
  }
  
  ns.print("");
  ns.print(`Last update: ${new Date().toLocaleTimeString()}`);
}

//stop buying servers when they're more expensive than a hacking tool we don't have yet
/** @param {NS} ns */
function getMaxServerCost(ns) {
  if (!ns.fileExists("SQLInject.exe", 'home')) {
    return ns.singularity.getDarkwebProgramCost("SQLInject.exe");
  } else {
    return 1e9;
  }
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();
  
  ns.print("Starting Server Upgrader...");
  ns.print(`First server will be named: ${NEXUS_NAME} (may appear as ${NEXUS_NAME}-0)`);
  ns.print(`Nexus target RAM: ${getNexusTargetRam(ns)} GB`);
  ns.print("");
  
  // Check for duplicate nexus situation
  const servers = ns.getPurchasedServers();
  const hasNexus = servers.includes(NEXUS_NAME);
  const hasNexus0 = servers.includes(`${NEXUS_NAME}-0`);
  
  if (hasNexus && hasNexus0) {
    ns.print("⚠️  WARNING: Duplicate nexus servers detected!");
    ns.print(`Found both "${NEXUS_NAME}" and "${NEXUS_NAME}-0"`);
    ns.print("");
    ns.print("Recommended fix:");
    ns.print(`1. Note which one has your scripts/processes running`);
    ns.print(`2. Run: killall; ns.deleteServer("${NEXUS_NAME}") or ns.deleteServer("${NEXUS_NAME}-0")`);
    ns.print(`3. Restart this script`);
    ns.print("");
    ns.print("Continuing anyway - will treat both as nexus...");
    ns.print("");
  }
  
  let serverIndex = 0;
  let nexusSetupComplete = false;
  let nexusScriptsLaunched = false;
  
  while (true) {
    // Check if nexus just became ready and we haven't launched scripts yet
    const servers = ns.getPurchasedServers();
    const nexusServer = findNexusServer(ns);
    
    if (nexusServer && !nexusScriptsLaunched) {
      const nexusRam = ns.getServerMaxRam(nexusServer);
      
      if (nexusRam >= getNexusTargetRam(ns)) {
        ns.print("");
        ns.print("═══════════════════════════════════════════");
        ns.print("🎉 NEXUS IS READY!");
        ns.print("═══════════════════════════════════════════");
        ns.print(`${nexusServer} has reached ${ns.formatNumber(nexusRam)} GB RAM`);
        ns.print("");
        ns.print("You can now run auxiliary scripts on nexus:");
        ns.print("  - Stock trader (~37 GB)");
        ns.print("  - Aug finder (~26 GB)");
        ns.print("  - Sleeve manager (~50-60 GB)");
        ns.print("");
        ns.print("Example commands:");
        ns.print(`  run stock-trader.js --tail`);
        ns.print(`  run find-aug-utility.js --tail`);
        ns.print(`  run sleeve-manager.js --tail`);
        ns.print("");
        ns.killall("nexus", true);
        await ns.sleep(1000);
        ns.print("1");
        await ns.sleep(1000);
        ns.print("2");
        await ns.sleep(1000);
        ns.print("3");
        await ns.sleep(1000);
        ns.exec("nexus.js", "nexus", 1);
        nexusScriptsLaunched = true;
      }
    }
    
    // Find and execute the best action
    const action = findBestAction(ns);
    
    if (action) {
      if (action.type === "buy") {
        // Determine server name based on whether we already have a nexus
        const existingNexus = findNexusServer(ns);
        let desiredName;
        
        if (!existingNexus) {
          // First server ever - this is nexus
          desiredName = NEXUS_NAME;
        } else {
          // We have nexus, so name by total server count (not serverIndex)
          desiredName = `pserv-${servers.length}`;
        }
        
        const hostname = ns.purchaseServer(desiredName, action.ram);
        
        if (hostname) {
          ns.print(`[+] Purchased ${hostname} with ${action.ram} GB RAM`);
          
          // If this is nexus (first time we see it), set it up
          if (!nexusSetupComplete && (hostname === NEXUS_NAME || hostname.startsWith(NEXUS_NAME))) {
            await ns.sleep(100); // Brief delay to ensure server is ready
            setupNexusServer(ns, hostname);
            nexusSetupComplete = true;
          }
          
          serverIndex++;
        }
      } else if (action.type === "upgrade") {
        const success = ns.upgradePurchasedServer(action.server, action.ram);
        if (success) {
          ns.print(`[+] Upgraded ${action.server} to ${ns.formatNumber(action.ram)} GB RAM`);
          
          // If we upgraded nexus, refresh its files
          const currentNexus = findNexusServer(ns);
          if (action.server === currentNexus) {
            await ns.sleep(100);
            setupNexusServer(ns, currentNexus);
          }
        }
      }
    }
    
    // Print status
    printStatus(ns);
    
    // Check if we're done (all servers at max RAM)
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
        const finalNexus = findNexusServer(ns);
        if (finalNexus) {
          ns.print(`🎯 ${finalNexus} is ready for auxiliary scripts`);
        }
        ns.print("Script complete.");
        return;
      }
    }
    
    await ns.sleep(CYCLE_DELAY);
  }
}