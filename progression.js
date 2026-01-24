/**
 * progression.js - Master orchestration script for automated BitNode progression
 * 
 * Runs on 'nexus' server with 256-512GB RAM available.
 * Controls: purchases, player actions, grafting, stock trading, reset decisions
 */

import {
  getPriorityJobs,
  getPriorityJob,
  getPlayerStats,
  getCompanyThresholdStatus,
  CompanyThresholdStatus,
  FAVOR_DONATION_THRESHOLD,
  REP_FOR_DONATION_FAVOR,
} from "utils/priorityJobs.js";

import {
  isRamSaturated
} from "utils/ram.js";

// === CONFIGURATION ===

const LOG_FILE = '/data/reset-log.json';

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
  
  // Company rep thresholds
  COMPANY_REP_FAVOR_THRESHOLD: 25000,
  COMPANY_REP_FACTION_UNLOCK: 400000,
  
  // Donation config
  DEPRIORITIZE_DONATABLE_FACTIONS: true, // Set false in money-scarce bitnodes
  DONATION_COST_PER_REP: 1e6,            // Base cost: $1M per 1 rep (modified by multipliers)
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
const FACTION_ENEMIES = {
  "Sector-12": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  "Aevum": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  "Chongqing": ["Sector-12", "Aevum", "Volhaven"],
  "New Tokyo": ["Sector-12", "Aevum", "Volhaven"],
  "Ishima": ["Sector-12", "Aevum", "Volhaven"],
  "Volhaven": ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima"],
};

// Faction requirements
const FACTION_REQUIREMENTS = {
  "CyberSec": { type: "backdoor", server: "CSEC" },
  "NiteSec": { type: "backdoor", server: "avmnite-02h" },
  "The Black Hand": { type: "backdoor", server: "I.I.I.I" },
  "BitRunners": { type: "backdoor", server: "run4theh111z" },
  
  "Sector-12": { type: "city", city: "Sector-12", money: 15e6 },
  "Aevum": { type: "city", city: "Aevum", money: 40e6 },
  "Chongqing": { type: "city", city: "Chongqing", money: 20e6 },
  "New Tokyo": { type: "city", city: "New Tokyo", money: 20e6 },
  "Ishima": { type: "city", city: "Ishima", money: 30e6 },
  "Volhaven": { type: "city", city: "Volhaven", money: 50e6 },
  "Tian Di Hui": { type: "city", city: ["Chongqing", "New Tokyo", "Ishima"], money: 1e6, hacking: 50 },
  
  "Slum Snakes": { type: "crime", combat: 30, karma: -9, money: 1e6 },
  "Tetrads": { type: "crime", city: ["Chongqing", "New Tokyo", "Ishima"], combat: 75, karma: -18 },
  "The Syndicate": { type: "crime", city: ["Aevum", "Sector-12"], hacking: 200, combat: 200, karma: -90, money: 10e6 },
  "The Dark Army": { type: "crime", city: "Chongqing", hacking: 300, combat: 300, karma: -45, kills: 5 },
  "Speakers for the Dead": { type: "crime", hacking: 100, combat: 300, karma: -45, kills: 30 },
  
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
  
  "Netburners": { type: "special", hacking: 80, hacknetLevels: 100, hacknetRAM: 8, hacknetCores: 4 },
  "Daedalus": { type: "special", hacking: 2500, augs: 30, money: 100e9 },
  "The Covenant": { type: "special", hacking: 850, combat: 850, augs: 20, money: 75e9 },
  "Illuminati": { type: "special", hacking: 1500, combat: 1200, augs: 30, money: 150e9 },
};

// Priority order for joining factions (lower index = higher priority)
const FACTION_PRIORITY = [
  "Daedalus",
  "CyberSec", "NiteSec", "The Black Hand", "BitRunners",
  "Tian Di Hui", "Aevum", "Sector-12",
  "Slum Snakes", "Tetrads", "The Syndicate", "Speakers for the Dead", "The Dark Army",
  "ECorp", "MegaCorp", "Blade Industries", "Four Sigma", "KuaiGong International",
  "NWO", "OmniTek Incorporated", "Clarke Incorporated", "Bachman & Associates",
  "Fulcrum Secret Technologies",
  "Chongqing", "New Tokyo", "Ishima", "Volhaven",
  "Netburners", "The Covenant", "Illuminati",
];

// === STATE ===

