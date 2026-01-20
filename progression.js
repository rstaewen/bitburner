/**
 * progression.js - Master orchestration script for automated BitNode progression
 * 
 * Runs on 'nexus' server with 256-512GB RAM available.
 * Controls: purchases, player actions, grafting, stock trading, reset decisions
 */

import {
  getFactionPriority,
  getNeededMegacorps,
  getBestWorkAssignment,
  shouldReassign,
  executePlayerAssignment,
  classifyTask,
  REP_CONFIG,
} from "utils/repTargets.js";

// === CONFIGURATION ===

const CONFIG = {
  // Timing
  CHECK_INTERVAL: 1000,           // Main loop interval (ms)
  CRUISE_CONTROL_TIMEOUT: 60000,  // Idle time before auto-control kicks in (ms)
  METRICS_LOG_INTERVAL: 60000,    // How often to log metrics (ms)
  MIN_RUN_TIME: 60 * 60 * 1000,   // Minimum time before reset allowed (1 hour)
  
  // Financial thresholds
  FOUR_S_DATA_COST: 1e9,          // $1b
  FOUR_S_TIX_API_COST: 25e9,      // $25b
  FOUR_S_TOTAL_COST: 26e9,        // $26b combined
  
  // Phase thresholds
  MIN_RAM_FOR_SATURATION: 1024,   // GB - minimum before we stop buying RAM
  SHARE_THREAD_RATIO_THRESHOLD: 0.3, // If share threads > 30%, we've hit saturation
  
  // Reset thresholds
  MIN_AUGS_FOR_RESET: 10,
  GOOD_AUGS_FOR_RESET: 15,
  OVERRIDE_AUGS_FOR_RESET: 25,
  
  // Company rep thresholds (from our earlier analysis)
  COMPANY_REP_FAVOR_THRESHOLD: 25000,
  COMPANY_REP_FACTION_UNLOCK: 400000,
};

const GRAFT_PRIORITY = [
  // === EARLY GAME (cheap, immediate ROI) ===
  "Neural Accelerator",
  "Neuralstimulator",
  "PCMatrix",
  "The Black Hand",
  
  // === MID GAME ===
  "Social Negotiation Assistant (S.N.A)",
  "BitRunners Neurolink",
  "Embedded Netburner Module Analyze Engine",
  "Embedded Netburner Module Direct Memory Access Upgrade",
  "Xanipher",
  "ECorp HVMind Implant",
  
  // === LATE GAME (disabled for now - manually trigger if needed) ===
  // "QLink",                    // $75t - only needed for high-hacking BitNodes
  // "violet Congruity Implant", // $150t - removes graft penalties
];

const HACKING_TOOLS = [
  "BruteSSH.exe",
  "FTPCrack.exe",
  "relaySMTP.exe",
  "HTTPWorm.exe",
  "SQLInject.exe",
];

// Phases of a reset cycle
const Phase = Object.freeze({
  BOOTSTRAP: 'bootstrap',
  EARLY_ACCELERATION: 'early_acceleration', 
  PASSIVE_INCOME: 'passive_income',
  INVESTMENT: 'investment',
  RESET_PREP: 'reset_prep',
});

// === FACTION DATA ===

// Factions that are enemies - joining one blocks the other
// Three alliances: West (Sector-12, Aevum), East (Chongqing, New Tokyo, Ishima), Volhaven (alone)
const FACTION_ENEMIES = {
  // West alliance - enemies with East and Volhaven
  "Sector-12": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  "Aevum": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  // East alliance - enemies with West and Volhaven
  "Chongqing": ["Sector-12", "Aevum", "Volhaven"],
  "New Tokyo": ["Sector-12", "Aevum", "Volhaven"],
  "Ishima": ["Sector-12", "Aevum", "Volhaven"],
  // Volhaven - enemies with everyone
  "Volhaven": ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima"],
};

// Faction requirements
const FACTION_REQUIREMENTS = {
  // Hacking factions - require backdoor (handled elsewhere)
  "CyberSec": { type: "backdoor", server: "CSEC" },
  "NiteSec": { type: "backdoor", server: "avmnite-02h" },
  "The Black Hand": { type: "backdoor", server: "I.I.I.I" },
  "BitRunners": { type: "backdoor", server: "run4theh111z" },
  
  // City factions
  "Sector-12": { type: "city", city: "Sector-12", money: 15e6 },
  "Aevum": { type: "city", city: "Aevum", money: 40e6 },
  "Chongqing": { type: "city", city: "Chongqing", money: 20e6 },
  "New Tokyo": { type: "city", city: "New Tokyo", money: 20e6 },
  "Ishima": { type: "city", city: "Ishima", money: 30e6 },
  "Volhaven": { type: "city", city: "Volhaven", money: 50e6 },
  "Tian Di Hui": { type: "city", city: ["Chongqing", "New Tokyo", "Ishima"], money: 1e6, hacking: 50 },
  
  // Crime factions
  "Slum Snakes": { type: "crime", combat: 30, karma: -9, money: 1e6 },
  "Tetrads": { type: "crime", city: ["Chongqing", "New Tokyo", "Ishima"], combat: 75, karma: -18 },
  "The Syndicate": { type: "crime", city: ["Aevum", "Sector-12"], hacking: 200, combat: 200, karma: -90, money: 10e6 },
  "The Dark Army": { type: "crime", city: "Chongqing", hacking: 300, combat: 300, karma: -45, kills: 5 },
  "Speakers for the Dead": { type: "crime", hacking: 100, combat: 300, karma: -45, kills: 30 },
  
  // Megacorp factions - require 400k company rep (or 300k + backdoor)
  "ECorp": { type: "megacorp", company: "ECorp" },
  "MegaCorp": { type: "megacorp", company: "MegaCorp" },
  "Blade Industries": { type: "megacorp", company: "Blade Industries" },
  "Four Sigma": { type: "megacorp", company: "Four Sigma" },
  "KuaiGong International": { type: "megacorp", company: "KuaiGong International" },
  "Fulcrum Secret Technologies": { type: "megacorp", company: "Fulcrum Technologies", backdoor: "fulcrumassets" },
  "NWO": { type: "megacorp", company: "NWO" },
  "OmniTek Incorporated": { type: "megacorp", company: "OmniTek Incorporated" },
  "Clarke Incorporated": { type: "megacorp", company: "Clarke Incorporated" },
  "Bachman & Associates": { type: "megacorp", company: "Bachman & Associates" },
  
  // Special factions
  "Netburners": { type: "special", hacking: 80, hacknetLevels: 100, hacknetRAM: 8, hacknetCores: 4 },
  "Daedalus": { type: "special", hacking: 2500, augs: 30, money: 100e9 },
  "The Covenant": { type: "special", hacking: 850, combat: 850, augs: 20, money: 75e9 },
  "Illuminati": { type: "special", hacking: 1500, combat: 1200, augs: 30, money: 150e9 },
};

// Priority order for joining factions (lower index = higher priority)
const FACTION_PRIORITY = [
  // CRITICAL: Daedalus has "The Red Pill" - required to finish BitNode
  "Daedalus",
  // Hacking factions - always valuable
  "CyberSec", "NiteSec", "The Black Hand", "BitRunners",
  // Key aug factions
  "Tian Di Hui", "Aevum", "Sector-12",
  // Crime factions for combat augs
  "Slum Snakes", "Tetrads", "The Syndicate", "Speakers for the Dead", "The Dark Army",
  // Megacorps
  "ECorp", "MegaCorp", "Blade Industries", "Four Sigma", "KuaiGong International",
  "NWO", "OmniTek Incorporated", "Clarke Incorporated", "Bachman & Associates",
  "Fulcrum Secret Technologies",
  // Other city factions (lower priority due to enemy conflicts)
  "Chongqing", "New Tokyo", "Ishima", "Volhaven",
  // Special/endgame
  "Netburners", "The Covenant", "Illuminati",
];

// === FACTION MANAGEMENT ===

// === STATE ===

