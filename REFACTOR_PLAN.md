# Bitburner Codebase Refactoring Plan

## Current Bootstrap Chain
```
start.js (10 GB) -> cache-bitnode-mults.js (run once, exits)
start.js (10 GB) -> server-manager.js (13.15 GB) (singleton on home)
start.js closes, RAM freed

server-manager.js (13.15 GB) -> orchestratorv2.js (18 GB) - maxes out 32 GB RAM
server-manager.js (13.15 GB) -> hacknet-manager.js (~13 GB) - FAILS if orchestrator running
server-manager.js (if in BN9) closes, RAM freed
```

**Core Problem**: With 32 GB home RAM, orchestratorv2 (18 GB) + server-manager (13.15 GB) = 31.15 GB. No room for hacknet-manager (~13 GB).

---

## Issue 1: BN9 Bootstrap - hacknet-manager Must Run on Home

### Problem
In BN9:
- Cannot purchase regular servers (`getPurchasedServerLimit() === 0`)
- Only way to get nexus with 512 GB RAM is via hacknet server
- hacknet-manager MUST run to upgrade hacknet servers
- But it can't start because orchestratorv2 consumes too much RAM

### Solution: BN9-Specific Bootstrap Path

**File: `start.js`** - Add BN9 detection and alternate bootstrap

```javascript
import { 
  execSingleton
} from "utils/server-utils.js";
import { isInBitNode } from "utils/bitnode-cache.js";

/** @param {NS} ns */
export async function main(ns) {
  // Cache bitnode info first (run once, ~4GB, then exits)
  ns.tprint("Caching bitnode multipliers...");
  ns.run("cache-bitnode-mults.js");
  ns.singularity.createProgram("BruteSSH.exe", false);
  await ns.sleep(100);
  ns.tprint("Killing all scripts before beginning new run...");
  ns.killall("home", true);
  await ns.sleep(100);
  
  // BN9 SPECIAL PATH: hacknet-manager is the primary manager
  // It will handle nexus creation and spawn orchestrator when ready
  if (isInBitNode(ns, 9)) {
    ns.tprint("BN9 detected - starting hacknet-manager as primary controller");
    const pid = execSingleton(ns, "hacknet-manager.js", "home", false);
    if (pid > 0) {
      ns.tprint("Started hacknet-manager (BN9 primary), pid: ", pid);
    } else {
      ns.tprint("FAILED to start hacknet-manager!");
    }
    return; // Don't start server-manager in BN9
  }
  
  // Normal path: server-manager handles everything
  ns.tprint("Starting up server-manager, which will then load the hacking orchestrator itself.");
  const pid = execSingleton(ns, "server-manager.js", "home", false);
  if (pid > 0) {
    ns.tprint("started server-manager, pid: ", pid);
  } else {
    ns.tprint("failed to start server-manager!");
  }
}
```

**File: `hacknet-manager.js`** - Add orchestrator spawning responsibility for BN9

Add near line 1170 in `main()`, after nexus is ready:

```javascript
// In BN9, hacknet-manager is responsible for spawning orchestrator
// once nexus has enough RAM
if (isInBitNode(ns, 9) && nexusScriptsLaunched) {
  // Try to spawn orchestrator on nexus (not home - save home RAM)
  const nexusInfo = getNexusInfo(ns);
  if (nexusInfo.ready && nexusInfo.server) {
    const orchestratorScript = "orchestratorv2.js";
    if (!ns.isRunning(orchestratorScript, nexusInfo.server)) {
      const pid = ns.exec(orchestratorScript, nexusInfo.server, 1);
      if (pid > 0) {
        ns.print(`[BN9] Spawned orchestrator on ${nexusInfo.server} (PID: ${pid})`);
      }
    }
  }
}
```

---

## Issue 2: Non-BN9 Dual Manager Coordination

### Problem
- server-manager tries to spawn hacknet-manager on home first
- Often fails due to RAM constraints
- Later spawns on nexus, potentially duplicating
- Race conditions between the two managers

### Solution: Clear Ownership Model

**File: `server-manager.js`** - Revise `ensureHacknetManager()` (lines 192-241)