/** @param {NS} ns */
function createInitialState(ns) {
  return {
    // Control mode
    mode: 'AUTO',
    lastPlayerAction: Date.now(),
    lastPlayerWork: null,
    lastActionWasOurs: false,
    
    // Current phase
    phase: Phase.BOOTSTRAP,
    
    // Stock trader
    stockTraderRunning: false,
    stockTraderPID: -1,
    lastLiquidation: 0,
    
    // Grafting
    graftInProgress: false,
    currentGraft: null,
    graftsCompleted: [],
    
    // Faction unlock progress
    needKills: 0,
    needKarma: false,
    
    // Purchases
    hackingToolsOwned: [],
    has4SData: false,
    has4STIX: false,
    
    // Queued augs for reset
    queuedAugs: [],
    
    // Aug queue (rebuilt each cycle)
    augQueue: null,
    
    // Current priority job (from priorityJobs system)
    currentPriorityJob: null,
    
    // Company threshold status
    companyThresholdStatus: null,
    
    // Metrics tracking
    metrics: {
      startTime: ns.getResetInfo().lastAugReset,
      phaseStartTime: Date.now(),
      moneyOverTime: [],
      incomeRate: 0,
      stockValue: 0,
      hackingLevel: 1,
      totalAugsInstalled: 0,
      graftsThisReset: 0,
      resetsCompleted: 0,
      
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
 */
function handleFactionInvitations(ns, state, args) {
  const invitations = ns.singularity.checkFactionInvitations();
  if (invitations.length === 0) return;
  
  const joinedFactions = getJoinedFactions(ns);
  
  const sortedInvitations = [...invitations].sort((a, b) => {
    const priorityA = FACTION_PRIORITY.indexOf(a);
    const priorityB = FACTION_PRIORITY.indexOf(b);
    const adjA = priorityA === -1 ? 999 : priorityA;
    const adjB = priorityB === -1 ? 999 : priorityB;
    return adjA - adjB;
  });
  
  for (const faction of sortedInvitations) {
    if (!needAugsFromFaction(ns, faction)) {
      if (args.debug) {
        ns.print(`DEBUG: Skipping ${faction} - no needed augs`);
      }
      continue;
    }
    
    if (wouldConflictWithJoined(faction, joinedFactions)) {
      if (args.debug) {
        ns.print(`DEBUG: Skipping ${faction} - conflicts with joined faction`);
      }
      continue;
    }
    
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

function getJoinedFactions(ns) {
  const allFactions = Object.values(ns.enums.FactionName);
  return allFactions.filter(f => ns.singularity.getFactionRep(f) > 0);
}

function wouldConflictWithJoined(faction, joinedFactions) {
  const enemies = FACTION_ENEMIES[faction];
  if (!enemies) return false;
  return enemies.some(enemy => joinedFactions.includes(enemy));
}

function needAugsFromFaction(ns, faction) {
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
  
  for (const aug of factionAugs) {
    if (aug === "NeuroFlux Governor") continue;
    if (!ownedAugs.includes(aug)) {
      return true;
    }
  }
  return false;
}

/**
 * Work towards unlocking factions that we haven't joined yet
 */
function workTowardsFactionsUnlock(ns, state, args) {
  const joinedFactions = getJoinedFactions(ns);
  const invitations = ns.singularity.checkFactionInvitations();
  const player = ns.getPlayer();
  
  for (const faction of FACTION_PRIORITY) {
    if (joinedFactions.includes(faction)) continue;
    if (invitations.includes(faction)) continue;
    if (wouldConflictWithJoined(faction, joinedFactions)) continue;
    
    const req = FACTION_REQUIREMENTS[faction];
    if (!req) continue;
    
    const action = getActionToUnlockFaction(ns, faction, req, player);
    if (action) {
      if (args.debug) {
        ns.print(`DEBUG: To unlock ${faction}: ${action.type} - ${action.detail}`);
      }
      return action;
    }
  }
  
  return null;
}

function getActionToUnlockFaction(ns, faction, req, player) {
  const money = ns.getServerMoneyAvailable('home');
  
  switch (req.type) {
    case "city": {
      if (req.money && money < req.money) return null;
      if (req.hacking && player.skills.hacking < req.hacking) return null;
      
      const validCities = Array.isArray(req.city) ? req.city : [req.city];
      if (!validCities.includes(player.city)) {
        return {
          type: "travel",
          detail: `Travel to ${validCities[0]}`,
          city: validCities[0],
        };
      }
      return null;
    }
    
    case "crime": {
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
      if (req.karma && player.karma > req.karma) {
        return { type: "need_karma", detail: `Need ${req.karma} karma (have ${player.karma.toFixed(0)})` };
      }
      if (req.kills && player.numPeopleKilled < req.kills) {
        return {
          type: "need_kills",
          detail: `Need ${req.kills} kills (have ${player.numPeopleKilled})`,
          kills: req.kills,
        };
      }
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
      const threshold = req.server ? 300000 : 400000;
      
      if (companyRep < threshold) {
        return {
          type: "need_company_rep",
          detail: `Need ${threshold/1000}k rep at ${req.company} (have ${(companyRep/1000).toFixed(0)}k)`,
          company: req.company,
        };
      }
      return null;
    }
    
    case "endgame":
    case "special": {
      const installed = ns.singularity.getOwnedAugmentations(false).length;
      if (req.augments && installed < req.augments) {
        return { type: "need_augs", detail: `Need ${req.augments} installed augs (have ${installed})` };
      }
      if (req.augs && installed < req.augs) {
        return { type: "need_augs", detail: `Need ${req.augs} installed augs (have ${installed})` };
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

function executeFactionUnlockAction(ns, action, state) {
  switch (action.type) {
    case "travel":
      ns.singularity.travelToCity(action.city);
      state.lastActionWasOurs = true;
      ns.print(`INFO: Traveled to ${action.city}`);
      break;
      
    case "need_kills":
      state.needKills = action.kills;
      break;
      
    case "need_karma":
      state.needKarma = true;
      break;
      
    default:
      break;
  }
}

// === DONATION MANAGEMENT ===

/**
 * Check for factions where we can donate to buy rep
 * Returns donation opportunities sorted by priority
 */
function getDonationOpportunities(ns, state) {
  const opportunities = [];
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const joinedFactions = getJoinedFactions(ns);
  
  for (const faction of joinedFactions) {
    const favor = ns.singularity.getFactionFavor(faction);
    if (favor < FAVOR_DONATION_THRESHOLD) continue;
    
    const currentRep = ns.singularity.getFactionRep(faction);
    const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
    
    // Find augs we don't own and don't have enough rep for
    for (const aug of factionAugs) {
      if (aug === "NeuroFlux Governor") continue;
      if (ownedAugs.includes(aug)) continue;
      
      const repReq = ns.singularity.getAugmentationRepReq(aug);
      if (currentRep >= repReq) continue;
      
      const repNeeded = repReq - currentRep;
      // Cost formula: donation_amount = rep_wanted * 1e6 / rep_multiplier
      // For now use base cost; actual multiplier depends on player stats
      const estimatedCost = repNeeded * CONFIG.DONATION_COST_PER_REP;
      
      opportunities.push({
        faction,
        aug,
        currentRep,
        targetRep: repReq,
        repNeeded,
        estimatedCost,
        favor,
      });
    }
  }
  
  // Sort by rep needed (smallest first - quick wins)
  opportunities.sort((a, b) => a.repNeeded - b.repNeeded);
  
  return opportunities;
}

/**
 * Execute donation to buy reputation
 * @returns {boolean} Whether a donation was made
 */
function executeDonation(ns, state, args) {
  const money = ns.getServerMoneyAvailable('home');
  const opportunities = getDonationOpportunities(ns, state);
  
  if (opportunities.length === 0) return false;
  
  // Only donate if we have significant excess money
  // (Don't drain money needed for aug purchases)
  const augQueue = state.augQueue || buildAugQueue(ns, state);
  const reservedMoney = augQueue.totalCost * 1.2; // Keep 20% buffer
  const availableForDonation = money - reservedMoney;
  
  if (availableForDonation <= 0) {
    if (args.debug) {
      ns.print(`DEBUG: No money available for donation (have $${ns.formatNumber(money)}, reserved $${ns.formatNumber(reservedMoney)})`);
    }
    return false;
  }
  
  // Find the best donation opportunity we can afford
  for (const opp of opportunities) {
    if (opp.estimatedCost > availableForDonation) continue;
    
    if (!args['dry-run']) {
      // Donate to faction
      const success = ns.singularity.donateToFaction(opp.faction, opp.estimatedCost);
      if (success) {
        ns.print(`INFO: Donated $${ns.formatNumber(opp.estimatedCost)} to ${opp.faction} for ${opp.aug}`);
        return true;
      } else {
        ns.print(`WARN: Failed to donate to ${opp.faction}`);
      }
    } else {
      ns.print(`DRY-RUN: Would donate $${ns.formatNumber(opp.estimatedCost)} to ${opp.faction} for ${opp.aug}`);
      return true;
    }
  }
  
  return false;
}

// === MAIN LOOP ===

/** @param {NS} ns */
export async function main(ns) {
  const args = ns.flags([
    ['manual', false],
    ['dry-run', false],
    ['debug', false],
    ['no-donate', false], // Disable donation purchasing
  ]);
  
  ns.disableLog('ALL');
  ns.ui.openTail();
  ns.print('=== progression.js starting ===');
  
  const state = createInitialState(ns);
  let lastMetricsLog = Date.now();
  
  while (true) {
    try {
      await updateGameState(ns, state);
      
      if (!args.manual) {
        updateControlMode(ns, state, args.debug);
      } else {
        state.mode = 'MANUAL';
      }
      
      updatePhase(ns, state);
      handleFactionInvitations(ns, state, args);
      
      const factionAction = workTowardsFactionsUnlock(ns, state, args);
      if (factionAction && !args['dry-run']) {
        executeFactionUnlockAction(ns, factionAction, state);
      }
      
      await manageFinances(ns, state, args);
      await executePhaseLogic(ns, state, args);
      
      // Handle donations (if enabled and in appropriate phase)
      if (!args['no-donate'] && (state.phase === Phase.INVESTMENT || state.phase === Phase.RESET_PREP)) {
        executeDonation(ns, state, args);
      }
      
      if (state.mode === 'AUTO') {
        await controlPlayerActions(ns, state, args);
      }
      
      const shouldReset = checkResetConditions(ns, state);
      if (shouldReset && !args['dry-run']) {
        await executeReset(ns, state);
      }
      
      if (Date.now() - lastMetricsLog > CONFIG.METRICS_LOG_INTERVAL) {
        logMetrics(ns, state);
        lastMetricsLog = Date.now();
      }
      
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

async function updateGameState(ns, state) {
  const player = ns.getPlayer();
  
  const now = Date.now();
  const currentMoney = ns.getServerMoneyAvailable('home');
  
  const stockValue = state.has4STIX ? getStockPortfolioValue(ns) : 0;
  const totalWealth = currentMoney + stockValue;
  
  state.metrics.moneyOverTime.push({ time: now, money: totalWealth });
  if (state.metrics.moneyOverTime.length > 60) {
    state.metrics.moneyOverTime.shift();
  }
  
  state.metrics.incomeRate = calculateIncomeRate(state.metrics.moneyOverTime);
  state.metrics.hackingLevel = player.skills.hacking;
  state.metrics.stockValue = stockValue;
  
  state.hackingToolsOwned = HACKING_TOOLS.filter(tool => ns.fileExists(tool, 'home'));
  
  state.has4SData = ns.stock.has4SData();
  state.has4STIX = ns.stock.has4SDataTIXAPI();
  
  const currentWork = ns.singularity.getCurrentWork();
  state.graftInProgress = currentWork?.type === 'GRAFTING';
  if (state.graftInProgress) {
    state.currentGraft = currentWork.augmentation;
  }
  
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  state.graftsCompleted = GRAFT_PRIORITY.filter(aug => ownedAugs.includes(aug));
  state.metrics.totalAugsInstalled = ownedAugs.length;
  
  state.augQueue = buildAugQueue(ns, state);
  
  // Update current priority job
  const playerStats = getPlayerStats(ns);
  const priorityJobConfig = { deprioritizeDonatable: CONFIG.DEPRIORITIZE_DONATABLE_FACTIONS };
  state.currentPriorityJob = getPriorityJob(ns, playerStats, false, new Set(), priorityJobConfig);
  
  // Update company threshold status
  state.companyThresholdStatus = getCompanyThresholdStatus(ns);
}

function calculateIncomeRate(moneyOverTime) {
  if (moneyOverTime.length < 2) return 0;
  
  const recent = moneyOverTime.slice(-30);
  if (recent.length < 2) return 0;
  
  const oldest = recent[0];
  const newest = recent[recent.length - 1];
  const timeDiff = (newest.time - oldest.time) / 1000;
  const moneyDiff = newest.money - oldest.money;
  
  if (timeDiff <= 0) return 0;
  return moneyDiff / timeDiff;
}

// === CONTROL MODE ===

function getWorkSignature(work) {
  if (!work) return 'idle';
  
  const stable = {
    type: work.type,
    factionName: work.factionName,
    companyName: work.companyName,
    crimeType: work.crimeType,
    augmentation: work.augmentation,
    classType: work.classType,
    location: work.location,
  };
  
  return JSON.stringify(stable);
}

function updateControlMode(ns, state, debug = false) {
  const currentWork = ns.singularity.getCurrentWork();
  const currentWorkSig = getWorkSignature(currentWork);
  
  if (state.lastPlayerWork !== null && currentWorkSig !== state.lastPlayerWork) {
    if (!state.lastActionWasOurs) {
      state.lastPlayerAction = Date.now();
      if (debug) {
        ns.print(`DEBUG: Work changed (not ours): ${state.lastPlayerWork} -> ${currentWorkSig}`);
      }
    } else if (debug) {
      ns.print(`DEBUG: Work changed (ours): ${state.lastPlayerWork} -> ${currentWorkSig}`);
    }
  }
  
  state.lastActionWasOurs = false;
  state.lastPlayerWork = currentWorkSig;
  
  const idleTime = Date.now() - state.lastPlayerAction;
  if (idleTime > CONFIG.CRUISE_CONTROL_TIMEOUT) {
    if (state.mode !== 'AUTO') {
      ns.print(`INFO: Player idle for ${(idleTime/1000).toFixed(0)}s, switching to AUTO mode`);
    }
    state.mode = 'AUTO';
  } else {
    if (state.mode !== 'MANUAL') {
      ns.print(`INFO: Manual action detected, switching to MANUAL mode`);
    }
    state.mode = 'MANUAL';
  }
}

// === PHASE MANAGEMENT ===

function updatePhase(ns, state) {
  const oldPhase = state.phase;
  const money = ns.getServerMoneyAvailable('home');
  
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
  const earlyGrafts = GRAFT_PRIORITY.slice(0, 4);
  return earlyGrafts.every(aug => state.graftsCompleted.includes(aug));
}

function hasMidGameGrafts(state) {
  const midGrafts = GRAFT_PRIORITY.slice(4, 8);
  return midGrafts.every(aug => state.graftsCompleted.includes(aug));
}

// === FINANCIAL MANAGEMENT ===

async function manageFinances(ns, state, args) {
  const money = ns.getServerMoneyAvailable('home');
  
  const upcomingCost = getNextPurchaseCost(ns, state);
  const shortfall = upcomingCost - money;
  const needLiquidCash = upcomingCost > 0 && shortfall > 0;
  
  if (needLiquidCash && state.stockTraderRunning) {
    const stockValue = getStockPortfolioValue(ns);
    
    if (stockValue > shortfall * 0.5) {
      ns.print(`INFO: Need $${ns.formatNumber(upcomingCost)} - liquidating stocks`);
      if (!args['dry-run']) {
        await stopStockTrader(ns, state);
        liquidateStocks(ns);
        state.lastLiquidation = Date.now();
      }
    } else if (args.debug) {
      ns.print(`DEBUG: Need $${ns.formatNumber(shortfall)} but stocks only worth $${ns.formatNumber(stockValue)}`);
    }
  }
  
  const liquidationCooldown = 5000;
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

function getStockPortfolioValue(ns) {
  let total = 0;
  const symbols = ns.stock.getSymbols();
  
  for (const sym of symbols) {
    const [shares, avgPrice, sharesShort, avgPriceShort] = ns.stock.getPosition(sym);
    if (shares > 0) {
      total += shares * ns.stock.getBidPrice(sym);
    }
    if (sharesShort > 0) {
      total += sharesShort * (2 * avgPriceShort - ns.stock.getAskPrice(sym));
    }
  }
  
  return total;
}

function getNextPurchaseCost(ns, state) {
  for (const tool of HACKING_TOOLS) {
    if (!state.hackingToolsOwned.includes(tool)) {
      return ns.singularity.getDarkwebProgramCost(tool);
    }
  }
  
  if (!state.has4SData) return CONFIG.FOUR_S_DATA_COST;
  if (!state.has4STIX) return CONFIG.FOUR_S_TIX_API_COST;
  
  if (!state.graftInProgress && state.phase !== Phase.RESET_PREP) {
    const nextGraft = getNextGraft(ns, state);
    if (nextGraft) {
      return ns.grafting.getAugmentationGraftPrice(nextGraft);
    }
  }
  
  return 0;
}

function getNextGraft(ns, state) {
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const money = ns.getServerMoneyAvailable('home');
  
  for (const aug of GRAFT_PRIORITY) {
    if (ownedAugs.includes(aug)) continue;
    
    try {
      const price = ns.grafting.getAugmentationGraftPrice(aug);
      const prereqs = ns.singularity.getAugmentationPrereq(aug);
      const hasPrereqs = prereqs.every(p => ownedAugs.includes(p));
      
      if (hasPrereqs) {
        return aug;
      }
    } catch (e) {
      continue;
    }
  }
  
  const opportunisticGrafts = [
    "QLink",
    "violet Congruity Implant",
  ];
  
  for (const aug of opportunisticGrafts) {
    if (ownedAugs.includes(aug)) continue;
    
    try {
      const price = ns.grafting.getAugmentationGraftPrice(aug);
      
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

async function stopStockTrader(ns, state) {
  if (!state.stockTraderRunning) return;
  
  if (state.stockTraderPID > 0) {
    ns.kill(state.stockTraderPID);
  }
  ns.scriptKill('stock-trader-4s.js', 'nexus');
  
  state.stockTraderRunning = false;
  state.stockTraderPID = -1;
  ns.print(`INFO: Stock trader stopped`);
}

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

async function executeBootstrap(ns, state, args) {
  const money = ns.getServerMoneyAvailable('home');
  
  if (!ns.hasTorRouter() && money >= 200000) {
    if (!args['dry-run']) {
      ns.singularity.purchaseTor();
      ns.print(`INFO: Purchased TOR router`);
    }
  }
  
  for (const tool of HACKING_TOOLS) {
    if (!state.hackingToolsOwned.includes(tool)) {
      const cost = ns.singularity.getDarkwebProgramCost(tool);
      if (money >= cost && cost > 0) {
        if (!args['dry-run']) {
          ns.singularity.purchaseProgram(tool);
          ns.print(`INFO: Purchased ${tool}`);
        }
      }
      break;
    }
  }
}

async function executeEarlyAcceleration(ns, state, args) {
  if (!state.graftInProgress) {
    const nextGraft = getNextGraft(ns, state);
    const earlyGrafts = GRAFT_PRIORITY.slice(0, 4);
    
    if (nextGraft && earlyGrafts.includes(nextGraft)) {
      const cost = ns.grafting.getAugmentationGraftPrice(nextGraft);
      const money = ns.getServerMoneyAvailable('home');
      
      if (money >= cost) {
        if (!args['dry-run']) {
          ns.singularity.travelToCity('New Tokyo');
          const success = ns.grafting.graftAugmentation(nextGraft, false);
          if (success) {
            state.graftInProgress = true;
            state.currentGraft = nextGraft;
            state.lastActionWasOurs = true;
            ns.print(`INFO: Started grafting ${nextGraft}`);
          }
        }
      }
    }
  }
}

async function executePassiveIncome(ns, state, args) {
  const money = ns.getServerMoneyAvailable('home');
  
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

async function executeInvestment(ns, state, args) {
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
            state.graftInProgress = true;
            state.currentGraft = nextGraft;
            state.lastActionWasOurs = true;
            ns.print(`INFO: Started grafting ${nextGraft}`);
          }
        }
      }
    }
  }
}

async function executeResetPrep(ns, state, args) {
  const queue = buildAugQueue(ns, state);
  state.queuedAugs = queue.augs;
  
  if (args.debug) {
    ns.print(`DEBUG: Aug queue: ${queue.augs.length} augs, total cost: $${ns.formatNumber(queue.totalCost)}`);
  }
  
  const money = ns.getServerMoneyAvailable('home');
  if (money > queue.totalCost * 1.5) {
    if (args.debug) {
      ns.print(`DEBUG: Excess money available for NeuroFlux: $${ns.formatNumber(money - queue.totalCost)}`);
    }
  }
}

// === PLAYER ACTION CONTROL ===

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
  if (state.needKarma && player.karma > -90) {
    if (currentWork?.type !== 'CRIME') {
      if (!args['dry-run']) {
        ns.singularity.commitCrime('Homicide', false);
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
  
  // Use priorityJobs system for work assignment
  const priorityJob = state.currentPriorityJob;
  
  if (!priorityJob) {
    if (args.debug) {
      ns.print(`DEBUG: No priority job available`);
    }
    return;
  }
  
  // Check if we're already doing this job
  const isAlreadyWorking = isWorkingOnJob(currentWork, priorityJob);
  
  if (isAlreadyWorking) {
    if (args.debug) {
      ns.print(`DEBUG: Already working on priority job: ${priorityJob.type} ${priorityJob.name}`);
    }
    return;
  }
  
  // Execute the priority job
  if (!args['dry-run']) {
    const success = executeJob(ns, priorityJob, state);
    if (success) {
      state.lastActionWasOurs = true;
      ns.print(`INFO: Player assigned to ${priorityJob.type}: ${priorityJob.name} (${priorityJob.activity})`);
    } else {
      ns.print(`WARN: Failed to assign player to ${priorityJob.type}: ${priorityJob.name}`);
    }
  } else {
    ns.print(`DRY-RUN: Would assign player to ${priorityJob.type}: ${priorityJob.name} (${priorityJob.activity})`);
  }
}

/**
 * Check if current work matches the priority job
 */
function isWorkingOnJob(currentWork, job) {
  if (!currentWork) return false;
  
  if (job.type === "faction") {
    return currentWork.type === "FACTION" && currentWork.factionName === job.name;
  } else if (job.type === "company") {
    return currentWork.type === "COMPANY" && currentWork.companyName === job.name;
  }
  
  return false;
}

/**
 * Execute a job from the priority system
 * @returns {boolean} Whether the job was successfully started
 */
function executeJob(ns, job, state) {
  if (job.type === "faction") {
    // Work for faction
    try {
      const success = ns.singularity.workForFaction(job.name, job.activity, false);
      return success;
    } catch (e) {
      ns.print(`ERROR: Failed to work for faction ${job.name}: ${e}`);
      return false;
    }
  } else if (job.type === "company") {
    // First, make sure we have a job at this company
    // Try to apply if we don't
    const jobs = ns.singularity.getCompanyPositions(job.name);
    
    // Check if we're employed at this company
    const player = ns.getPlayer();
    const currentJob = player.jobs[job.name];
    
    if (!currentJob) {
      // Need to apply for a job first
      // Try software positions first (higher rep gain), then others
      const positionPriority = ["Software Engineer", "IT Intern", "Business Intern", "Security Guard"];
      let applied = false;
      
      for (const position of positionPriority) {
        if (jobs.includes(position)) {
          const success = ns.singularity.applyToCompany(job.name, position);
          if (success) {
            ns.print(`INFO: Applied for ${position} at ${job.name}`);
            applied = true;
            break;
          }
        }
      }
      
      // If no specific position worked, try any available
      if (!applied) {
        for (const position of jobs) {
          const success = ns.singularity.applyToCompany(job.name, position);
          if (success) {
            ns.print(`INFO: Applied for ${position} at ${job.name}`);
            applied = true;
            break;
          }
        }
      }
      
      if (!applied) {
        ns.print(`WARN: Could not get a job at ${job.name}`);
        return false;
      }
    }
    
    // Now work for the company
    try {
      const success = ns.singularity.workForCompany(job.name, false);
      return success;
    } catch (e) {
      ns.print(`ERROR: Failed to work for company ${job.name}: ${e}`);
      return false;
    }
  }
  
  return false;
}

// === AUG QUEUE LOGIC ===

const AUG_PRICE_MULTIPLIER = 1.9;

const KEY_AUGS = [
  "The Red Pill",
  "Cranial Signal Processors - Gen I", "Cranial Signal Processors - Gen II",
  "Embedded Netburner Module", "Cranial Signal Processors - Gen III", "CRTX42-AA Gene Modification",
  "The Black Hand", "Cranial Signal Processors - Gen IV",
  "Social Negotiation Assistant (S.N.A)",
  "SmartSonar Implant",
  "PCMatrix",
  "BrachiBlades", "Bionic Legs", "Bionic Arms",
  "Cranial Signal Processors - Gen V", "BitRunners Neurolink",
];

function buildAugQueue(ns, state) {
  const cash = ns.getServerMoneyAvailable('home');
  const stockValue = state.has4STIX ? getStockPortfolioValue(ns) : 0;
  const totalMoney = cash + stockValue;
  
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const ownedSet = new Set(ownedAugs);
  
  const availableAugs = getAvailableAugsWithPrereqs(ns, ownedAugs);
  const augMap = new Map(availableAugs.map(a => [a.name, a]));
  
  const keyAugSet = new Set();
  function addWithPrereqs(augName) {
    if (keyAugSet.has(augName)) return;
    if (ownedSet.has(augName)) return;
    if (!augMap.has(augName)) return;
    
    const aug = augMap.get(augName);
    for (const prereq of aug.prereqs) {
      addWithPrereqs(prereq);
    }
    keyAugSet.add(augName);
  }
  
  for (const keyAug of KEY_AUGS) {
    if (augMap.has(keyAug)) {
      addWithPrereqs(keyAug);
    }
  }
  
  const keyAugsWithPrereqs = availableAugs.filter(a => keyAugSet.has(a.name));
  const otherAugs = availableAugs.filter(a => !keyAugSet.has(a.name));
  
  keyAugsWithPrereqs.sort((a, b) => b.price - a.price);
  otherAugs.sort((a, b) => b.price - a.price);
  
  const queue = [];
  const queueSet = new Set();
  let totalCost = 0;
  
  function tryAddAug(aug) {
    if (queueSet.has(aug.name)) return false;
    
    const prereqsSatisfied = aug.prereqs.every(p => ownedSet.has(p) || queueSet.has(p));
    if (!prereqsSatisfied) return false;
    
    const queuePosition = queue.length;
    const multipliedPrice = aug.price * Math.pow(AUG_PRICE_MULTIPLIER, queuePosition);
    const newTotal = totalCost + multipliedPrice;
    
    if (newTotal <= totalMoney) {
      queue.push(aug.name);
      queueSet.add(aug.name);
      totalCost = newTotal;
      return true;
    }
    return false;
  }
  
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const aug of keyAugsWithPrereqs) {
      if (tryAddAug(aug)) {
        madeProgress = true;
      }
    }
  }
  
  madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const aug of otherAugs) {
      if (tryAddAug(aug)) {
        madeProgress = true;
      }
    }
  }
  
  const orderedQueue = topologicalSortByPrice(ns, queue, ownedAugs);
  
  totalCost = 0;
  for (let i = 0; i < orderedQueue.length; i++) {
    const price = ns.singularity.getAugmentationPrice(orderedQueue[i]);
    totalCost += price * Math.pow(AUG_PRICE_MULTIPLIER, i);
  }
  
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

function getAvailableAugsWithPrereqs(ns, ownedAugs) {
  const available = [];
  const seen = new Set(ownedAugs);
  const ownedSet = new Set(ownedAugs);
  
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
  
  const toCheck = [...available];
  while (toCheck.length > 0) {
    const aug = toCheck.pop();
    
    for (const prereqName of aug.prereqs) {
      if (ownedSet.has(prereqName)) continue;
      if (seen.has(prereqName)) continue;
      
      for (const faction of joinedFactions) {
        const factionRep = ns.singularity.getFactionRep(faction);
        const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
        
        if (!factionAugs.includes(prereqName)) continue;
        
        const repReq = ns.singularity.getAugmentationRepReq(prereqName);
        if (factionRep < repReq) continue;
        
        const price = ns.singularity.getAugmentationPrice(prereqName);
        const prereqs = ns.singularity.getAugmentationPrereq(prereqName);
        
        const prereqAug = {
          name: prereqName,
          price: price,
          rep: repReq,
          faction: faction,
          prereqs: prereqs,
        };
        
        available.push(prereqAug);
        seen.add(prereqName);
        toCheck.push(prereqAug);
        break;
      }
    }
  }
  
  return available;
}

function topologicalSortByPrice(ns, augs, ownedAugs) {
  const ownedSet = new Set(ownedAugs);
  const augSet = new Set(augs);
  
  const prereqMap = new Map();
  const dependentMap = new Map();
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
  
  const inDegree = new Map();
  for (const aug of augs) {
    inDegree.set(aug, prereqMap.get(aug).length);
  }
  
  const ready = augs
    .filter(aug => inDegree.get(aug) === 0)
    .sort((a, b) => priceMap.get(b) - priceMap.get(a));
  
  const result = [];
  
  while (ready.length > 0) {
    const aug = ready.shift();
    result.push(aug);
    
    const dependents = dependentMap.get(aug) || [];
    for (const dep of dependents) {
      inDegree.set(dep, inDegree.get(dep) - 1);
      if (inDegree.get(dep) === 0) {
        const depPrice = priceMap.get(dep);
        let insertIdx = ready.findIndex(r => priceMap.get(r) < depPrice);
        if (insertIdx === -1) insertIdx = ready.length;
        ready.splice(insertIdx, 0, dep);
      }
    }
  }
  
  return result;
}

function calculateNFGLevels(ns, remainingMoney, queueLength) {
  const allFactions = Object.values(ns.enums.FactionName);
  const joinedFactions = allFactions.filter(f => ns.singularity.getFactionRep(f) > 0);
  
  // Find the faction with the HIGHEST rep that offers NFG
  // This maximizes the number of NFG levels we can buy, since rep requirement increases per level
  let nfgFaction = null;
  let highestRep = 0;
  
  for (const faction of joinedFactions) {
    const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
    if (factionAugs.includes("NeuroFlux Governor")) {
      const factionRep = ns.singularity.getFactionRep(faction);
      const initialRepReq = ns.singularity.getAugmentationRepReq("NeuroFlux Governor");
      
      // Must meet at least the initial requirement
      if (factionRep >= initialRepReq && factionRep > highestRep) {
        highestRep = factionRep;
        nfgFaction = faction;
      }
    }
  }
  
  if (!nfgFaction) {
    return { levels: 0, cost: 0 };
  }
  
  // NFG rep requirement multiplier per level (from game source)
  const NFG_REP_MULTIPLIER = 1.14;
  
  let levels = 0;
  let totalCost = 0;
  let currentMoney = remainingMoney;
  let currentIndex = queueLength;
  
  while (true) {
    // Check price constraint
    const basePrice = ns.singularity.getAugmentationPrice("NeuroFlux Governor");
    const multipliedPrice = basePrice * Math.pow(AUG_PRICE_MULTIPLIER, currentIndex);
    
    if (multipliedPrice > currentMoney) break;
    
    // Check rep constraint - rep requirement increases with each level we've bought
    // The game increases the rep req after each purchase, so we need to simulate that
    const currentRepReq = ns.singularity.getAugmentationRepReq("NeuroFlux Governor") * Math.pow(NFG_REP_MULTIPLIER, levels);
    
    if (highestRep < currentRepReq) break;
    
    levels++;
    totalCost += multipliedPrice;
    currentMoney -= multipliedPrice;
    currentIndex++;
    
    if (levels > 100) break;
  }
  
  return { levels, cost: totalCost, faction: nfgFaction, factionRep: highestRep };
}

// === RESET LOGIC ===

function checkResetConditions(ns, state) {
  if (state.graftInProgress) return false;
  
  const runTime = Date.now() - state.metrics.startTime;
  if (runTime < CONFIG.MIN_RUN_TIME) {
    return false;
  }
  
  const queue = buildAugQueue(ns, state);
  const queuedCount = queue.augs.length;
  
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const hasRedPill = queue.augs.includes("The Red Pill") || ownedAugs.includes("The Red Pill");
  
  const normalHardMet = queuedCount >= CONFIG.MIN_AUGS_FOR_RESET && 
    (queue.allKeyAugsIncluded || queue.missingKeyAugs.length === 0);
  const redPillHardMet = hasRedPill;
  
  if (!normalHardMet && !redPillHardMet) {
    return false;
  }
  
  if (queuedCount >= CONFIG.OVERRIDE_AUGS_FOR_RESET) {
    ns.print(`INFO: Override trigger - ${queuedCount} augs queued`);
    return true;
  }
  
  if (hasRedPill) {
    ns.print(`INFO: The Red Pill ${ownedAugs.includes("The Red Pill") ? 'installed' : 'queued'} - resetting`);
    return true;
  }
  
  let softTriggers = 0;
  
  if (queuedCount >= CONFIG.GOOD_AUGS_FOR_RESET) {
    softTriggers++;
  }
  
  const money = ns.getServerMoneyAvailable('home');
  const nextAugCost = getNextUnaffordableAugCost(ns, state, queue);
  if (nextAugCost > 0 && money < nextAugCost * 0.1) {
    softTriggers++;
  }
  
  // Use new threshold status system
  const thresholdStatus = getCompanyThresholdStatus(ns);
  const companiesOptimal = thresholdStatus.status !== CompanyThresholdStatus.COMPANIES_BELOW_THRESHOLD;
  if (companiesOptimal) {
    softTriggers++;
  }
  
  // Bonus: if all company factions unlocked, that's even better for reset
  if (thresholdStatus.status === CompanyThresholdStatus.COMPANY_FACTIONS_ALL_UNLOCKED) {
    softTriggers++;
  }
  
  if (runTime >= 24 * 60 * 60 * 1000) {
    softTriggers++;
  }
  
  return softTriggers >= 2;
}

function getNextUnaffordableAugCost(ns, state, queue) {
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const availableAugs = getAvailableAugsWithPrereqs(ns, ownedAugs);
  
  const notInQueue = availableAugs.filter(a => !queue.augs.includes(a.name));
  
  if (notInQueue.length === 0) return 0;
  
  notInQueue.sort((a, b) => a.price - b.price);
  
  const queueLength = queue.augs.length;
  const nextAugMultipliedCost = notInQueue[0].price * Math.pow(AUG_PRICE_MULTIPLIER, queueLength);
  
  return queue.totalCost + nextAugMultipliedCost;
}

async function executeReset(ns, state) {
  ns.print(`\n=== EXECUTING RESET ===`);
  
  const queue = buildAugQueue(ns, state);
  ns.print(`Augs to purchase: ${queue.augs.length}`);
  ns.print(`Total cost: $${ns.formatNumber(queue.totalCost)}`);
  ns.print(`Time in run: ${formatTime(Date.now() - state.metrics.startTime)}`);
  
  logMetrics(ns, state);
  
  await stopStockTrader(ns, state);
  liquidateStocks(ns);
  
  await ns.sleep(1000);
  
  const ownedAugs = ns.singularity.getOwnedAugmentations(true);
  const availableAugs = getAvailableAugsWithPrereqs(ns, ownedAugs);
  const augMap = new Map(availableAugs.map(a => [a.name, a]));
  const logs = [];
  
  let purchasedCount = 0;
  for (const augName of queue.augs) {
    const aug = augMap.get(augName);
    if (!aug) {
      logs.push(`WARN: Aug ${augName} not found`);
      continue;
    }
    
    const success = ns.singularity.purchaseAugmentation(aug.faction, augName);
    if (success) {
      purchasedCount++;
      logs.push(`Purchased: ${augName} from ${aug.faction}`);
    } else {
      logs.push(`FAILED: ${augName} from ${aug.faction}`);
    }
  }
  
  logs.push(`\nPurchased ${purchasedCount}/${queue.augs.length} augs`);
  
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
    logs.push(`Purchased ${coresBought} home cores`);
  }
  
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
    logs.push(`Purchased ${ramUpgrades} home RAM upgrades (now ${ns.getServerMaxRam('home')} GB)`);
  }
  
  const remainingMoney = ns.getServerMoneyAvailable('home');
  const nfg = calculateNFGLevels(ns, remainingMoney, purchasedCount);
  
  if (nfg.levels > 0) {
    logs.push(`\nBuying ${nfg.levels} NeuroFlux Governor levels...`);
    for (let i = 0; i < nfg.levels; i++) {
      const success = ns.singularity.purchaseAugmentation(nfg.faction, "NeuroFlux Governor");
      if (!success) {
        logs.push(`Stopped at NFG level ${i} - purchase failed`);
        break;
      }
    }
  }
  
  const finalMoney = ns.getServerMoneyAvailable('home');
  logs.push(`\nRemaining money: $${ns.formatNumber(finalMoney)}`);
  logs.push(`Installing augmentations and resetting...`);

  for(let i = 0; i < logs.length; i++) {
    ns.print(logs[i]);
  }

  ns.write(LOG_FILE, JSON.stringify(logs), 'a');
  ns.scp(LOG_FILE, "home", ns.getServer().hostname);
  
  ns.singularity.installAugmentations("start.js");
}

// === LOGGING ===

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
  
  // Priority job info
  if (state.currentPriorityJob) {
    const job = state.currentPriorityJob;
    ns.print(`\n--- Current Priority Job ---`);
    ns.print(`Type: ${job.type} | Target: ${job.name}`);
    ns.print(`Activity: ${job.activity}`);
    ns.print(`Rep: ${ns.formatNumber(job.currentRep)} / ${ns.formatNumber(job.targetRep)}`);
    if (job.type === "faction") {
      ns.print(`Target Aug: ${job.targetAug}`);
      if (job.canDonate) {
        ns.print(`💰 Can donate for rep (favor ≥150)`);
      }
    }
    if (job.isSilhouetteGrind) {
      ns.print(`🎭 Silhouette grind (CTO/CFO/CEO position)`);
    }
  }
  
  // Company threshold status
  if (state.companyThresholdStatus) {
    const cts = state.companyThresholdStatus;
    ns.print(`\n--- Company Status ---`);
    ns.print(`Status: ${cts.status}`);
    if (cts.status === CompanyThresholdStatus.COMPANY_FACTIONS_ALL_UNLOCKED) {
      const sil = cts.details.silhouetteEligible;
      if (sil.eligible) {
        ns.print(`Silhouette: ✓ Eligible (${sil.currentBest.position} at ${sil.currentBest.company})`);
      } else if (sil.currentBest) {
        ns.print(`Silhouette: Need ${ns.formatNumber(sil.repNeeded)} more rep at ${sil.currentBest.company}`);
        ns.print(`  Time units: ${ns.formatNumber(sil.timeUnits)} (favor: ${sil.currentBest.favor.toFixed(1)})`);
      }
    } else if (cts.details.factionsNotJoined) {
      ns.print(`Factions not joined: ${cts.details.factionsNotJoined.length}`);
      if (cts.details.belowMinThreshold.length > 0) {
        ns.print(`Below 35 favor after reset:`);
        for (const c of cts.details.belowMinThreshold) {
          ns.print(`  ${c.company}: ${c.favorAfterReset.toFixed(1)} favor (need ${ns.formatNumber(c.repNeeded)} more rep)`);
        }
      }
    }
  }
  
  if (state.augQueue) {
    const q = state.augQueue;
    ns.print(`\n--- Aug Queue ---`);
    ns.print(`Queued: ${q.augs.length} augs`);
    ns.print(`Queue cost: $${ns.formatNumber(q.totalCost)}`);
    ns.print(`Key augs: ${q.allKeyAugsIncluded ? 'all included' : `missing ${q.missingKeyAugs.length}`}`);
    if (q.missingKeyAugs.length > 0 && q.missingKeyAugs.length <= 3) {
      ns.print(`  Missing: ${q.missingKeyAugs.join(', ')}`);
    }
  }
  
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

function getResetTriggerStatus(ns, state) {
  const queue = state.augQueue || buildAugQueue(ns, state);
  const queuedCount = queue.augs.length;
  const money = ns.getServerMoneyAvailable('home');
  const runTime = Date.now() - state.metrics.startTime;
  
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
  
  if (queuedCount >= CONFIG.OVERRIDE_AUGS_FOR_RESET) {
    result.override = true;
    result.overrideReason = `${queuedCount} augs queued (>= ${CONFIG.OVERRIDE_AUGS_FOR_RESET})`;
  }
  
  if (hasRedPill) {
    result.override = true;
    result.overrideReason = redPillInstalled 
      ? 'The Red Pill installed - reset for NFG stacks'
      : 'The Red Pill queued - install to finish BitNode';
  }
  
  result.soft[`${CONFIG.GOOD_AUGS_FOR_RESET}+ augs queued`] = queuedCount >= CONFIG.GOOD_AUGS_FOR_RESET;
  if (result.soft[`${CONFIG.GOOD_AUGS_FOR_RESET}+ augs queued`]) result.softCount++;
  
  const nextAugCost = getNextUnaffordableAugCost(ns, state, queue);
  const diminishingReturns = nextAugCost > 0 && money < nextAugCost * 0.1;
  result.soft['Diminishing returns'] = diminishingReturns;
  if (diminishingReturns) result.softCount++;
  
  // Use new threshold status system
  const thresholdStatus = getCompanyThresholdStatus(ns);
  const companiesAtMin = thresholdStatus.status !== CompanyThresholdStatus.COMPANIES_BELOW_THRESHOLD;
  result.soft['Companies at min threshold (25k)'] = companiesAtMin;
  if (companiesAtMin) result.softCount++;
  
  const allFactionsUnlocked = thresholdStatus.status === CompanyThresholdStatus.COMPANY_FACTIONS_ALL_UNLOCKED;
  result.soft['All company factions unlocked'] = allFactionsUnlocked;
  if (allFactionsUnlocked) result.softCount++;
  
  const longRun = runTime >= 24 * 60 * 60 * 1000;
  result.soft['24+ hours since install'] = longRun;
  if (longRun) result.softCount++;
  
  return result;
}

function logDebugStatus(ns, state) {
  const job = state.currentPriorityJob;
  const jobStr = job ? `${job.type}:${job.name}` : 'none';
  ns.print(`[${state.phase}] Mode:${state.mode} | Job:${jobStr} | $${ns.formatNumber(ns.getServerMoneyAvailable('home'))}`);
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