/** @param {NS} ns */
function createInitialState(ns) {
  return {
    // Control mode
    mode: 'AUTO',                    // AUTO or MANUAL
    lastPlayerAction: Date.now(),    // Timestamp of last detected manual action
    lastPlayerWork: null,            // Last known player work (for detecting manual changes)
    lastActionWasOurs: false,        // Flag to track if we initiated the last action
    
    // Current phase
    phase: Phase.BOOTSTRAP,
    
    // Stock trader
    stockTraderRunning: false,
    stockTraderPID: -1,
    lastLiquidation: 0,           // Timestamp of last stock liquidation
    
    // Grafting
    graftInProgress: false,
    currentGraft: null,
    graftsCompleted: [],
    
    // Faction unlock progress
    needKills: 0,              // Kills needed for faction unlock
    needKarma: false,          // Whether we need more negative karma
    
    // Purchases
    hackingToolsOwned: [],
    has4SData: false,
    has4STIX: false,
    
    // Queued augs for reset
    queuedAugs: [],
    
    // Aug queue (rebuilt each cycle)
    augQueue: null,
    
    // Metrics tracking
    metrics: {
      startTime: Date.now(),
      phaseStartTime: Date.now(),
      moneyOverTime: [],             // [{time, money}, ...]
      incomeRate: 0,                 // $/sec calculated from recent data
      stockValue: 0,                 // Current stock portfolio value
      hackingLevel: 1,
      totalAugsInstalled: 0,
      graftsThisReset: 0,
      resetsCompleted: 0,
      
      // Phase timing (for analysis)
      phaseTimings: {
        [Phase.BOOTSTRAP]: 0,
        [Phase.EARLY_ACCELERATION]: 0,
        [Phase.PASSIVE_INCOME]: 0,
        [Phase.INVESTMENT]: 0,
        [Phase.RESET_PREP]: 0,
      },
    },
  };
}

// === FACTION MANAGEMENT FUNCTIONS ===

/**
 * Handle pending faction invitations
 * @param {NS} ns
 * @param {Object} state
 * @param {Object} args
 */
function handleFactionInvitations(ns, state, args) {
  const invitations = ns.singularity.checkFactionInvitations();
  if (invitations.length === 0) return;
  
  const joinedFactions = getJoinedFactions(ns);
  
  // Sort invitations by priority
  const sortedInvitations = [...invitations].sort((a, b) => {
    const priorityA = FACTION_PRIORITY.indexOf(a);
    const priorityB = FACTION_PRIORITY.indexOf(b);
    // Lower index = higher priority, -1 means not in list (lowest priority)
    const adjA = priorityA === -1 ? 999 : priorityA;
    const adjB = priorityB === -1 ? 999 : priorityB;
    return adjA - adjB;
  });
  
  for (const faction of sortedInvitations) {
    // First check: do we even need augs from this faction?
    if (!needAugsFromFaction(ns, faction)) {
      if (args.debug) {
        ns.print(`DEBUG: Skipping ${faction} - no needed augs`);
      }
      continue;
    }
    
    // Second check: have we already joined an enemy faction?
    // This handles both "already committed to alliance" and "would conflict"
    // If we haven't joined any faction in an alliance yet, the first one by priority wins
    if (wouldConflictWithJoined(faction, joinedFactions)) {
      if (args.debug) {
        ns.print(`DEBUG: Skipping ${faction} - conflicts with joined faction`);
      }
      continue;
    }
    
    // Accept the invitation
    if (!args['dry-run']) {
      const success = ns.singularity.joinFaction(faction);
      if (success) {
        ns.print(`INFO: Joined faction ${faction}`);
      }
    } else {
      ns.print(`DRY-RUN: Would join faction ${faction}`);
    }
  }
}

/**
 * Get list of factions we've already joined
 * @param {NS} ns
 * @returns {string[]}
 */
function getJoinedFactions(ns) {
  const allFactions = Object.values(ns.enums.FactionName);
  return allFactions.filter(f => ns.singularity.getFactionRep(f) > 0);
}

/**
 * Check if joining a faction would conflict with already joined factions
 * @param {string} faction
 * @param {string[]} joinedFactions
 * @returns {boolean}
 */
function wouldConflictWithJoined(faction, joinedFactions) {
  const enemies = FACTION_ENEMIES[faction];
  if (!enemies) return false;
  
  return enemies.some(enemy => joinedFactions.includes(enemy));
}

/**
 * Check if we still need key augs from a faction
 * @param {NS} ns
 * @param {string} faction
 * @returns {boolean}
 */