```javascript
/**
 * Spawn hacknet manager if not already running
 * Strategy:
 * - FIRST check if already running anywhere (home or nexus)
 * - If nexus is ready (512GB+), prefer nexus
 * - Only fall back to home if nexus not ready AND home has spare RAM
 * @param {NS} ns
 * @returns {boolean} Whether spawn was successful or already running
 */
function ensureHacknetManager(ns) {
  if (hacknetManagerSpawned) {
    return true;
  }

  // Check if already running ANYWHERE
  const isRunningOnHome = ns.isRunning(CONFIG.HACKNET_MANAGER_SCRIPT, "home");
  const nexus = getNexusHost(ns, 64);
  const isRunningOnNexus = nexus && ns.isRunning(CONFIG.HACKNET_MANAGER_SCRIPT, nexus);
  
  if (isRunningOnHome || isRunningOnNexus) {
    hacknetManagerSpawned = true;
    ns.print(`[MANAGER] hacknet-manager already running on ${isRunningOnHome ? 'home' : nexus}`);
    return true;
  }
  
  // Determine best location to spawn
  const nexusInfo = getNexusInfo(ns);
  const homeRamFree = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
  const hacknetRamCost = ns.getScriptRam(CONFIG.HACKNET_MANAGER_SCRIPT);
  
  // Prefer nexus if it's ready (has enough RAM and scripts are copied)
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
  
  // Fall back to home only if we have enough RAM
  if (homeRamFree >= hacknetRamCost) {
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
```

**File: `server-manager.js`** - Main loop: retry hacknet-manager spawn periodically

In the main loop (around line 414), add periodic retry:

```javascript
// Retry spawning hacknet manager each cycle if not yet running
if (canPurchaseHacknets(ns) && !hacknetManagerSpawned) {
  ensureHacknetManager(ns);
}
```

---

## Issue 3: Nexus Creation Strategy

### Problem
**BN9**:
- Always picks hacknet-server-0 (often highly upgraded = waste)
- No priority to quickly spin up a nexus
- Takes too long due to optimal hash rate spreading

**Non-BN9**:
- hacknet-manager sometimes tags hacknet-server-0 as nexus
- Should use regular purchased server instead (cheaper, no hash rate loss)

### Solution A: BN9 - Use hacknet-server-1 as Static Nexus

**File: `utils/server-utils.js`** - Modify `findBestHacknetNexus()` (lines 196-228)

```javascript
/**
 * Find the best hacknet server to use as nexus in BN9
 * 
 * STRATEGY: Use hacknet-server-1 as static nexus choice
 * - Avoids hacknet-server-0 which is often highly upgraded from previous resets
 * - Predictable behavior across resets
 * - If server-1 doesn't exist yet, return null to signal "buy more nodes first"
 * 
 * @param {NS} ns
 * @returns {string|null}
 */
function findBestHacknetNexus(ns) {
  if (!hasHacknetServers(ns)) return null;
  
  const numNodes = ns.hacknet.numNodes();
  
  // Need at least 2 nodes: server-0 for hashes, server-1 for nexus
  if (numNodes < 2) {
    return null; // Signal to buy more nodes first
  }
  
  // Static choice: hacknet-server-1
  // This avoids wasting the often-upgraded hacknet-server-0
  const nexusCandidate = "hacknet-server-1";
  
  if (ns.serverExists(nexusCandidate)) {
    return nexusCandidate;
  }
  
  // Fallback: if somehow server-1 doesn't exist, use lowest production server
  let bestServer = null;
  let lowestProduction = Infinity;
  
  for (let i = 0; i < numNodes; i++) {
    const hostname = `hacknet-server-${i}`;
    const stats = ns.hacknet.getNodeStats(i);
    
    // Skip server-0 if we have alternatives
    if (i === 0 && numNodes > 1) continue;
    
    if (stats.production < lowestProduction) {
      lowestProduction = stats.production;
      bestServer = hostname;
    }
  }
  
  return bestServer;
}
```

### Solution B: Non-BN9 - Prefer Purchased Server as Nexus

**File: `utils/server-utils.js`** - Modify `getNexusHost()` (lines 261-306)

```javascript
/**
 * Get the designated nexus host
 * Uses file-based storage for cross-script consistency
 * 
 * PRIORITY ORDER:
 * 1. Existing file designation (if still valid)
 * 2. Purchased server named "nexus" (preferred in non-BN9)
 * 3. Hacknet server (only in BN9 or if no purchased servers possible)
 * 
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
  
  // PRIORITY: Check purchased servers FIRST (unless we can't buy them)
  if (canPurchaseServers(ns)) {
    const purchasedNexus = findPurchasedNexus(ns, minRam);
    if (purchasedNexus) {
      designatedNexus = purchasedNexus;
      nexusDesignatedAt = Date.now();
      writeNexusDesignation(ns, designatedNexus);
      return designatedNexus;
    }
    // If we CAN purchase servers but don't have nexus yet, return null
    // Let server-manager create it - don't fall back to hacknet
    return null;
  }
  
  // Only use hacknet servers as nexus when we CANNOT buy regular servers (BN9)
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
```

### Solution C: BN9 Nexus Priority Upgrade Mode

**File: `hacknet-manager.js`** - Add nexus priority mode in `getBestUpgrade()` (around line 486)

Add a check at the start of `getBestUpgrade()`:

```javascript
function getBestUpgrade(ns) {
  const money = ns.getServerMoneyAvailable("home");
  const numNodes = ns.hacknet.numNodes();
  if (numNodes === 0) return null;
  
  // BN9 NEXUS PRIORITY: If nexus isn't ready, prioritize its RAM upgrades
  // This ensures we get a working nexus ASAP while still being somewhat efficient
  if (isInBitNode(ns, 9)) {
    const nexusInfo = getNexusInfo(ns);
    if (nexusInfo.server?.startsWith('hacknet-server-') && !nexusInfo.ready) {
      const nexusIndex = parseInt(nexusInfo.server.split('-').pop());
      const stats = ns.hacknet.getNodeStats(nexusIndex);
      const targetRam = getNexusTargetRam(ns);
      
      if (stats.ram < targetRam) {
        const ramUpgradeCost = ns.hacknet.getRamUpgradeCost(nexusIndex, 1);
        
        // If we can afford the RAM upgrade, prioritize it
        // But allow some hash production upgrades if nexus upgrade is very expensive
        const normalBestUpgrade = getBestNonNexusUpgrade(ns, money, nexusIndex);
        
        // Priority threshold: upgrade nexus if cost < 5x the best normal upgrade
        // This balances getting nexus quickly vs not completely ignoring hash production
        const priorityThreshold = normalBestUpgrade ? normalBestUpgrade.cost * 5 : Infinity;
        
        if (ramUpgradeCost <= money && ramUpgradeCost <= priorityThreshold) {
          return {
            nodeIndex: nexusIndex,
            upgradeType: 'ram',
            cost: ramUpgradeCost,
            hashGain: 0,
            isNexusPriority: true,
            roiDebug: { nexusPriority: true, targetRam, currentRam: stats.ram }
          };
        }
        
        // If nexus upgrade is too expensive, do normal upgrades but mark accumulating
        if (ramUpgradeCost > money) {
          return {
            nodeIndex: nexusIndex,
            upgradeType: 'ram',
            cost: ramUpgradeCost,
            hashGain: 0,
            isAccumulating: true,
            isNexusPriority: true,
            roiDebug: { nexusPriority: true, targetRam, currentRam: stats.ram }
          };
        }
      }
    }
  }
  
  // ... rest of existing getBestUpgrade logic ...
```

Add helper function:

```javascript
/**
 * Get best upgrade excluding the nexus server
 * Used to compare nexus priority vs normal ROI upgrades
 */
function getBestNonNexusUpgrade(ns, money, nexusIndex) {
  const numNodes = ns.hacknet.numNodes();
  let best = null;
  let bestRatio = 0;
  
  for (let i = 0; i < numNodes; i++) {
    if (i === nexusIndex) continue;
    
    const stats = ns.hacknet.getNodeStats(i);
    const currentProduction = stats.production;
    
    for (const type of ['level', 'ram', 'cores']) {
      let cost, newProduction;
      
      switch (type) {
        case 'level':
          cost = ns.hacknet.getLevelUpgradeCost(i, 1);
          newProduction = currentProduction * (stats.level + 1) / stats.level;
          break;
        case 'ram':
          cost = ns.hacknet.getRamUpgradeCost(i, 1);
          newProduction = currentProduction * 1.035;
          break;
        case 'cores':
          cost = ns.hacknet.getCoreUpgradeCost(i, 1);
          newProduction = currentProduction * (stats.cores + 6) / (stats.cores + 5);
          break;
      }
      
      if (cost === Infinity || cost > money) continue;
      
      const hashGain = newProduction - currentProduction;
      const ratio = hashGain / cost;
      
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = { nodeIndex: i, upgradeType: type, cost, hashGain };
      }
    }
  }
  
  return best;
}
```