function needAugsFromFaction(ns, faction) {
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
  
  // Check if any augs from this faction are not owned (except NeuroFlux)
  for (const aug of factionAugs) {
    if (aug === "NeuroFlux Governor") continue;
    if (!ownedAugs.includes(aug)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if we specifically need KEY_AUGS from a faction
 * @param {NS} ns
 * @param {string} faction
 * @returns {boolean}
 */
function needKeyAugsFromFaction(ns, faction) {
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
  
  for (const aug of factionAugs) {
    if (KEY_AUGS.includes(aug) && !ownedAugs.includes(aug)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Work towards unlocking factions that we haven't joined yet
 * @param {NS} ns
 * @param {Object} state
 * @param {Object} args
 */
function workTowardsFactionsUnlock(ns, state, args) {
  const joinedFactions = getJoinedFactions(ns);
  const invitations = ns.singularity.checkFactionInvitations();
  const player = ns.getPlayer();
  
  // Find factions we want but haven't unlocked
  for (const faction of FACTION_PRIORITY) {
    // Skip if already joined or invited
    if (joinedFactions.includes(faction)) continue;
    if (invitations.includes(faction)) continue;
    
    // Skip if would conflict
    if (wouldConflictWithJoined(faction, joinedFactions)) continue;
    
    const req = FACTION_REQUIREMENTS[faction];
    if (!req) continue;
    
    // Check and work towards requirements
    const action = getActionToUnlockFaction(ns, faction, req, player);
    if (action) {
      if (args.debug) {
        ns.print(`DEBUG: To unlock ${faction}: ${action.type} - ${action.detail}`);
      }
      return action; // Return first actionable item
    }
  }
  
  return null;
}

/**
 * Get the action needed to unlock a faction
 * @param {NS} ns
 * @param {string} faction
 * @param {Object} req - Requirements object
 * @param {Object} player - Player object
 * @returns {{type: string, detail: string, execute: function} | null}
 */
function getActionToUnlockFaction(ns, faction, req, player) {
  const money = ns.getServerMoneyAvailable('home');
  
  switch (req.type) {
    case "city": {
      // Check if we meet the requirements
      if (req.money && money < req.money) return null;
      if (req.hacking && player.skills.hacking < req.hacking) return null;
      
      // Need to travel to the city (may be array of valid cities)
      const validCities = Array.isArray(req.city) ? req.city : [req.city];
      if (!validCities.includes(player.city)) {
        return {
          type: "travel",
          detail: `Travel to ${validCities[0]}`,
          city: validCities[0], // Just pick the first valid one
        };
      }
      // Already in city, should get invite soon
      return null;
    }
    
    case "crime": {
      // Check stat requirements
      const combatStats = Math.min(
        player.skills.strength,
        player.skills.defense,
        player.skills.dexterity,
        player.skills.agility
      );
      
      if (req.combat && combatStats < req.combat) {
        return { type: "need_stats", detail: `Need ${req.combat} combat (have ${combatStats})` };
      }
      if (req.hacking && player.skills.hacking < req.hacking) {
        return { type: "need_stats", detail: `Need ${req.hacking} hacking` };
      }
      if (req.money && money < req.money) {
        return { type: "need_money", detail: `Need $${ns.formatNumber(req.money)}` };
      }
      
      // Check karma
      if (req.karma && player.karma > req.karma) {
        return { type: "need_karma", detail: `Need ${req.karma} karma (have ${player.karma.toFixed(0)})` };
      }
      
      // Check kills
      if (req.kills && player.numPeopleKilled < req.kills) {
        return {
          type: "need_kills",
          detail: `Need ${req.kills} kills (have ${player.numPeopleKilled})`,
          kills: req.kills,
        };
      }
      
      // Check city requirement (may be array)
      if (req.city) {
        const validCities = Array.isArray(req.city) ? req.city : [req.city];
        if (!validCities.includes(player.city)) {
          return {
            type: "travel",
            detail: `Travel to ${validCities[0]}`,
            city: validCities[0],
          };
        }
      }
      
      return null;
    }
    
    case "megacorp": {
      const companyRep = ns.singularity.getCompanyRep(req.company);
      const threshold = req.server ? 300000 : 400000; // Lower if backdoor available
      
      if (companyRep < threshold) {
        return {
          type: "need_company_rep",
          detail: `Need ${threshold/1000}k rep at ${req.company} (have ${(companyRep/1000).toFixed(0)}k)`,
          company: req.company,
        };
      }
      return null;
    }
    
    case "endgame": {
      const installed = ns.singularity.getOwnedAugmentations(false).length;
      if (req.augments && installed < req.augments) {
        return { type: "need_augs", detail: `Need ${req.augments} installed augs (have ${installed})` };
      }
      if (req.money && money < req.money) {
        return { type: "need_money", detail: `Need $${ns.formatNumber(req.money)}` };
      }
      if (req.hacking && player.skills.hacking < req.hacking) {
        return { type: "need_stats", detail: `Need ${req.hacking} hacking` };
      }
      if (req.combat) {
        const combatStats = Math.min(
          player.skills.strength,
          player.skills.defense,
          player.skills.dexterity,
          player.skills.agility
        );
        if (combatStats < req.combat) {
          return { type: "need_stats", detail: `Need ${req.combat} combat` };
        }
      }
      return null;
    }
    
    default:
      return null;
  }
}

/**
 * Execute action to work towards faction unlock
 * @param {NS} ns
 * @param {Object} action
 * @param {Object} state
 */
function executeFactionUnlockAction(ns, action, state) {
  switch (action.type) {
    case "travel":
      ns.singularity.travelToCity(action.city);
      state.lastActionWasOurs = true;
      ns.print(`INFO: Traveled to ${action.city}`);
      break;
      
    case "need_kills":
      // Player should commit homicide - handled by player action control
      // Just flag that we need kills
      state.needKills = action.kills;
      break;
      
    case "need_karma":
      // Player should commit crimes - handled by player action control
      state.needKarma = true;
      break;
      
    default:
      // Other types are informational - can't directly act on them
      break;
  }
}

// === MAIN LOOP ===

/** @param {NS} ns */
export async function main(ns) {
  const args = ns.flags([
    ['manual', false],      // Disable auto player control entirely
    ['dry-run', false],     // Log actions without executing
    ['debug', false],       // Extra verbose logging
  ]);
  
  ns.disableLog('ALL');
  ns.ui.openTail();
  ns.print('=== progression.js starting ===');
  
  const state = createInitialState(ns);
  let lastMetricsLog = Date.now();
  
  // Main loop
  while (true) {
    try {
      // 1. Update game state information
      await updateGameState(ns, state);
      
      // 2. Check for manual player actions, update control mode
      if (!args.manual) {
        updateControlMode(ns, state, args.debug);
      } else {
        state.mode = 'MANUAL';
      }
      
      // 3. Determine current phase
      updatePhase(ns, state);
      
      // 4. Handle faction invitations
      handleFactionInvitations(ns, state, args);
      
      // 5. Work towards unlocking factions
      const factionAction = workTowardsFactionsUnlock(ns, state, args);
      if (factionAction && !args['dry-run']) {
        executeFactionUnlockAction(ns, factionAction, state);
      }
      
      // 6. Financial management (stock trader)
      await manageFinances(ns, state, args);
      
      // 7. Execute phase-specific logic
      await executePhaseLogic(ns, state, args);
      
      // 8. If AUTO mode, control player actions
      if (state.mode === 'AUTO') {
        await controlPlayerActions(ns, state, args);
      }
      
      // 9. Check reset conditions
      const shouldReset = checkResetConditions(ns, state);
      if (shouldReset && !args['dry-run']) {
        await executeReset(ns, state);
      }
      
      // 10. Log metrics periodically
      if (Date.now() - lastMetricsLog > CONFIG.METRICS_LOG_INTERVAL) {
        logMetrics(ns, state);
        lastMetricsLog = Date.now();
      }
      
      // 11. Debug status (every cycle if debug mode)
      if (args.debug) {
        logDebugStatus(ns, state);
      }
      
    } catch (e) {
      ns.print(`ERROR: ${e.toString()}`);
      ns.print(e.stack);
    }
    
    await ns.sleep(CONFIG.CHECK_INTERVAL);
  }
}

// === GAME STATE UPDATES ===

/** @param {NS} ns */
async function updateGameState(ns, state) {
  const player = ns.getPlayer();
  
  // Update metrics
  const now = Date.now();
  const currentMoney = ns.getServerMoneyAvailable('home');
  
  // Calculate total wealth including stocks
  const stockValue = state.has4STIX ? getStockPortfolioValue(ns) : 0;
  const totalWealth = currentMoney + stockValue;
  
  // Track total wealth over time (keep last 60 data points for rate calculation)
  state.metrics.moneyOverTime.push({ time: now, money: totalWealth });
  if (state.metrics.moneyOverTime.length > 60) {
    state.metrics.moneyOverTime.shift();
  }
  
  // Calculate income rate ($/sec) from last 30 seconds of data
  state.metrics.incomeRate = calculateIncomeRate(state.metrics.moneyOverTime);
  state.metrics.hackingLevel = player.skills.hacking;
  state.metrics.stockValue = stockValue;
  
  // Check what tools we own
  state.hackingToolsOwned = HACKING_TOOLS.filter(tool => ns.fileExists(tool, 'home'));
  
  // Check 4S access
  state.has4SData = ns.stock.has4SData();
  state.has4STIX = ns.stock.has4SDataTIXAPI();
  
  // Check graft status
  const currentWork = ns.singularity.getCurrentWork();
  state.graftInProgress = currentWork?.type === 'GRAFTING';
  if (state.graftInProgress) {
    state.currentGraft = currentWork.augmentation;
  }
  
  // Check owned augs (including grafted)
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  state.graftsCompleted = GRAFT_PRIORITY.filter(aug => ownedAugs.includes(aug));
  state.metrics.totalAugsInstalled = ownedAugs.length;
  
  // Build aug queue for metrics
  state.augQueue = buildAugQueue(ns, state);
}

/** Calculate $/sec from recent money data */
function calculateIncomeRate(moneyOverTime) {
  if (moneyOverTime.length < 2) return 0;
  
  const recent = moneyOverTime.slice(-30); // Last 30 data points
  if (recent.length < 2) return 0;
  
  const oldest = recent[0];
  const newest = recent[recent.length - 1];
  const timeDiff = (newest.time - oldest.time) / 1000; // seconds
  const moneyDiff = newest.money - oldest.money;
  
  if (timeDiff <= 0) return 0;
  return moneyDiff / timeDiff;
}

// === CONTROL MODE ===

/**
 * Get a stable string representation of work for comparison
 * (Ignores fields that change every tick like cyclesWorked)
 */
function getWorkSignature(work) {
  if (!work) return 'idle';
  
  // Only include stable fields that indicate what the player is doing
  const stable = {
    type: work.type,
    // Faction/company work
    factionName: work.factionName,
    companyName: work.companyName,
    // Crime
    crimeType: work.crimeType,
    // Grafting
    augmentation: work.augmentation,
    // Class/gym
    classType: work.classType,
    location: work.location,
  };
  
  return JSON.stringify(stable);
}

/** @param {NS} ns */
function updateControlMode(ns, state, debug = false) {
  const currentWork = ns.singularity.getCurrentWork();
  const currentWorkSig = getWorkSignature(currentWork);
  
  // Detect manual action: work changed unexpectedly (not by us)
  if (state.lastPlayerWork !== null && currentWorkSig !== state.lastPlayerWork) {
    // Check if this was a change we initiated
    if (!state.lastActionWasOurs) {
      // Work changed and it wasn't us - manual action detected
      state.lastPlayerAction = Date.now();
      if (debug) {
        ns.print(`DEBUG: Work changed (not ours): ${state.lastPlayerWork} -> ${currentWorkSig}`);
      }
    } else if (debug) {
      ns.print(`DEBUG: Work changed (ours): ${state.lastPlayerWork} -> ${currentWorkSig}`);
    }
  }
  
  // Reset the flag - next change is assumed manual unless we set this again
  state.lastActionWasOurs = false;
  state.lastPlayerWork = currentWorkSig;
  
  // Check if idle long enough for auto-control
  const idleTime = Date.now() - state.lastPlayerAction;
  if (idleTime > CONFIG.CRUISE_CONTROL_TIMEOUT) {
    if (state.mode !== 'AUTO') {
      ns.print(`INFO: Player idle for ${(idleTime/1000).toFixed(0)}s, switching to AUTO mode`);
    }
    state.mode = 'AUTO';
  } else {
    if (state.mode !== 'MANUAL') {
      ns.print(`INFO: Manual action detected, switching to MANUAL mode (idle: ${(idleTime/1000).toFixed(0)}s)`);
    }
    state.mode = 'MANUAL';
  }
}

// === PHASE MANAGEMENT ===

/** @param {NS} ns */
function updatePhase(ns, state) {
  const oldPhase = state.phase;
  const money = ns.getServerMoneyAvailable('home');
  
  // Determine current phase based on state
  if (!allHackingToolsOwned(state)) {
    state.phase = Phase.BOOTSTRAP;
  } 
  else if (!hasEarlyGrafts(state) || !isRamSaturated(ns, state)) {
    state.phase = Phase.EARLY_ACCELERATION;
  }
  else if (!state.has4SData || !state.has4STIX) {
    state.phase = Phase.PASSIVE_INCOME;
  }
  else if (!hasMidGameGrafts(state)) {
    state.phase = Phase.INVESTMENT;
  }
  else {
    state.phase = Phase.RESET_PREP;
  }
  
  // Track phase timing
  if (oldPhase !== state.phase) {
    const now = Date.now();
    const timeInOldPhase = now - state.metrics.phaseStartTime;
    state.metrics.phaseTimings[oldPhase] += timeInOldPhase;
    state.metrics.phaseStartTime = now;
    ns.print(`PHASE: ${oldPhase} -> ${state.phase}`);
  }
}

function allHackingToolsOwned(state) {
  return HACKING_TOOLS.every(tool => state.hackingToolsOwned.includes(tool));
}

function hasEarlyGrafts(state) {
  const earlyGrafts = GRAFT_PRIORITY.slice(0, 4); // First 6 are early game
  return earlyGrafts.every(aug => state.graftsCompleted.includes(aug));
}

function hasMidGameGrafts(state) {
  const midGrafts = GRAFT_PRIORITY.slice(4, 8); // Next 4 are mid game
  return midGrafts.every(aug => state.graftsCompleted.includes(aug));
}

/** @param {NS} ns */
function isRamSaturated(ns, state) {
  // TODO: Read from shared file written by orchestrator.js
  // For now, use a placeholder heuristic
  // Return true if we detect high share thread ratio
  
  // Placeholder: check if we have "enough" RAM
  const servers = ns.getPurchasedServers();
  const totalRam = servers.reduce((sum, s) => sum + ns.getServerMaxRam(s), 0);
  
  return totalRam >= CONFIG.MIN_RAM_FOR_SATURATION;
}

// === FINANCIAL MANAGEMENT ===

/** @param {NS} ns */
async function manageFinances(ns, state, args) {
  const money = ns.getServerMoneyAvailable('home');
  
  // Determine if we need liquid cash for an upcoming purchase
  const upcomingCost = getNextPurchaseCost(ns, state);
  const shortfall = upcomingCost - money;
  const needLiquidCash = upcomingCost > 0 && shortfall > 0;
  
  // If we need cash, check if liquidating would actually help
  if (needLiquidCash && state.stockTraderRunning) {
    const stockValue = getStockPortfolioValue(ns);
    
    // Only liquidate if stocks can cover at least 50% of the shortfall
    // This prevents pointless liquidation when stocks are nearly empty
    if (stockValue > shortfall * 0.5) {
      ns.print(`INFO: Need $${ns.formatNumber(upcomingCost)} - liquidating stocks (have $${ns.formatNumber(stockValue)} in stocks)`);
      if (!args['dry-run']) {
        await stopStockTrader(ns, state);
        liquidateStocks(ns);
        // Set a cooldown to prevent immediate restart
        state.lastLiquidation = Date.now();
      }
    } else if (args.debug) {
      ns.print(`DEBUG: Need $${ns.formatNumber(shortfall)} but stocks only worth $${ns.formatNumber(stockValue)} - not liquidating`);
    }
  }
  
  // If we don't need cash and have 4S, start stock trader
  // But add a cooldown after liquidation to let purchases happen
  const liquidationCooldown = 5000; // 5 seconds
  const timeSinceLiquidation = Date.now() - (state.lastLiquidation || 0);
  
  if (!needLiquidCash && 
      state.has4SData && 
      state.has4STIX && 
      !state.stockTraderRunning &&
      timeSinceLiquidation > liquidationCooldown) {
    ns.print(`INFO: Starting stock trader`);
    if (!args['dry-run']) {
      await startStockTrader(ns, state);
    }
  }
}

/**
 * Get total value of stock portfolio
 * @param {NS} ns
 * @returns {number}
 */
function getStockPortfolioValue(ns) {
  let total = 0;
  const symbols = ns.stock.getSymbols();
  
  for (const sym of symbols) {
    const [shares, avgPrice, sharesShort, avgPriceShort] = ns.stock.getPosition(sym);
    if (shares > 0) {
      total += shares * ns.stock.getBidPrice(sym);
    }
    if (sharesShort > 0) {
      // Short value is more complex but approximate
      total += sharesShort * (2 * avgPriceShort - ns.stock.getAskPrice(sym));
    }
  }
  
  return total;
}

/** @param {NS} ns */
function getNextPurchaseCost(ns, state) {
  // Return the cost of the next thing we want to buy
  // Only return costs for things we can actually buy RIGHT NOW
  
  // Phase 1: Hacking tools
  for (const tool of HACKING_TOOLS) {
    if (!state.hackingToolsOwned.includes(tool)) {
      return ns.singularity.getDarkwebProgramCost(tool);
    }
  }
  
  // Phase 2/3: 4S access
  if (!state.has4SData) return CONFIG.FOUR_S_DATA_COST;
  if (!state.has4STIX) return CONFIG.FOUR_S_TIX_API_COST;
  
  // Phase 2/4: Next graft - but ONLY if not currently grafting
  // And NOT during reset_prep phase (we want to keep money for augs)
  if (!state.graftInProgress && state.phase !== Phase.RESET_PREP) {
    const nextGraft = getNextGraft(ns, state);
    if (nextGraft) {
      return ns.grafting.getAugmentationGraftPrice(nextGraft);
    }
  }
  
  return 0;
}

/** @param {NS} ns */
function getNextGraft(ns, state) {
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const money = ns.getServerMoneyAvailable('home');
  
  // First, check priority grafts
  for (const aug of GRAFT_PRIORITY) {
    // Skip if already owned
    if (ownedAugs.includes(aug)) continue;
    
    // Check if we can actually graft this (it exists and we meet prereqs)
    try {
      const price = ns.grafting.getAugmentationGraftPrice(aug);
      const time = ns.grafting.getAugmentationGraftTime(aug);
      
      // If we got here without error, the aug is available for grafting
      // Check prereqs
      const prereqs = ns.singularity.getAugmentationPrereq(aug);
      const hasPrereqs = prereqs.every(p => ownedAugs.includes(p));
      
      if (hasPrereqs) {
        return aug;
      }
    } catch (e) {
      // Aug doesn't exist or can't be grafted - skip it
      continue;
    }
  }
  
  // If all priority grafts done, check opportunistic late-game grafts
  const opportunisticGrafts = [
    "QLink",                    // $75t - 75% hack skill
    "violet Congruity Implant", // $150t - removes graft penalties
  ];
  
  for (const aug of opportunisticGrafts) {
    if (ownedAugs.includes(aug)) continue;
    
    try {
      const price = ns.grafting.getAugmentationGraftPrice(aug);
      
      // Only graft if we can comfortably afford it (have 1.5x the cost)
      if (money < price * 1.5) continue;
      
      const prereqs = ns.singularity.getAugmentationPrereq(aug);
      const hasPrereqs = prereqs.every(p => ownedAugs.includes(p));
      
      if (hasPrereqs) {
        return aug;
      }
    } catch (e) {
      continue;
    }
  }
  
  return null;
}

/** @param {NS} ns */
async function startStockTrader(ns, state) {
  if (state.stockTraderRunning) return;
  
  const pid = ns.exec('stock-trader-4s.js', 'nexus');
  if (pid > 0) {
    state.stockTraderPID = pid;
    state.stockTraderRunning = true;
    ns.print(`INFO: Stock trader started (PID: ${pid})`);
  } else {
    ns.print(`WARN: Failed to start stock trader`);
  }
}

/** @param {NS} ns */
async function stopStockTrader(ns, state) {
  if (!state.stockTraderRunning) return;
  
  if (state.stockTraderPID > 0) {
    ns.kill(state.stockTraderPID);
  }
  // Also try killing by name in case PID is stale
  ns.scriptKill('stock-trader-4s.js', 'nexus');
  
  state.stockTraderRunning = false;
  state.stockTraderPID = -1;
  ns.print(`INFO: Stock trader stopped`);
}

/** @param {NS} ns */
function liquidateStocks(ns) {
  const symbols = ns.stock.getSymbols();
  for (const sym of symbols) {
    const [shares, avgPrice, sharesShort, avgPriceShort] = ns.stock.getPosition(sym);
    if (shares > 0) {
      ns.stock.sellStock(sym, shares);
    }
    if (sharesShort > 0) {
      ns.stock.sellShort(sym, sharesShort);
    }
  }
  ns.print(`INFO: All stocks liquidated`);
}

// === PHASE LOGIC ===

/** @param {NS} ns */
async function executePhaseLogic(ns, state, args) {
  switch (state.phase) {
    case Phase.BOOTSTRAP:
      await executeBootstrap(ns, state, args);
      break;
    case Phase.EARLY_ACCELERATION:
      await executeEarlyAcceleration(ns, state, args);
      break;
    case Phase.PASSIVE_INCOME:
      await executePassiveIncome(ns, state, args);
      break;
    case Phase.INVESTMENT:
      await executeInvestment(ns, state, args);
      break;
    case Phase.RESET_PREP:
      await executeResetPrep(ns, state, args);
      break;
  }
}

/** @param {NS} ns */
async function executeBootstrap(ns, state, args) {
  const money = ns.getServerMoneyAvailable('home');
  
  // Buy TOR router if needed
  if (!ns.hasTorRouter() && money >= 200000) {
    if (!args['dry-run']) {
      ns.singularity.purchaseTor();
      ns.print(`INFO: Purchased TOR router`);
    }
  }
  
  // Buy hacking tools
  for (const tool of HACKING_TOOLS) {
    if (!state.hackingToolsOwned.includes(tool)) {
      const cost = ns.singularity.getDarkwebProgramCost(tool);
      if (money >= cost && cost > 0) {
        if (!args['dry-run']) {
          ns.singularity.purchaseProgram(tool);
          ns.print(`INFO: Purchased ${tool}`);
        }
      }
      break; // One at a time
    }
  }
  
  // TODO: Buy minimum server RAM
}

/** @param {NS} ns */
async function executeEarlyAcceleration(ns, state, args) {
  // Focus on cheap grafts and server RAM
  
  if (!state.graftInProgress) {
    const nextGraft = getNextGraft(ns, state);
    const earlyGrafts = GRAFT_PRIORITY.slice(0, 6);
    
    if (nextGraft && earlyGrafts.includes(nextGraft)) {
      const cost = ns.grafting.getAugmentationGraftPrice(nextGraft);
      const money = ns.getServerMoneyAvailable('home');
      
      if (money >= cost) {
        if (!args['dry-run']) {
          // Travel to New Tokyo for grafting
          ns.singularity.travelToCity('New Tokyo');
          const success = ns.grafting.graftAugmentation(nextGraft, false);
          if (success) {
            state.graftInProgress = true; // Set immediately to prevent player action override
            state.currentGraft = nextGraft;
            state.lastActionWasOurs = true;
            ns.print(`INFO: Started grafting ${nextGraft}`);
          }
        }
      }
    }
  }
  
  // TODO: Buy server RAM toward saturation
}

/** @param {NS} ns */
async function executePassiveIncome(ns, state, args) {
  const money = ns.getServerMoneyAvailable('home');
  
  // Buy 4S access
  if (!state.has4SData && money >= CONFIG.FOUR_S_DATA_COST) {
    if (!args['dry-run']) {
      ns.stock.purchase4SMarketData();
      ns.print(`INFO: Purchased 4S Market Data`);
    }
  }
  
  if (state.has4SData && !state.has4STIX && money >= CONFIG.FOUR_S_TIX_API_COST) {
    if (!args['dry-run']) {
      ns.stock.purchase4SMarketDataTixApi();
      ns.print(`INFO: Purchased 4S TIX API`);
    }
  }
}

/** @param {NS} ns */
async function executeInvestment(ns, state, args) {
  // Expensive grafts and home upgrades
  
  if (!state.graftInProgress) {
    const nextGraft = getNextGraft(ns, state);
    
    if (nextGraft) {
      const cost = ns.grafting.getAugmentationGraftPrice(nextGraft);
      const money = ns.getServerMoneyAvailable('home');
      
      if (money >= cost) {
        if (!args['dry-run']) {
          ns.singularity.travelToCity('New Tokyo');
          const success = ns.grafting.graftAugmentation(nextGraft, false);
          if (success) {
            state.graftInProgress = true; // Set immediately to prevent player action override
            state.currentGraft = nextGraft;
            state.lastActionWasOurs = true;
            ns.print(`INFO: Started grafting ${nextGraft}`);
          }
        }
      }
    }
  }
  
  // TODO: Home RAM/cores purchases
}

/** @param {NS} ns */
async function executeResetPrep(ns, state, args) {
  // Build aug purchase queue
  const queue = buildAugQueue(ns, state);
  state.queuedAugs = queue.augs;
  
  if (args.debug) {
    ns.print(`DEBUG: Aug queue: ${queue.augs.length} augs, total cost: $${ns.formatNumber(queue.totalCost)}`);
  }
  
  // Purchase augs if we have enough money and meet reset conditions
  // (Actual purchasing happens in executeReset)
  
  // Buy NeuroFlux Governor levels with remaining money after queue is affordable
  const money = ns.getServerMoneyAvailable('home');
  if (money > queue.totalCost * 1.5) {
    // We have significant extra money - could buy NFG levels
    // But don't actually buy until reset is confirmed
    if (args.debug) {
      ns.print(`DEBUG: Excess money available for NeuroFlux: $${ns.formatNumber(money - queue.totalCost)}`);
    }
  }
}

/**
 * Read orchestrator info from shared file
 * @param {NS} ns
 * @returns {{shareRatio: number, shareThreads: number, totalThreads: number} | null}
 */
function readOrchestratorInfo(ns) {
  try {
    if (!ns.fileExists(ORCHESTRATOR_INFO_FILE)) {
      return null;
    }
    const data = ns.read(ORCHESTRATOR_INFO_FILE);
    const info = JSON.parse(data);
    
    // Check if data is stale (older than 2 minutes)
    if (Date.now() - info.timestamp > 2 * 60 * 1000) {
      return null;
    }
    
    return info;
  } catch (e) {
    return null;
  }
}

// === AUG QUEUE LOGIC ===

const AUG_PRICE_MULTIPLIER = 1.9; // Each successive aug costs 1.9x more

// Key augs that should always be included if available
const KEY_AUGS = [
  // CRITICAL: The Red Pill is required to finish the BitNode
  "The Red Pill",
  // Hacking progression
  "Cranial Signal Processors - Gen I", "Cranial Signal Processors - Gen II",
  "Embedded Netburner Module", "Cranial Signal Processors - Gen III", "CRTX42-AA Gene Modification",
  "The Black Hand", "Cranial Signal Processors - Gen IV",
  "Social Negotiation Assistant (S.N.A)",
  "SmartSonar Implant",
  "PCMatrix",
  "BrachiBlades", "Bionic Legs", "Bionic Arms",
  "Cranial Signal Processors - Gen V", "BitRunners Neurolink",
];

/**
 * Build the optimal aug purchase queue
 * Respects prerequisites while maximizing expensive-first ordering
 * @param {NS} ns
 * @param {Object} state
 * @returns {{augs: string[], totalCost: number, affordable: boolean}}
 */
function buildAugQueue(ns, state) {
  const cash = ns.getServerMoneyAvailable('home');
  // Include stock value - we can liquidate before reset
  const stockValue = state.has4STIX ? getStockPortfolioValue(ns) : 0;
  const totalMoney = cash + stockValue;
  
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  
  // Get all available augs from joined factions (with prereq info)
  const availableAugs = getAvailableAugsWithPrereqs(ns, ownedAugs);
  
  // Sort by price descending (most expensive first) as a starting point
  availableAugs.sort((a, b) => b.price - a.price);
  
  // Build queue respecting prerequisites
  // We'll greedily add augs, but ensure prereqs come before dependents
  const queue = [];
  const queueSet = new Set();
  const ownedSet = new Set(ownedAugs);
  let totalCost = 0;
  
  // Keep trying to add augs until we can't add any more
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    
    for (const aug of availableAugs) {
      // Skip if already in queue
      if (queueSet.has(aug.name)) continue;
      
      // Check if all prereqs are satisfied (owned or in queue)
      const prereqsSatisfied = aug.prereqs.every(p => ownedSet.has(p) || queueSet.has(p));
      if (!prereqsSatisfied) continue;
      
      // Calculate cost at current queue position
      const queuePosition = queue.length;
      const multipliedPrice = aug.price * Math.pow(AUG_PRICE_MULTIPLIER, queuePosition);
      const newTotal = totalCost + multipliedPrice;
      
      // Check if we can afford it
      if (newTotal <= totalMoney) {
        queue.push(aug.name);
        queueSet.add(aug.name);
        totalCost = newTotal;
        madeProgress = true;
      }
    }
  }
  
  // Now reorder the queue optimally: prereqs must come before dependents,
  // but within those constraints, expensive first
  const orderedQueue = topologicalSortByPrice(ns, queue, ownedAugs);
  
  // Recalculate total cost with new ordering
  totalCost = 0;
  for (let i = 0; i < orderedQueue.length; i++) {
    const price = ns.singularity.getAugmentationPrice(orderedQueue[i]);
    totalCost += price * Math.pow(AUG_PRICE_MULTIPLIER, i);
  }
  
  // Check key augs
  const keyAugsAvailable = availableAugs.filter(a => KEY_AUGS.includes(a.name));
  const missingKeyAugs = keyAugsAvailable
    .map(a => a.name)
    .filter(name => !queueSet.has(name));
  
  return {
    augs: orderedQueue,
    totalCost: totalCost,
    affordable: totalCost <= totalMoney,
    allKeyAugsIncluded: missingKeyAugs.length === 0,
    missingKeyAugs: missingKeyAugs,
    keyAugsCount: orderedQueue.filter(name => KEY_AUGS.includes(name)).length,
  };
}

/**
 * Get all augs available for purchase, including prerequisite info
 * @param {NS} ns
 * @param {string[]} ownedAugs
 * @returns {{name: string, price: number, rep: number, faction: string, prereqs: string[]}[]}
 */
function getAvailableAugsWithPrereqs(ns, ownedAugs) {
  const available = [];
  const seen = new Set(ownedAugs);
  
  const allFactions = Object.values(ns.enums.FactionName);
  const joinedFactions = allFactions.filter(f => ns.singularity.getFactionRep(f) > 0);
  
  for (const faction of joinedFactions) {
    const factionRep = ns.singularity.getFactionRep(faction);
    const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
    
    for (const augName of factionAugs) {
      if (seen.has(augName)) continue;
      
      const repReq = ns.singularity.getAugmentationRepReq(augName);
      if (factionRep < repReq) continue;
      if (augName === "NeuroFlux Governor") continue;
      
      const price = ns.singularity.getAugmentationPrice(augName);
      const prereqs = ns.singularity.getAugmentationPrereq(augName);
      
      available.push({
        name: augName,
        price: price,
        rep: repReq,
        faction: faction,
        prereqs: prereqs,
      });
      
      seen.add(augName);
    }
  }
  
  return available;
}

/**
 * Topologically sort augs so prereqs come before dependents,
 * while preferring expensive augs earlier when possible
 * @param {NS} ns
 * @param {string[]} augs - List of aug names to sort
 * @param {string[]} ownedAugs - Already owned augs
 * @returns {string[]} - Sorted list
 */
function topologicalSortByPrice(ns, augs, ownedAugs) {
  const ownedSet = new Set(ownedAugs);
  const augSet = new Set(augs);
  
  // Build dependency graph (only for augs in our list)
  const prereqMap = new Map(); // aug -> prereqs that are in our list
  const dependentMap = new Map(); // aug -> augs that depend on it
  const priceMap = new Map();
  
  for (const aug of augs) {
    const prereqs = ns.singularity.getAugmentationPrereq(aug);
    const relevantPrereqs = prereqs.filter(p => augSet.has(p) && !ownedSet.has(p));
    prereqMap.set(aug, relevantPrereqs);
    priceMap.set(aug, ns.singularity.getAugmentationPrice(aug));
    
    for (const prereq of relevantPrereqs) {
      if (!dependentMap.has(prereq)) {
        dependentMap.set(prereq, []);
      }
      dependentMap.get(prereq).push(aug);
    }
  }
  
  // Kahn's algorithm with price-based priority
  const inDegree = new Map();
  for (const aug of augs) {
    inDegree.set(aug, prereqMap.get(aug).length);
  }
  
  // Start with augs that have no prereqs (in our list)
  // Sort by price descending so expensive ones come first
  const ready = augs
    .filter(aug => inDegree.get(aug) === 0)
    .sort((a, b) => priceMap.get(b) - priceMap.get(a));
  
  const result = [];
  
  while (ready.length > 0) {
    // Take the most expensive ready aug
    const aug = ready.shift();
    result.push(aug);
    
    // Update dependents
    const dependents = dependentMap.get(aug) || [];
    for (const dep of dependents) {
      inDegree.set(dep, inDegree.get(dep) - 1);
      if (inDegree.get(dep) === 0) {
        // Insert in sorted position by price
        const depPrice = priceMap.get(dep);
        let insertIdx = ready.findIndex(r => priceMap.get(r) < depPrice);
        if (insertIdx === -1) insertIdx = ready.length;
        ready.splice(insertIdx, 0, dep);
      }
    }
  }
  
  return result;
}

/**
 * Get all augs available for purchase from joined factions
 * @param {NS} ns
 * @param {string[]} ownedAugs - Already owned/queued augs
 * @returns {{name: string, price: number, rep: number, faction: string}[]}
 */
function getAvailableAugs(ns, ownedAugs) {
  const available = [];
  const seen = new Set(ownedAugs);
  
  // Get all factions we've joined
  const allFactions = Object.values(ns.enums.FactionName);
  const joinedFactions = allFactions.filter(f => ns.singularity.getFactionRep(f) > 0);
  
  for (const faction of joinedFactions) {
    const factionRep = ns.singularity.getFactionRep(faction);
    const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
    
    for (const augName of factionAugs) {
      // Skip if already owned or already added
      if (seen.has(augName)) continue;
      
      const repReq = ns.singularity.getAugmentationRepReq(augName);
      
      // Skip if we don't have enough rep
      if (factionRep < repReq) continue;
      
      // Skip NeuroFlux Governor - we handle that separately
      if (augName === "NeuroFlux Governor") continue;
      
      const price = ns.singularity.getAugmentationPrice(augName);
      
      available.push({
        name: augName,
        price: price,
        rep: repReq,
        faction: faction,
      });
      
      seen.add(augName);
    }
  }
  
  return available;
}

/**
 * Calculate how many NeuroFlux Governor levels we can buy after the main queue
 * @param {NS} ns
 * @param {number} remainingMoney - Money left after buying queued augs
 * @param {number} queueLength - Number of augs already in queue
 * @returns {{levels: number, cost: number}}
 */
function calculateNFGLevels(ns, remainingMoney, queueLength) {
  // Find a faction we can buy NFG from
  const allFactions = Object.values(ns.enums.FactionName);
  const joinedFactions = allFactions.filter(f => ns.singularity.getFactionRep(f) > 0);
  
  let nfgFaction = null;
  for (const faction of joinedFactions) {
    const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
    if (factionAugs.includes("NeuroFlux Governor")) {
      const repReq = ns.singularity.getAugmentationRepReq("NeuroFlux Governor");
      if (ns.singularity.getFactionRep(faction) >= repReq) {
        nfgFaction = faction;
        break;
      }
    }
  }
  
  if (!nfgFaction) {
    return { levels: 0, cost: 0 };
  }
  
  // Calculate how many levels we can afford
  // Each level's base price increases, and the multiplier stacks
  let levels = 0;
  let totalCost = 0;
  let currentMoney = remainingMoney;
  let currentIndex = queueLength;
  
  while (true) {
    // Get current NFG price (increases each level)
    const basePrice = ns.singularity.getAugmentationPrice("NeuroFlux Governor");
    const multipliedPrice = basePrice * Math.pow(AUG_PRICE_MULTIPLIER, currentIndex);
    
    if (multipliedPrice > currentMoney) break;
    
    levels++;
    totalCost += multipliedPrice;
    currentMoney -= multipliedPrice;
    currentIndex++;
    
    // Safety limit
    if (levels > 100) break;
  }
  
  return { levels, cost: totalCost, faction: nfgFaction };
}

// === PLAYER ACTION CONTROL ===

/** @param {NS} ns */
async function controlPlayerActions(ns, state, args) {
  // Don't interfere if grafting
  if (state.graftInProgress) return;
  
  const currentWork = ns.singularity.getCurrentWork();
  const player = ns.getPlayer();
  
  // Priority 0: If we need kills for faction unlock, commit homicide
  if (state.needKills > 0 && player.numPeopleKilled < state.needKills) {
    if (currentWork?.type !== 'CRIME' || currentWork?.crimeType !== 'Homicide') {
      if (!args['dry-run']) {
        ns.singularity.commitCrime('Homicide', false);
        state.lastActionWasOurs = true;
        ns.print(`INFO: Committing homicide for faction unlock (${player.numPeopleKilled}/${state.needKills} kills)`);
      }
    }
    return;
  }
  
  // Priority 0.5: If we need karma, commit crimes
  if (state.needKarma && player.karma > -90) { // -90 is worst needed (The Syndicate)
    if (currentWork?.type !== 'CRIME') {
      if (!args['dry-run']) {
        ns.singularity.commitCrime('Homicide', false); // Homicide gives good karma
        state.lastActionWasOurs = true;
        ns.print(`INFO: Committing crimes for karma (current: ${player.karma.toFixed(0)})`);
      }
    }
    return;
  }
  
  // Reset flags if requirements met
  if (state.needKills > 0 && player.numPeopleKilled >= state.needKills) {
    state.needKills = 0;
  }
  if (state.needKarma && player.karma <= -90) {
    state.needKarma = false;
  }
  
  // Normal priority work assignment
  const factionPriority = getFactionPriority(ns, false);
  const usedFactions = new Set(); // Player can work same as sleeves
  
  const needsReassign = shouldReassign(ns, currentWork, usedFactions, factionPriority, false);
  
  if (!needsReassign) {
    if (args.debug) {
      ns.print(`DEBUG: Player work OK - ${currentWork?.type || 'idle'}`);
    }
    return;
  }
  
  const assignment = getBestWorkAssignment(ns, {
    usedFactions,
    factionPriority,
    forSleeves: false,
    currentTask: currentWork,
  });
  
  if (assignment) {
    if (!args['dry-run']) {
      executePlayerAssignment(ns, assignment);
      state.lastActionWasOurs = true;
      ns.print(`INFO: Player assigned to ${assignment.type}: ${assignment.target || assignment.crimeType}`);
    } else {
      ns.print(`DRY-RUN: Would assign player to ${assignment.type}: ${assignment.target || assignment.crimeType}`);
    }
  }
}

// === RESET LOGIC ===

/** @param {NS} ns */
function checkResetConditions(ns, state) {
  // Never reset mid-graft
  if (state.graftInProgress) return false;
  
  // Never reset before minimum run time (give time to backdoor World Daemon, etc.)
  const runTime = Date.now() - state.metrics.startTime;
  if (runTime < CONFIG.MIN_RUN_TIME) {
    return false;
  }
  
  // Build fresh queue to check conditions
  const queue = buildAugQueue(ns, state);
  const queuedCount = queue.augs.length;
  
  // Check if we have The Red Pill (either in queue OR already installed)
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const hasRedPill = queue.augs.includes("The Red Pill") || ownedAugs.includes("The Red Pill");
  
  // Hard requirements - EITHER:
  // 1. Normal: 10+ augs and all key augs included
  // 2. Red Pill path: Have The Red Pill (allows NFG-only resets for difficult World Daemon)
  const normalHardMet = queuedCount >= CONFIG.MIN_AUGS_FOR_RESET && 
    (queue.allKeyAugsIncluded || queue.missingKeyAugs.length === 0);
  const redPillHardMet = hasRedPill;
  
  if (!normalHardMet && !redPillHardMet) {
    return false;
  }
  
  // Override triggers (reset immediately)
  if (queuedCount >= CONFIG.OVERRIDE_AUGS_FOR_RESET) {
    ns.print(`INFO: Override trigger - ${queuedCount} augs queued`);
    return true;
  }
  
  // If we have The Red Pill, always allow reset (it's the win condition)
  if (hasRedPill) {
    ns.print(`INFO: The Red Pill ${ownedAugs.includes("The Red Pill") ? 'installed' : 'queued'} - resetting for NFG stacks`);
    return true;
  }
  
  // Soft triggers (need 2+ to reset)
  let softTriggers = 0;
  
  // Good number of augs
  if (queuedCount >= CONFIG.GOOD_AUGS_FOR_RESET) {
    softTriggers++;
  }
  
  // Can't afford the next aug we want (diminishing returns)
  const money = ns.getServerMoneyAvailable('home');
  const nextAugCost = getNextUnaffordableAugCost(ns, state, queue);
  if (nextAugCost > 0 && money < nextAugCost * 0.1) {
    // Current money is less than 10% of next aug - we'd be waiting a long time
    softTriggers++;
  }
  
  // All companies at optimal thresholds
  const companiesOptimal = checkCompaniesAtThresholds(ns);
  if (companiesOptimal) {
    softTriggers++;
  }
  
  return softTriggers >= 2;
}

/**
 * Get the cost of the next aug we want but can't afford
 * @param {NS} ns
 * @param {Object} state
 * @param {Object} queue - Current queue from buildAugQueue
 * @returns {number} - Cost of next unaffordable aug, or 0 if none
 */
function getNextUnaffordableAugCost(ns, state, queue) {
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const availableAugs = getAvailableAugs(ns, ownedAugs);
  
  // Find augs not in the queue
  const notInQueue = availableAugs.filter(a => !queue.augs.includes(a.name));
  
  if (notInQueue.length === 0) return 0;
  
  // Sort by price and return the cheapest one we couldn't fit
  notInQueue.sort((a, b) => a.price - b.price);
  
  // Calculate what it would cost to add to the queue
  const queueLength = queue.augs.length;
  const nextAugMultipliedCost = notInQueue[0].price * Math.pow(AUG_PRICE_MULTIPLIER, queueLength);
  
  return queue.totalCost + nextAugMultipliedCost;
}

/**
 * Check if all needed companies are at optimal thresholds
 * @param {NS} ns
 * @returns {boolean}
 */
function checkCompaniesAtThresholds(ns) {
  const corps = Object.values(ns.enums.CompanyName);
  const factions = Object.values(ns.enums.FactionName);

  // Explicit company → faction mapping for exceptions
  const COMPANY_TO_FACTION_OVERRIDES = {
    "Fulcrum Technologies": "Fulcrum Secret Technologies",
  };

  // Build megacorp list with correct faction association
  const megacorps = corps
    .map(corp => {
      const faction =
        COMPANY_TO_FACTION_OVERRIDES[corp] ??
        (factions.includes(corp) ? corp : null);

      return faction ? { corp, faction } : null;
    })
    .filter(Boolean);

  for (const { corp, faction } of megacorps) {
    const factionRep = ns.singularity.getFactionRep(faction);
    const companyRep = ns.singularity.getCompanyRep(corp);

    // Skip if faction already unlocked
    if (factionRep > 0) continue;

    // Check if at optimal threshold (25k) or fully unlocked (400k)
    if (
      companyRep < REP_CONFIG.COMPANY_REP_FAVOR_THRESHOLD &&
      companyRep < REP_CONFIG.COMPANY_REP_FACTION_UNLOCK
    ) {
      return false;
    }
  }

  return true;
}

/** @param {NS} ns */
async function executeReset(ns, state) {
  ns.print(`\n=== EXECUTING RESET ===`);
  
  // Build final queue
  const queue = buildAugQueue(ns, state);
  ns.print(`Augs to purchase: ${queue.augs.length}`);
  ns.print(`Total cost: $${ns.formatNumber(queue.totalCost)}`);
  ns.print(`Time in run: ${formatTime(Date.now() - state.metrics.startTime)}`);
  
  // Log final metrics
  logMetrics(ns, state);
  
  // Stop stock trader and liquidate
  await stopStockTrader(ns, state);
  liquidateStocks(ns);
  
  // Wait a moment for funds to settle
  await ns.sleep(1000);
  
  // Purchase augs in order (most expensive first)
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const availableAugs = getAvailableAugs(ns, ownedAugs);
  const augMap = new Map(availableAugs.map(a => [a.name, a]));
  
  let purchasedCount = 0;
  for (const augName of queue.augs) {
    const aug = augMap.get(augName);
    if (!aug) {
      ns.print(`WARN: Aug ${augName} not found in available augs`);
      continue;
    }
    
    const success = ns.singularity.purchaseAugmentation(aug.faction, augName);
    if (success) {
      purchasedCount++;
      ns.print(`Purchased: ${augName} from ${aug.faction}`);
    } else {
      ns.print(`FAILED: ${augName} from ${aug.faction}`);
    }
  }
  
  ns.print(`\nPurchased ${purchasedCount}/${queue.augs.length} augs`);
  
  // Buy home cores with remaining money (before NFG - cores speed up money gain)
  let coresBought = 0;
  while (true) {
    const coreCost = ns.singularity.getUpgradeHomeCoresCost();
    const money = ns.getServerMoneyAvailable('home');
    if (coreCost > money || coreCost === Infinity) break;
    
    const success = ns.singularity.upgradeHomeCores();
    if (!success) break;
    coresBought++;
  }
  if (coresBought > 0) {
    ns.print(`Purchased ${coresBought} home cores`);
  }
  
  // Buy home RAM with remaining money (after cores)
  let ramUpgrades = 0;
  while (true) {
    const ramCost = ns.singularity.getUpgradeHomeRamCost();
    const money = ns.getServerMoneyAvailable('home');
    if (ramCost > money || ramCost === Infinity) break;
    
    const success = ns.singularity.upgradeHomeRam();
    if (!success) break;
    ramUpgrades++;
  }
  if (ramUpgrades > 0) {
    ns.print(`Purchased ${ramUpgrades} home RAM upgrades (now ${ns.getServerMaxRam('home')} GB)`);
  }
  
  // Buy NeuroFlux Governor levels with remaining money
  const remainingMoney = ns.getServerMoneyAvailable('home');
  const nfg = calculateNFGLevels(ns, remainingMoney, purchasedCount);
  
  if (nfg.levels > 0) {
    ns.print(`\nBuying ${nfg.levels} NeuroFlux Governor levels...`);
    for (let i = 0; i < nfg.levels; i++) {
      const success = ns.singularity.purchaseAugmentation(nfg.faction, "NeuroFlux Governor");
      if (!success) {
        ns.print(`Stopped at NFG level ${i} - purchase failed`);
        break;
      }
    }
  }
  
  // Final count
  const finalMoney = ns.getServerMoneyAvailable('home');
  ns.print(`\nRemaining money: $${ns.formatNumber(finalMoney)}`);
  ns.print(`Installing augmentations and resetting...`);
  
  // Install and restart
  ns.singularity.installAugmentations("start.js");
}

// === LOGGING ===

/** @param {NS} ns */
function logMetrics(ns, state) {
  const runtime = Date.now() - state.metrics.startTime;
  const money = ns.getServerMoneyAvailable('home');
  
  ns.print(`\n=== METRICS ===`);
  ns.print(`Runtime: ${formatTime(runtime)}`);
  ns.print(`Phase: ${state.phase}`);
  ns.print(`Mode: ${state.mode}`);
  ns.print(`Money: $${ns.formatNumber(money)} (+ $${ns.formatNumber(state.metrics.stockValue || 0)} in stocks)`);
  ns.print(`Income: $${ns.formatNumber(state.metrics.incomeRate)}/sec`);
  ns.print(`Hacking: ${state.metrics.hackingLevel}`);
  ns.print(`Grafts completed: ${state.graftsCompleted.length}`);
  ns.print(`Grafting: ${state.graftInProgress ? state.currentGraft : 'no'}`);
  ns.print(`Stock trader: ${state.stockTraderRunning ? 'running' : 'stopped'}`);
  ns.print(`4S Data: ${state.has4SData} | 4S TIX: ${state.has4STIX}`);
  
  // Aug queue info
  if (state.augQueue) {
    const q = state.augQueue;
    ns.print(`\n--- Aug Queue ---`);
    ns.print(`Queued: ${q.augs.length} augs (need ${CONFIG.MIN_AUGS_FOR_RESET} min, ${CONFIG.GOOD_AUGS_FOR_RESET} good, ${CONFIG.OVERRIDE_AUGS_FOR_RESET} override)`);
    ns.print(`Queue cost: $${ns.formatNumber(q.totalCost)}`);
    ns.print(`Key augs: ${q.allKeyAugsIncluded ? 'all included' : `missing ${q.missingKeyAugs.length}`}`);
    if (q.missingKeyAugs.length > 0 && q.missingKeyAugs.length <= 3) {
      ns.print(`  Missing: ${q.missingKeyAugs.join(', ')}`);
    }
  }
  
  // Soft trigger status (only show in reset_prep phase)
  if (state.phase === Phase.RESET_PREP) {
    ns.print(`\n--- Reset Triggers ---`);
    const triggers = getResetTriggerStatus(ns, state);
    ns.print(`Hard requirements: ${triggers.hardMet ? '✓' : '✗'}`);
    if (!triggers.hardMet) {
      ns.print(`  ${triggers.hardReason}`);
    }
    ns.print(`Soft triggers: ${triggers.softCount}/2 needed`);
    for (const [name, met] of Object.entries(triggers.soft)) {
      ns.print(`  ${met ? '✓' : '✗'} ${name}`);
    }
    if (triggers.override) {
      ns.print(`OVERRIDE: ${triggers.overrideReason}`);
    }
  }
  
  ns.print(`\nPhase timings:`);
  for (const [phase, time] of Object.entries(state.metrics.phaseTimings)) {
    if (time > 0) {
      ns.print(`  ${phase}: ${formatTime(time)}`);
    }
  }
  ns.print(`===============\n`);
}

/**
 * Get detailed status of reset triggers
 * @param {NS} ns
 * @param {Object} state
 * @returns {Object}
 */
function getResetTriggerStatus(ns, state) {
  const queue = state.augQueue || buildAugQueue(ns, state);
  const queuedCount = queue.augs.length;
  const money = ns.getServerMoneyAvailable('home');
  const runTime = Date.now() - state.metrics.startTime;
  
  // Check if we have The Red Pill (either in queue OR already installed)
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const redPillInQueue = queue.augs.includes("The Red Pill");
  const redPillInstalled = ownedAugs.includes("The Red Pill");
  const hasRedPill = redPillInQueue || redPillInstalled;
  
  const result = {
    hardMet: true,
    hardReason: '',
    soft: {},
    softCount: 0,
    override: false,
    overrideReason: '',
  };
  
  // Hard requirements - check all conditions
  const normalHardMet = queuedCount >= CONFIG.MIN_AUGS_FOR_RESET && 
    (queue.allKeyAugsIncluded || queue.missingKeyAugs.length === 0);
  const minTimeMet = runTime >= CONFIG.MIN_RUN_TIME;
  
  if (state.graftInProgress) {
    result.hardMet = false;
    result.hardReason = 'Graft in progress';
  } else if (!minTimeMet) {
    result.hardMet = false;
    const remaining = CONFIG.MIN_RUN_TIME - runTime;
    result.hardReason = `Minimum run time not met (${formatTime(remaining)} remaining)`;
  } else if (!normalHardMet && !hasRedPill) {
    result.hardMet = false;
    if (queuedCount < CONFIG.MIN_AUGS_FOR_RESET) {
      result.hardReason = `Only ${queuedCount}/${CONFIG.MIN_AUGS_FOR_RESET} augs queued`;
    } else {
      result.hardReason = `Missing ${queue.missingKeyAugs.length} key augs`;
    }
  }
  
  // Override check
  if (queuedCount >= CONFIG.OVERRIDE_AUGS_FOR_RESET) {
    result.override = true;
    result.overrideReason = `${queuedCount} augs queued (>= ${CONFIG.OVERRIDE_AUGS_FOR_RESET})`;
  }
  
  // Red Pill override
  if (hasRedPill) {
    result.override = true;
    result.overrideReason = redPillInstalled 
      ? 'The Red Pill installed - reset for NFG stacks to finish BitNode'
      : 'The Red Pill queued - install to finish BitNode';
  }
  
  // Soft triggers
  result.soft[`${CONFIG.GOOD_AUGS_FOR_RESET}+ augs queued`] = queuedCount >= CONFIG.GOOD_AUGS_FOR_RESET;
  if (result.soft[`${CONFIG.GOOD_AUGS_FOR_RESET}+ augs queued`]) result.softCount++;
  
  const nextAugCost = getNextUnaffordableAugCost(ns, state, queue);
  const diminishingReturns = nextAugCost > 0 && money < nextAugCost * 0.1;
  result.soft['Diminishing returns (money < 10% next aug)'] = diminishingReturns;
  if (diminishingReturns) result.softCount++;
  
  const companiesOptimal = checkCompaniesAtThresholds(ns);
  result.soft['All companies at thresholds'] = companiesOptimal;
  if (companiesOptimal) result.softCount++;
  
  return result;
}

/** @param {NS} ns */
function logDebugStatus(ns, state) {
  ns.print(`[${state.phase}] Mode:${state.mode} | $${ns.formatNumber(ns.getServerMoneyAvailable('home'))} | ${ns.formatNumber(state.metrics.incomeRate)}/s`);
}

// === UTILITIES ===

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}