---

## Issue 4: priorityJobs Time Unit Calculation Missing Multipliers

### Problem
- Time units formula: `remainingRep / (1 + favor/100)`
- Does NOT account for player multipliers like PC Direct-Neural Interface (+130% company rep)
- Sleeves don't have these augs, so their rep gain is different
- Player should prioritize company work when they have company rep boosts

### Solution: Add Rep Gain Multiplier Calculation

**File: `utils/priorityJobs.js`** - Add multiplier-aware time calculation

Add new helper functions after line 445:

```javascript
/**
 * Get the player's faction reputation gain multiplier
 * Combines all sources: augs, programs, etc.
 * @param {NS} ns
 * @returns {number}
 */
function getPlayerFactionRepMult(ns) {
  const player = ns.getPlayer();
  return player.mults.faction_rep || 1;
}

/**
 * Get the player's company reputation gain multiplier
 * Combines all sources: augs (PC Direct-Neural family), programs, etc.
 * @param {NS} ns
 * @returns {number}
 */
function getPlayerCompanyRepMult(ns) {
  const player = ns.getPlayer();
  return player.mults.company_rep || 1;
}

/**
 * Get a sleeve's reputation gain multiplier
 * Sleeves have their own multipliers based on their augs
 * @param {NS} ns
 * @param {number} sleeveNum
 * @returns {{faction: number, company: number}}
 */
function getSleeveRepMults(ns, sleeveNum) {
  const sleeve = ns.sleeve.getSleeve(sleeveNum);
  return {
    faction: sleeve.mults?.faction_rep || 1,
    company: sleeve.mults?.company_rep || 1,
  };
}

/**
 * Calculate "time units" with multiplier awareness
 * Time units = remaining_rep / (favor_bonus * rep_multiplier)
 * 
 * @param {number} currentRep - Current reputation
 * @param {number} targetRep - Target reputation
 * @param {number} favor - Current favor
 * @param {number} repMultiplier - Rep gain multiplier (1 = no bonus)
 * @returns {number} Time units (lower = faster to reach goal)
 */
function calculateTimeUnitsWithMult(currentRep, targetRep, favor, repMultiplier = 1) {
  if (currentRep >= targetRep) return 0;
  const remainingRep = targetRep - currentRep;
  const favorMultiplier = 1 + favor / 100;
  const effectiveMultiplier = favorMultiplier * repMultiplier;
  return remainingRep / effectiveMultiplier;
}
```

**File: `utils/priorityJobs.js`** - Update `getPriorityJobs()` function signature and logic

Modify the function signature (around line 537):

```javascript
/**
 * Main function: Get prioritized jobs (faction or company work)
 * @param {NS} ns
 * @param {Object} stats - Character stats {hacking, strength, defense, dexterity, agility, charisma}
 * @param {boolean} forSleeves - Whether this is for sleeves (affects aug checking and multipliers)
 * @param {Set<string>} excludedJobs - Jobs already taken by other workers (faction/company names)
 * @param {Object} config - Configuration options
 * @param {boolean} config.deprioritizeDonatable - If true, factions with 150+ favor are deprioritized
 * @param {number} [config.sleeveNum] - Sleeve number (required if forSleeves is true)
 * @returns {Object[]} Array of up to 8 job objects, sorted by priority
 */
export function getPriorityJobs(ns, stats, forSleeves = false, excludedJobs = new Set(), config = {}) {
  const { deprioritizeDonatable = DEPRIORITIZE_DONATABLE_FACTIONS, sleeveNum = 0 } = config;
  
  // Get appropriate rep multipliers based on who's working
  let factionRepMult, companyRepMult;
  if (forSleeves) {
    const sleeveMults = getSleeveRepMults(ns, sleeveNum);
    factionRepMult = sleeveMults.faction;
    companyRepMult = sleeveMults.company;
  } else {
    factionRepMult = getPlayerFactionRepMult(ns);
    companyRepMult = getPlayerCompanyRepMult(ns);
  }
```

Update faction job time calculation (around line 640):

```javascript
    // Use multiplier-aware time calculation
    let timeUnits = calculateTimeUnitsWithMult(factionRep, effectiveTarget, factionFavor, factionRepMult);
```

Update company job time calculation (around line 728):

```javascript
    // Use multiplier-aware time calculation for companies
    const timeUnits = calculateTimeUnitsWithMult(companyRep, targetRep, companyFavor, companyRepMult);
```

**File: `utils/priorityJobs.js`** - Update job object to include multiplier info

Add to the faction job object (around line 661):

```javascript
    jobs.push({
      type: "faction",
      name: faction,
      activity: activity,
      timeUnits: isDaedalusRedPill ? -Infinity : timeUnits,
      targetRep: effectiveTarget,
      actualAugRep: lowestRepNeeded,
      currentRep: factionRep,
      favor: factionFavor,
      favorAfterReset: favorAfterReset,
      targetAug: nextAug,
      isDaedalusRedPill: isDaedalusRedPill,
      cappedForDonation: cappedForDonation,
      canDonate: canDonate,
      repMultiplier: factionRepMult,  // NEW: include for debugging/display
    });
```

Add to the company job object (around line 731):

```javascript
    jobs.push({
      type: "company",
      name: company,
      activity: activity,
      timeUnits: timeUnits,
      targetRep: targetRep,
      currentRep: companyRep,
      favor: companyFavor,
      favorAfterReset: favorAfterReset,
      goalDescription: goalDescription,
      associatedFaction: associatedFaction,
      isDaedalusRedPill: false,
      repMultiplier: companyRepMult,  // NEW: include for debugging/display
    });
```

**File: `utils/priorityJobs.js`** - Update display in `main()` (around line 854):

```javascript
    ns.print(`    Time Units: ${timeStr}${job.repMultiplier !== 1 ? ` (mult: ${job.repMultiplier.toFixed(2)}x)` : ''}`);
```

---

## Issue 5: Control Flow Gaps Analysis

### Gap 5.1: Duplicate Instance Detection Incomplete

**Problem**: `ensureHacknetManager()` checks specific servers but misses edge cases.

**File: `server-manager.js`** - Add global running check

```javascript
function isHacknetManagerRunningAnywhere(ns) {
  // Check home
  if (ns.isRunning(CONFIG.HACKNET_MANAGER_SCRIPT, "home")) return "home";
  
  // Check all purchased servers
  for (const server of ns.getPurchasedServers()) {
    if (ns.isRunning(CONFIG.HACKNET_MANAGER_SCRIPT, server)) return server;
  }
  
  // Check all hacknet servers
  if (hasHacknetServers(ns)) {
    for (let i = 0; i < ns.hacknet.numNodes(); i++) {
      const hostname = `hacknet-server-${i}`;
      try {
        if (ns.isRunning(CONFIG.HACKNET_MANAGER_SCRIPT, hostname)) return hostname;
      } catch { /* server might not exist as hostname yet */ }
    }
  }
  
  return null;
}
```

### Gap 5.2: Race Condition on Nexus Designation

**Problem**: Both `server-manager.js` and `hacknet-manager.js` can designate nexus.

**Solution**: Already partially solved by file-based designation. Add mutex-like check:

**File: `utils/server-utils.js`** - Add designation lock

```javascript
/**
 * Attempt to designate a nexus server (with conflict detection)
 * @param {NS} ns
 * @param {string} server
 * @param {string} caller - Identifying who's calling (for logging)
 * @returns {boolean} True if designation succeeded, false if already designated
 */
export function tryDesignateNexus(ns, server, caller = "unknown") {
  const existing = readNexusDesignation(ns);
  
  // If already designated to a different server, reject
  if (existing.server && existing.server !== server && ns.serverExists(existing.server)) {
    ns.print(`[SERVER-UTILS] Nexus already designated to ${existing.server}, rejecting ${server} from ${caller}`);
    return false;
  }
  
  // Designate
  setNexusHost(ns, server);
  ns.print(`[SERVER-UTILS] ${caller} designated ${server} as nexus`);
  return true;
}
```

### Gap 5.3: Orchestrator Spawn Location Inconsistency

**Problem**: `server-manager.js` spawns orchestrator on home, but in BN9 it should be on nexus.

**File: `server-manager.js`** - Update `ensureHackingOrchestrator()` (line 173)

```javascript
function ensureHackingOrchestrator(ns) {
  // Determine best location for orchestrator
  // In BN9: prefer nexus (save home RAM for hacknet-manager)
  // Otherwise: prefer home (always available)
  
  const nexusInfo = getNexusInfo(ns);
  const isBN9 = isHacknetBitNode(ns);
  
  // Check if already running anywhere
  if (ns.isRunning(CONFIG.HACKING_ORCHESTRATOR_SCRIPT, "home")) {
    return true;
  }
  if (nexusInfo.server && ns.isRunning(CONFIG.HACKING_ORCHESTRATOR_SCRIPT, nexusInfo.server)) {
    return true;
  }
  
  // BN9: Only spawn on nexus when ready
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
  
  // Normal: Try home first
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
```

### Gap 5.4: No Graceful Degradation When RAM Tight

**Problem**: Scripts fail silently when RAM is insufficient.

**Solution**: Add explicit RAM checks and status reporting.

**File: `server-manager.js`** - Add RAM status to printStatus()

Add after line 296:

```javascript
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
  
  // Show what can/cannot fit
  const canFitOrchestrator = homeRamFree >= orchestratorRam;
  const canFitHacknet = homeRamFree >= hacknetRam;
  ns.print(`  Can fit: orchestrator=${canFitOrchestrator ? '✅' : '❌'}, hacknet=${canFitHacknet ? '✅' : '❌'}`);
  ns.print("");
```

### Gap 5.5: Missing Import in start.js

The solution for Issue 1 requires adding an import to `start.js`:

```javascript
import { isInBitNode } from "utils/bitnode-cache.js";
```

**Note**: This will increase RAM usage of `start.js`. Check if it's still under budget. If not, an alternative is to read the cache file directly:

```javascript
function isInBN9(ns) {
  try {
    const cache = JSON.parse(ns.read("/data/bitnode-cache.json"));
    return cache?.resetInfo?.currentNode === 9;
  } catch {
    return false;
  }
}
```

---

## Summary of Changes by File

### `start.js`
- Add BN9 detection
- Start hacknet-manager instead of server-manager in BN9

### `server-manager.js`
- Revise `ensureHacknetManager()` for better location selection
- Update `ensureHackingOrchestrator()` for BN9 awareness
- Add periodic retry for hacknet-manager spawn
- Add RAM status display
- Add global running detection helper

### `hacknet-manager.js`
- Add orchestrator spawning responsibility for BN9
- Add nexus priority upgrade mode
- Add `getBestNonNexusUpgrade()` helper

### `utils/server-utils.js`
- Modify `findBestHacknetNexus()` to prefer server-1 in BN9
- Modify `getNexusHost()` to prefer purchased servers in non-BN9
- Add `tryDesignateNexus()` for conflict detection

### `utils/priorityJobs.js`
- Add `getPlayerFactionRepMult()`, `getPlayerCompanyRepMult()`, `getSleeveRepMults()`
- Add `calculateTimeUnitsWithMult()`
- Update `getPriorityJobs()` to use multiplier-aware calculations
- Add `repMultiplier` field to job objects
- Update display to show multiplier info

---

## Testing Checklist

1. **BN9 Bootstrap**
   - [ ] start.js detects BN9 and launches hacknet-manager
   - [ ] hacknet-manager designates hacknet-server-1 as nexus
   - [ ] hacknet-manager prioritizes nexus RAM upgrades
   - [ ] hacknet-manager spawns orchestrator on nexus when ready

2. **Non-BN9 Bootstrap**
   - [ ] start.js launches server-manager
   - [ ] server-manager creates "nexus" purchased server
   - [ ] hacknet-manager doesn't override nexus designation
   - [ ] Both managers run without duplication

3. **Priority Jobs**
   - [ ] Player with PC Direct-Neural Interface (+130% company rep) sees lower time units for companies
   - [ ] Sleeves without the aug see higher time units for same companies
   - [ ] Player prioritizes company work when multiplier advantage exists

4. **RAM Management**
   - [ ] Status display shows accurate RAM usage
   - [ ] Scripts gracefully handle insufficient RAM
   - [ ] No duplicate script instances

5. **Hash Selling Priority (NEW)**
   - [ ] hacknet-manager compares online income vs hash selling potential
   - [ ] When online income < hash income, prioritize selling hashes for money
   - [ ] BN9: balance hash selling vs study boosts appropriately

---

## Implementation Review (Post-Codex)

### ✅ Implemented Correctly

| Issue | Component | Status | Notes |
|-------|-----------|--------|-------|
| Issue 1 | `start.js` BN9 detection | ✅ | Lines 17-25 correctly detect BN9 and launch hacknet-manager |
| Issue 1 | `hacknet-manager.js` orchestrator spawn | ✅ | Lines 1291-1305 spawn orchestrator on nexus in BN9 |
| Issue 2 | `server-manager.js` `isHacknetManagerRunningAnywhere()` | ✅ | Lines 210-236 check all locations |
| Issue 2 | `server-manager.js` `ensureHacknetManager()` | ✅ | Lines 243-284 prefer nexus when ready |
| Issue 2 | `server-manager.js` periodic retry | ✅ | Lines 485-487 retry each cycle |
| Issue 3 | `server-utils.js` `findBestHacknetNexus()` | ✅ | Lines 196-226 prefer hacknet-server-1 |
| Issue 3 | `server-utils.js` `getNexusHost()` | ✅ | Lines 279-291 prefer purchased servers, return null if purchasable but not exists |
| Issue 3 | `server-utils.js` `tryDesignateNexus()` | ✅ | Lines 333-346 conflict detection |
| Issue 3 | `hacknet-manager.js` nexus priority mode | ✅ | Lines 518-553 prioritize nexus RAM with threshold |
| Issue 3 | `hacknet-manager.js` `getBestNonNexusUpgrade()` | ✅ | Lines 964-1005 |
| Issue 4 | `priorityJobs.js` multiplier functions | ✅ | Lines 452-495 all three helpers + calculateTimeUnitsWithMult |
| Issue 4 | `priorityJobs.js` use multipliers | ✅ | Lines 592-601 get mults, lines 701/790 use them |
| Issue 4 | `priorityJobs.js` display multiplier | ✅ | Lines 918-921 |
| Issue 5 | `server-manager.js` RAM status | ✅ | Lines 342-355 |
| Issue 5 | `server-manager.js` BN9 orchestrator awareness | ✅ | Lines 173-208 |

### ⚠️ Issues / Holes Found

#### 1. `hacknet-manager.js` orchestrator spawn: Missing home check
**Location**: Lines 1296-1297  
**Issue**: Checks if orchestrator is running on `nexusInfo.server` or `home`, but the check happens BEFORE `copyScriptsToNexus` - if scripts aren't copied yet, the check passes but exec might fail.  
**Severity**: Low - `copyScriptsToNexus` is called on line 1298, but only if `alreadyRunning` is false. Should work.  
**Status**: ✅ OK on closer inspection

#### 2. `hacknet-manager.js` `findBestNexusCandidate()` still uses old logic
**Location**: Lines 811-840  
**Issue**: This function still uses "lowest investment" logic instead of preferring server-1. However, it's only called when `getNexusHost()` returns null, which already prefers server-1 via `findBestHacknetNexus()` in `server-utils.js`.  
**Severity**: Low - redundant but harmless. The server-utils version takes precedence.  
**Recommendation**: Consider removing or aligning this function for consistency.

#### 3. Hash selling threshold doesn't account for BN9 studying priority correctly
**Location**: Lines 175-181, 203-223  
**Issue**: `shouldSellHashesForMoney()` returns true when `onlineIncome < hashMoneyRate * 0.5`. But in BN9, studying boosts are MORE valuable than money early on. The current code at line 215 does skip selling if `skipSellingForStudying` is true, which is good. However, the threshold (50%) may be too aggressive - in BN9, hacking income is 5% of normal, so hash selling will almost always trigger.  
**Severity**: Medium - needs tuning for BN9.  
**See**: New Issue 6 below for proper handling.

#### 4. `getLastAugReset` call in `printStatus` may crash
**Location**: Line 1105  
**Issue**: `getLastAugReset(ns)` returns an object with `lastAugReset` property, but the code treats it as if it returns the timestamp directly. Should be `getLastAugReset(ns)` (returns number) or needs `.lastAugReset`.  
**Severity**: Medium - will cause incorrect display or crash.  
**Fix**: Check what `getLastAugReset` actually returns and adjust.

---

## Issue 6 (NEW): Hash Selling Priority for BN9 Income

### Problem
In BN9:
- Hacking income is gimped to 5% of normal
- Hash → money conversion provides consistent income ($250k per hash)
- Current logic sells hashes when `onlineIncome < hashMoneyRate * 0.5`
- But studying boosts are also critical in BN9 for progression

Need a smarter balance: 
- If studying boost cap is reached, prioritize selling for money
- If studying boosts still needed AND hash production is decent, prioritize studying
- If studying boosts still needed BUT hash production is low, sell for money to fund upgrades

### Solution: Tiered Hash Spending Priority for BN9

**File: `hacknet-manager.js`** - Update `getHashActions()` to handle income-based priority

Replace the hash selling logic (around line 213-223):

```javascript
/**
 * Determine hash spending priority based on game state
 * 
 * BN9 Priority Order:
 * 1. Studying boosts (if production >= threshold AND not at cap)
 * 2. Sell for money (if online income < hash income potential AND studying capped/low-prod)
 * 3. Server boosts (gym, max money, min security)
 * 4. Generate contracts (filler)
 * 
 * Non-BN9 Priority Order:
 * 1. Sell for money (early game when hacking income is low)
 * 2. Server boosts
 * 3. Generate contracts
 */

// BN9: Determine if we should prioritize selling for income
if (isInBitNode(ns, 9)) {
  const hashProduction = getTotalHashProduction(ns);
  const currentStudyMult = 1 + (studyingBoostsPurchased * CONFIG.STUDYING_BOOST_PER_USE);
  const studyingCapped = currentStudyMult >= CONFIG.STUDYING_MAX_MULTIPLIER;
  const hasEnoughProduction = hashProduction >= CONFIG.STUDYING_HASH_RATE_THRESHOLD;
  
  // Check if online income is significantly less than hash selling potential
  const onlineIncome = getOnlineIncomeRate(ns);
  const hashMoneyRate = getHashMoneyRate(ns);
  const incomeStarved = onlineIncome < hashMoneyRate * CONFIG.MONEY_SELL_THRESHOLD;
  
  // Sell for money if:
  // - Studying is capped AND income is low, OR
  // - Production is too low to efficiently study AND income is low
  const shouldSellInBN9 = incomeStarved && (studyingCapped || !hasEnoughProduction);
  
  if (shouldSellInBN9) {
    actions.push({
      action: "Sell for Money",
      priority: studyingCapped ? 150 : 90,  // Higher priority if studying capped
      cost: actualCosts.sellForMoney,
      available: hashes >= actualCosts.sellForMoney,
      execute: () => ns.hacknet.spendHashes("Sell for Money"),
      reason: studyingCapped ? "studying_capped" : "low_production",
    });
  }
}
```

**Add configuration constant** at top of file:

```javascript
const CONFIG = {
  // ... existing config ...
  MONEY_SELL_THRESHOLD: 0.5,  // Sell hashes if online income < 50% of hash potential
  // For BN9: this triggers when hacking income is very low relative to hash value
};
```

**Update status display** to show the decision reasoning (in `printStatus()`):

```javascript
// Show hash spending strategy with reasoning
if (isInBitNode(ns, 9)) {
  const studyMult = 1 + (studyingBoostsPurchased * CONFIG.STUDYING_BOOST_PER_USE);
  const studyCapped = studyMult >= CONFIG.STUDYING_MAX_MULTIPLIER;
  const hasEnoughProd = totalProduction >= CONFIG.STUDYING_HASH_RATE_THRESHOLD;
  const incomeStarved = onlineIncome < hashMoneyRate * CONFIG.MONEY_SELL_THRESHOLD;
  
  if (studyCapped && incomeStarved) {
    ns.print("   → Selling hashes for money (studying capped, low income)");
  } else if (!hasEnoughProd && incomeStarved) {
    ns.print("   → Selling hashes for money (need upgrades first)");
  } else if (hasEnoughProd && !studyCapped) {
    ns.print("   → Prioritizing study boosts");
  } else if (studyCapped) {
    ns.print("   → Study boost maxed, using server boosts");
  }
}
```

### Testing for Issue 6

- [ ] In BN9 with low hash production: sells hashes for money to fund upgrades
- [ ] In BN9 with decent production but studying not capped: prioritizes studying
- [ ] In BN9 with studying capped and low hacking income: sells hashes
- [ ] In BN9 with studying capped and good hacking income: uses server boosts
- [ ] Outside BN9: existing early-game selling logic works
