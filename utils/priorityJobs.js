/**
 * Priority Jobs Script
 * Returns up to 8 prioritized jobs (faction work or company work)
 * based on "time units" remaining to reach the next goal.
 * 
 * Time units = remaining_rep / (1 + favor_bonus)
 * Lower time units = higher priority (closer to goal)
 * 
 * Exception: Daedalus + "The Red Pill" is always highest priority.
 */

const KEY_AUGS = [
  "Cranial Signal Processors - Gen I", "Cranial Signal Processors - Gen II", //Cybersec
  "Embedded Netburner Module", "Cranial Signal Processors - Gen III", "CRTX42-AA Gene Modification", //Nitesec
  "The Black Hand", //Black hand
  "Social Negotiation Assistant (S.N.A)", //Tian Di Hua ex - faction rep gain! only 6.5k
  "SmartSonar Implant", //Slum snakes ex
  "PCMatrix", //Aevum ex
  "INFRARET Enhancement", //Ishima ex
  "NutriGen Implant", //NeoTokyo ex
  "Neuregen Gene Modification", //Chongqing ex
  "DermaForce Particle Barrier", //Volhaven ex
  "BrachiBlades", //Syndicate ex
  "Bionic Legs", "Bionic Arms", //(Bionic legs and arms are prerequisites for end stage augs)
  "Cranial Signal Processors - Gen V", //BitRunners exclusive
  "Artificial Bio-neural Network Implant", //medium hack skill, hack power speed etc. Not great for sleeves but it's only 25k more than Gen V above - easy pickup
  "OmniTek InfoLoad", //+25% hacking skill/xp OmniTek
  "Xanipher", //+20% all skills
  "SmartJaw", //+50% charisma skill, xp, +25% factions & companies (high priority)
  "Enhanced Social Interaction Implant", //+60% cha stuff (4sigma)
  "CordiARC Fusion Reactor", //+35% all combat skills, +35% combat xp, pretty great! (megacorp ex))
  "Graphene BrachiBlades Upgrade", //upgrades for life of crime
  "Graphene Bionic Spine Upgrade", //+60% all combat skills, freakin awesome for sleeves (ecorp, )
  "Graphene Bionic Arms Upgrade",
  "Graphene Bionic Legs Upgrade", //+150% agi, super useful for covenant + illuminati (megacorp, ecorp)
  "Graphene Bone Lacings",
  "SPTN-97 Gene Modification", //+75% all combat skills, +15% for hacking, even more awesome! (covenant ex)
  "PC Direct-Neural Interface", //+30% rep, prereq for following two (omnitek, ecorp)
  "PC Direct-Neural Interface Optimization Submodule", //+75% rep from companies (fulcrum, ecorp)
  "PC Direct-Neural Interface NeuroNet Injector", //+100% rep from companies, essential for unlocking more factions, (fulcrum exclusive)
  "Neotra", //+55% STR, DEX
  "Hydroflame Left Arm", //+180% STR, last priority hopefully
  "nextSENS Gene Modification", //+20% all skills clarke ex
  "Photosynthetic Cells", //KG ex, +40% to 3 combat skills
  "The Red Pill" //obviously!!!
];

// Company -> Faction mapping
const COMPANY_FACTION_MAP = {
  "ECorp": "ECorp",
  "MegaCorp": "MegaCorp",
  "Blade Industries": "Blade Industries",
  "Four Sigma": "Four Sigma",
  "KuaiGong International": "KuaiGong International",
  "Fulcrum Technologies": "Fulcrum Secret Technologies",
  "NWO": "NWO",
  "OmniTek Incorporated": "OmniTek Incorporated",
  "Clarke Incorporated": "Clarke Incorporated",
  "Bachman & Associates": "Bachman & Associates",
};

// Reverse mapping: Faction -> Company
const FACTION_COMPANY_MAP = Object.fromEntries(
  Object.entries(COMPANY_FACTION_MAP).map(([k, v]) => [v, k])
);

// Company priority order for initial unlocking
// Rationale:
// 1. ECorp - PC Direct-Neural Interface prereq, Graphene Bionic Spine/Legs (+60% combat, +150% agi)
// 2. OmniTek - Also has PC Direct-Neural prereq, OmniTek InfoLoad (+25% hacking)
// 3. Fulcrum - PC Direct-Neural NeuroNet Injector (+100% company rep) - needs prereq first!
// 4. Bachman - SmartJaw (+25% faction & company rep, +50% charisma)
// 5. MegaCorp - CordiARC Fusion Reactor (+35% combat stats & XP), also has Graphene Legs
// 6. NWO - Xanipher (+20% all skills)
// 7. Clarke - nextSENS Gene Modification (+20% all skills)
// 8. KuaiGong - Photosynthetic Cells (+40% combat stats)
// 9. Blade Industries - Neotra (+55% STR/DEX)
// 10. Four Sigma - Enhanced Social Interaction Implant (+60% charisma) - lower priority
//
// TODO: Build analysis script to optimize this order based on current aug ownership
const COMPANY_PRIORITY_ORDER = [
  "ECorp",
  "OmniTek Incorporated",
  "Fulcrum Technologies",
  "Bachman & Associates",
  "MegaCorp",
  "NWO",
  "Clarke Incorporated",
  "KuaiGong International",
  "Blade Industries",
  "Four Sigma",
];

// All megacorp companies that unlock factions (in priority order)
const MEGACORP_COMPANIES = COMPANY_PRIORITY_ORDER;

// Thresholds
const COMPANY_INITIAL_REP_GOAL = 25000;   // First goal: establish favor base
const COMPANY_FACTION_UNLOCK_REP = 400000; // Second goal: unlock faction

// Favor donation threshold
// At 150 favor, you can donate money to buy reputation directly
// 150 favor requires ~460k historical rep (calculated from favor formula)
// Formula: rep = 25000 * (1.02^favor - 1)
// For favor=150: rep = 25000 * (1.02^150 - 1) ≈ 460,439
export const FAVOR_DONATION_THRESHOLD = 150;
export const REP_FOR_DONATION_FAVOR = 460000;    // Rep needed to reach 150 favor after reset

// If an aug requires more than this, we cap grinding at REP_FOR_DONATION_FAVOR
// and plan to buy the rest with donations next run
export const HIGH_REP_AUG_THRESHOLD = 1000000;   // 1M rep

// Company threshold status enum
export const CompanyThresholdStatus = Object.freeze({
  COMPANIES_BELOW_THRESHOLD: 'COMPANIES_BELOW_THRESHOLD',       // Some companies won't reach 35 favor after reset
  COMPANIES_AT_MIN_THRESHOLD: 'COMPANIES_AT_MIN_THRESHOLD',     // All will have 35+ favor, some factions not unlocked
  COMPANY_FACTIONS_ALL_UNLOCKED: 'COMPANY_FACTIONS_ALL_UNLOCKED', // All company factions joined
});

// Silhouette faction requirements
const SILHOUETTE_REP_REQUIREMENT = 3_200_000; // 3.2M rep for CTO/CFO/CEO position

// Target favor after reset for "good enough" threshold
const TARGET_FAVOR_AFTER_RESET = 35;

/**
 * Calculate favor gained from reputation
 * Formula: favor = log_1.02(1 + rep/25000)
 */
function calculateFavorFromRep(rep) {
  return Math.log(1 + rep / 25000) / Math.log(1.02);
}

/**
 * Calculate total favor after reset given current rep and existing favor
 * @param {number} currentRep - Current reputation this run
 * @param {number} existingFavor - Favor already earned from previous runs
 * @returns {number} Total favor after next reset
 */
function calculateFavorAfterReset(currentRep, existingFavor) {
  const favorFromCurrentRep = calculateFavorFromRep(currentRep);
  return existingFavor + favorFromCurrentRep;
}

/**
 * Calculate rep needed to reach target favor after reset
 * @param {number} existingFavor - Favor already earned from previous runs
 * @param {number} targetFavor - Target total favor after reset
 * @returns {number} Rep needed this run (0 if already met)
 */
function calculateRepNeededForFavor(existingFavor, targetFavor) {
  const favorNeeded = targetFavor - existingFavor;
  if (favorNeeded <= 0) return 0;
  
  // Inverse of favor formula: rep = 25000 * (1.02^favor - 1)
  const repNeeded = 25000 * (Math.pow(1.02, favorNeeded) - 1);
  return repNeeded;
}

/**
 * Get the current company threshold status
 * @param {NS} ns
 * @returns {{status: string, details: Object}}
 */
export function getCompanyThresholdStatus(ns) {
  const joinedFactions = getJoinedFactionsInternal(ns);
  
  let belowMinThreshold = [];
  let belowFactionUnlock = [];
  let factionsNotJoined = [];
  let allJoined = true;
  
  for (const company of MEGACORP_COMPANIES) {
    const companyRep = ns.singularity.getCompanyRep(company);
    const companyFavor = ns.singularity.getCompanyFavor(company);
    const associatedFaction = COMPANY_FACTION_MAP[company];
    const factionJoined = joinedFactions.includes(associatedFaction);
    
    // Calculate what favor will be after reset
    const favorAfterReset = calculateFavorAfterReset(companyRep, companyFavor);
    const repNeededFor35Favor = calculateRepNeededForFavor(companyFavor, TARGET_FAVOR_AFTER_RESET);
    
    if (!factionJoined) {
      allJoined = false;
      factionsNotJoined.push({ 
        company, 
        faction: associatedFaction, 
        rep: companyRep,
        favor: companyFavor,
        favorAfterReset,
      });
      
      // Check if we'll have 35+ favor after reset
      if (favorAfterReset < TARGET_FAVOR_AFTER_RESET) {
        belowMinThreshold.push({ 
          company, 
          rep: companyRep, 
          favor: companyFavor,
          favorAfterReset,
          repNeeded: repNeededFor35Favor - companyRep,
        });
      } else if (companyRep < COMPANY_FACTION_UNLOCK_REP) {
        belowFactionUnlock.push({ 
          company, 
          rep: companyRep, 
          favor: companyFavor,
          favorAfterReset,
          needed: COMPANY_FACTION_UNLOCK_REP,
        });
      }
      // If rep >= 400k but faction not joined, might be missing backdoor (Fulcrum)
    }
  }
  
  if (allJoined) {
    return {
      status: CompanyThresholdStatus.COMPANY_FACTIONS_ALL_UNLOCKED,
      details: {
        allFactionsJoined: true,
        silhouetteEligible: checkSilhouetteEligibility(ns),
      },
    };
  }
  
  if (belowMinThreshold.length > 0) {
    return {
      status: CompanyThresholdStatus.COMPANIES_BELOW_THRESHOLD,
      details: {
        belowMinThreshold,
        belowFactionUnlock,
        factionsNotJoined,
      },
    };
  }
  
  return {
    status: CompanyThresholdStatus.COMPANIES_AT_MIN_THRESHOLD,
    details: {
      belowMinThreshold: [],
      belowFactionUnlock,
      factionsNotJoined,
    },
  };
}

/**
 * Check if player is eligible for Silhouette faction
 * Requires: CTO, CFO, or CEO position at any company (needs ~3.2M rep)
 * @param {NS} ns
 * @returns {{eligible: boolean, currentBest: Object|null, repNeeded: number, timeUnits: number}}
 */
function checkSilhouetteEligibility(ns) {
  const player = ns.getPlayer();
  const targetPositions = ["Chief Technology Officer", "Chief Financial Officer", "Chief Executive Officer"];
  
  // Check if already in a qualifying position
  for (const [company, position] of Object.entries(player.jobs)) {
    if (targetPositions.includes(position)) {
      return { 
        eligible: true, 
        currentBest: { company, position }, 
        repNeeded: 0,
        timeUnits: 0,
      };
    }
  }
  
  // Find the company where we're closest to the requirement (factoring in favor)
  let bestCompany = null;
  let bestRep = 0;
  let bestFavor = 0;
  let bestTimeUnits = Infinity;
  
  for (const company of MEGACORP_COMPANIES) {
    const rep = ns.singularity.getCompanyRep(company);
    const favor = ns.singularity.getCompanyFavor(company);
    const timeUnits = calculateTimeUnits(rep, SILHOUETTE_REP_REQUIREMENT, favor);
    
    if (timeUnits < bestTimeUnits) {
      bestTimeUnits = timeUnits;
      bestCompany = company;
      bestRep = rep;
      bestFavor = favor;
    }
  }
  
  const repNeeded = Math.max(0, SILHOUETTE_REP_REQUIREMENT - bestRep);
  
  return {
    eligible: false,
    currentBest: bestCompany ? { 
      company: bestCompany, 
      rep: bestRep,
      favor: bestFavor,
    } : null,
    repNeeded,
    timeUnits: bestTimeUnits,
    targetRep: SILHOUETTE_REP_REQUIREMENT,
  };
}

/**
 * Get Silhouette grind job if all company factions are unlocked
 * This is a low-priority job to work towards Silhouette faction
 * @param {NS} ns
 * @param {Object} stats
 * @returns {Object|null} Job object or null if not applicable
 */
export function getSilhouetteGrindJob(ns, stats) {
  const thresholdStatus = getCompanyThresholdStatus(ns);
  
  if (thresholdStatus.status !== CompanyThresholdStatus.COMPANY_FACTIONS_ALL_UNLOCKED) {
    return null;
  }
  
  const silhouette = thresholdStatus.details.silhouetteEligible;
  
  if (silhouette.eligible) {
    return null; // Already eligible, no need to grind
  }
  
  if (!silhouette.currentBest) {
    return null; // No company rep at all (shouldn't happen if all factions unlocked)
  }
  
  const company = silhouette.currentBest.company;
  const companyFavor = ns.singularity.getCompanyFavor(company);
  const companyRep = ns.singularity.getCompanyRep(company);
  
  const timeUnits = calculateTimeUnits(companyRep, SILHOUETTE_REP_REQUIREMENT, companyFavor);
  const activity = getBestCompanyPosition(ns, stats, company);
  
  return {
    type: "company",
    name: company,
    activity: activity,
    timeUnits: timeUnits,
    targetRep: SILHOUETTE_REP_REQUIREMENT,
    currentRep: companyRep,
    favor: companyFavor,
    goalDescription: "silhouette_unlock",
    associatedFaction: "Silhouette",
    isDaedalusRedPill: false,
    isSilhouetteGrind: true,
  };
}

// Internal helper to avoid circular dependency issues
function getJoinedFactionsInternal(ns) {
  const allFactions = Object.values(ns.enums.FactionName);
  return allFactions.filter(f => ns.singularity.getFactionRep(f) > 0);
}

// Configuration: Set to true to deprioritize factions where we can donate
// When true: factions with 150+ favor are pushed to end of list (money script handles them)
// When false: factions are sorted purely by time units (grind everything)
// 
// Set to false in bitnodes where money is scarce or rep multipliers are harsh
let DEPRIORITIZE_DONATABLE_FACTIONS = true;

// Work type stat weights for calculating effective rep gain
// Higher weighted average = faster rep gain
const FACTION_WORK_WEIGHTS = {
  "Security Work": {
    hacking: 1.2,
    strength: 1,
    defense: 1,
    dexterity: 1.15,
    agility: 1,
    charisma: 0, // excluded from average
  },
  "Field Work": {
    hacking: 3.6,
    strength: 1,
    defense: 1,
    dexterity: 1.15,
    agility: 1,
    charisma: 2.1,
  },
  "Hacking Contracts": {
    hacking: 1,
    strength: 0,
    defense: 0,
    dexterity: 0,
    agility: 0,
    charisma: 0,
  },
};

const COMPANY_WORK_WEIGHTS = {
  "Security": {
    hacking: 0.6,
    strength: 1,
    defense: 1,
    dexterity: 1.15,
    agility: 1,
    charisma: 1.8,
  },
  "IT": {
    hacking: 5,
    strength: 0,
    defense: 0,
    dexterity: 0,
    agility: 0,
    charisma: 1,
  },
  "Software": {
    hacking: 8.3,
    strength: 0,
    defense: 0,
    dexterity: 0,
    agility: 0,
    charisma: 1,
  },
};

/**
 * Calculate "time units" - effective work required accounting for favor bonus
 * @param {number} currentRep - Current reputation
 * @param {number} targetRep - Target reputation
 * @param {number} favor - Current favor (already earned from previous runs)
 * @returns {number} Time units (lower = faster to reach goal)
 */
function calculateTimeUnits(currentRep, targetRep, favor) {
  if (currentRep >= targetRep) return 0;
  const remainingRep = targetRep - currentRep;
  const favorMultiplier = 1 + favor / 100;
  return remainingRep / favorMultiplier;
}

/**
 * Calculate weighted average for a work type given stats
 * @param {Object} stats - {hacking, strength, defense, dexterity, agility, charisma}
 * @param {Object} weights - Weight multipliers for each stat
 * @returns {number} Weighted average (higher = better rep gain)
 */
function calculateWeightedAverage(stats, weights) {
  let weightedSum = 0;
  let totalWeight = 0;
  
  const statKeys = ['hacking', 'strength', 'defense', 'dexterity', 'agility', 'charisma'];
  
  for (const stat of statKeys) {
    const weight = weights[stat] || 0;
    if (weight > 0) {
      weightedSum += stats[stat] * weight;
      totalWeight += weight;
    }
  }
  
  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

/**
 * Determine the best work activity based on stats using weighted averages
 * @param {NS} ns
 * @param {Object} stats - {hacking, strength, defense, dexterity, agility, charisma}
 * @param {string[]} availableWorkTypes - Available work types for the faction
 * @returns {string} Best work type for maximum rep gain
 */
function getBestWorkActivity(ns, stats, availableWorkTypes) {
  if (!availableWorkTypes || availableWorkTypes.length === 0) {
    return "Hacking Contracts"; // fallback
  }
  
  let bestWorkType = availableWorkTypes[0];
  let bestScore = -Infinity;
  
  for (const workType of availableWorkTypes) {
    const weights = FACTION_WORK_WEIGHTS[workType];
    if (!weights) continue;
    
    const score = calculateWeightedAverage(stats, weights);
    if (score > bestScore) {
      bestScore = score;
      bestWorkType = workType;
    }
  }
  
  return bestWorkType;
}

/**
 * Get best company work field based on stats using weighted averages
 * @param {NS} ns
 * @param {Object} stats - {hacking, strength, defense, dexterity, agility, charisma}
 * @param {string} companyName - Company name (unused but kept for API consistency)
 * @returns {string} Best work field ("Software", "IT", or "Security")
 */
function getBestCompanyPosition(ns, stats, companyName) {
  const workFields = ["Software", "IT", "Security"];
  
  let bestField = "Software"; // default
  let bestScore = -Infinity;
  
  for (const field of workFields) {
    const weights = COMPANY_WORK_WEIGHTS[field];
    if (!weights) continue;
    
    const score = calculateWeightedAverage(stats, weights);
    if (score > bestScore) {
      bestScore = score;
      bestField = field;
    }
  }
  
  return bestField;
}

/**
 * Main function: Get prioritized jobs (faction or company work)
 * @param {NS} ns
 * @param {Object} stats - Character stats {hacking, strength, defense, dexterity, agility, charisma}
 * @param {boolean} forSleeves - Whether this is for sleeves (affects aug checking)
 * @param {Set<string>} excludedJobs - Jobs already taken by other workers (faction/company names)
 * @param {Object} config - Configuration options
 * @param {boolean} config.deprioritizeDonatable - If true, factions with 150+ favor are deprioritized
 * @returns {Object[]} Array of up to 8 job objects, sorted by priority
 */
export function getPriorityJobs(ns, stats, forSleeves = false, excludedJobs = new Set(), config = {}) {
  const { deprioritizeDonatable = DEPRIORITIZE_DONATABLE_FACTIONS } = config;
  
  const jobs = [];
  
  // Get owned augs
  let ownedAugs;
  if (forSleeves) {
    ownedAugs = ns.sleeve.getSleeveAugmentations(0);
  } else {
    ownedAugs = ns.singularity.getOwnedAugmentations(true);
  }
  
  // Get all factions we've joined
  const allFactions = Object.values(ns.enums.FactionName);
  const joinedFactions = allFactions.filter(f => ns.singularity.getFactionRep(f) > 0);
  
  // ========== FACTION JOBS ==========
  // For each joined faction, find the next KEY AUG target and calculate time units
  // Factions without any key augs we need are skipped entirely
  
  for (const faction of joinedFactions) {
    if (excludedJobs.has(faction)) continue;
    
    const factionRep = ns.singularity.getFactionRep(faction);
    const factionFavor = ns.singularity.getFactionFavor(faction);
    
    // Get augs from this faction that we don't own
    const factionAugs = ns.singularity.getAugmentationsFromFaction(faction);
    const purchasableAugs = factionAugs.filter(aug => !ownedAugs.includes(aug));
    
    if (purchasableAugs.length === 0) continue;
    
    // ONLY consider key augs - skip factions that don't have any key augs we need
    const keyAugsFromFaction = purchasableAugs.filter(aug => KEY_AUGS.includes(aug));
    
    if (keyAugsFromFaction.length === 0) {
      // This faction has no key augs we need - skip it entirely
      // (e.g., Netburners - hacknet augs are not useful for bitnode progression)
      continue;
    }
    
    // Find the next key aug (lowest rep requirement we don't yet meet)
    let nextAug = null;
    let lowestRepNeeded = Infinity;
    
    for (const aug of keyAugsFromFaction) {
      const repReq = ns.singularity.getAugmentationRepReq(aug);
      if (repReq > factionRep && repReq < lowestRepNeeded) {
        lowestRepNeeded = repReq;
        nextAug = aug;
      }
    }
    
    if (!nextAug) continue; // Already have enough rep for all key augs from this faction
    
    // Calculate what favor we'll have after reset
    const favorAfterReset = calculateFavorAfterReset(factionRep, factionFavor);
    
    // Calculate rep needed to reach 150 favor (donation threshold)
    const repNeededFor150Favor = calculateRepNeededForFavor(factionFavor, FAVOR_DONATION_THRESHOLD);
    
    // Apply donation threshold logic:
    // If target requires 1M+ rep and we won't have 150 favor after reset,
    // cap the grind target at the rep needed to reach 150 favor
    let effectiveTarget = lowestRepNeeded;
    let cappedForDonation = false;
    
    if (lowestRepNeeded >= HIGH_REP_AUG_THRESHOLD && favorAfterReset < FAVOR_DONATION_THRESHOLD) {
      // Cap at the rep needed for donation threshold (dynamic based on existing favor)
      // But only if we haven't already exceeded it
      if (factionRep < repNeededFor150Favor) {
        effectiveTarget = repNeededFor150Favor;
        cappedForDonation = true;
      }
    }
    
    // If we already have 150+ favor, we can buy rep - deprioritize grinding
    // (money script will handle donations)
    const canDonate = factionFavor >= FAVOR_DONATION_THRESHOLD;
    
    const timeUnits = calculateTimeUnits(factionRep, effectiveTarget, factionFavor);
    
    // Check for Daedalus + Red Pill special case
    const isDaedalusRedPill = faction === "Daedalus" && nextAug === "The Red Pill";
    
    // Get best work type
    let workTypes;
    try {
      workTypes = ns.singularity.getFactionWorkTypes(faction);
    } catch {
      workTypes = ["Hacking Contracts"]; // fallback
    }
    const activity = getBestWorkActivity(ns, stats, workTypes);
    
    jobs.push({
      type: "faction",
      name: faction,
      activity: activity,
      timeUnits: isDaedalusRedPill ? -Infinity : timeUnits, // Red Pill always first
      targetRep: effectiveTarget,
      actualAugRep: lowestRepNeeded, // The real rep needed for the aug
      currentRep: factionRep,
      favor: factionFavor,
      favorAfterReset: favorAfterReset,
      targetAug: nextAug,
      isDaedalusRedPill: isDaedalusRedPill,
      cappedForDonation: cappedForDonation,
      canDonate: canDonate,
    });
  }
  
  // ========== COMPANY JOBS ==========
  // For each megacorp, check if we need company rep (to unlock faction or build favor)
  
  for (const company of MEGACORP_COMPANIES) {
    if (excludedJobs.has(company)) continue;
    
    const companyRep = ns.singularity.getCompanyRep(company);
    const companyFavor = ns.singularity.getCompanyFavor(company);
    const associatedFaction = COMPANY_FACTION_MAP[company];
    
    // Check if faction is already unlocked
    const factionJoined = joinedFactions.includes(associatedFaction);
    
    // Calculate favor after reset to determine if we need more rep for the 35 favor threshold
    const favorAfterReset = calculateFavorAfterReset(companyRep, companyFavor);
    const repNeededFor35Favor = calculateRepNeededForFavor(companyFavor, TARGET_FAVOR_AFTER_RESET);
    
    // Determine company rep goal
    let targetRep;
    let goalDescription;
    
    if (!factionJoined && companyRep < COMPANY_FACTION_UNLOCK_REP) {
      // Need to unlock faction - but first check favor threshold
      if (favorAfterReset < TARGET_FAVOR_AFTER_RESET) {
        // First milestone: get enough rep to reach 35 favor after reset
        // This is dynamic based on existing favor!
        targetRep = repNeededFor35Favor;
        goalDescription = "favor_threshold";
      } else if (companyRep < COMPANY_FACTION_UNLOCK_REP) {
        // Second milestone: get to 400k to unlock faction
        targetRep = COMPANY_FACTION_UNLOCK_REP;
        goalDescription = "unlock_faction";
      }
    } else if (!factionJoined) {
      // Rep is >= 400k but faction not joined yet (maybe missing backdoor for Fulcrum?)
      continue; // Skip, can't help with that
    } else {
      // Faction already joined - no need for more company work
      continue;
    }
    
    // Skip if we've already reached the target
    if (companyRep >= targetRep) continue;
    
    const timeUnits = calculateTimeUnits(companyRep, targetRep, companyFavor);
    const activity = getBestCompanyPosition(ns, stats, company);
    
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
    });
  }
  
  // ========== SORT BY TIME UNITS ==========
  // Lower time units = higher priority (closer to goal)
  // If deprioritizeDonatable is true, factions with favor ≥150 are pushed to end
  // (including Daedalus - buying 2.5M rep is faster than grinding)
  
  jobs.sort((a, b) => {
    // If deprioritizing donatable factions, handle that first
    if (deprioritizeDonatable) {
      if (a.canDonate && !b.canDonate) return 1;
      if (b.canDonate && !a.canDonate) return -1;
    }
    
    // Red Pill is highest priority among non-donatable (or all, if not deprioritizing)
    if (a.isDaedalusRedPill && !a.canDonate) return -1;
    if (b.isDaedalusRedPill && !b.canDonate) return 1;
    
    // If both can donate (or neither), Red Pill still wins within that group
    if (a.isDaedalusRedPill) return -1;
    if (b.isDaedalusRedPill) return 1;
    
    // Silhouette grind is always lowest priority (only when nothing else to do)
    if (a.isSilhouetteGrind && !b.isSilhouetteGrind) return 1;
    if (b.isSilhouetteGrind && !a.isSilhouetteGrind) return -1;
    
    // Otherwise sort by time units (lower = higher priority)
    return a.timeUnits - b.timeUnits;
  });
  
  // Add Silhouette grind job as last priority if all company factions are unlocked
  const silhouetteJob = getSilhouetteGrindJob(ns, stats);
  if (silhouetteJob && !excludedJobs.has(silhouetteJob.name)) {
    jobs.push(silhouetteJob);
  }
  
  // Return top 8
  return jobs.slice(0, 8);
}

/**
 * Get a single priority job (convenience wrapper)
 */
export function getPriorityJob(ns, stats, forSleeves = false, excludedJobs = new Set(), config = {}) {
  const jobs = getPriorityJobs(ns, stats, forSleeves, excludedJobs, config);
  return jobs.length > 0 ? jobs[0] : null;
}

/**
 * Get player stats object
 */
export function getPlayerStats(ns) {
  const player = ns.getPlayer();
  return {
    hacking: player.skills.hacking,
    strength: player.skills.strength,
    defense: player.skills.defense,
    dexterity: player.skills.dexterity,
    agility: player.skills.agility,
    charisma: player.skills.charisma,
  };
}

/**
 * Get sleeve stats object
 */
export function getSleeveStats(ns, sleeveNumber) {
  const sleeve = ns.sleeve.getSleeve(sleeveNumber);
  return {
    hacking: sleeve.skills.hacking,
    strength: sleeve.skills.strength,
    defense: sleeve.skills.defense,
    dexterity: sleeve.skills.dexterity,
    agility: sleeve.skills.agility,
    charisma: sleeve.skills.charisma,
  };
}

/** @param {NS} ns */
export async function main(ns) {
  ns.ui.openTail();
  ns.clearLog();
  
  const forSleeves = ns.args[0] === true || ns.args[0] === "sleeves";
  const deprioritizeDonatable = ns.args[1] !== false; // Default true, pass false to disable
  
  const config = { deprioritizeDonatable };
  
  // Get stats
  const stats = forSleeves ? getSleeveStats(ns, 0) : getPlayerStats(ns);
  
  ns.print(`\n=== Priority Jobs (${forSleeves ? "Sleeves" : "Player"}) ===`);
  ns.print(`Stats: H:${stats.hacking} S:${stats.strength} D:${stats.defense} X:${stats.dexterity} A:${stats.agility} C:${stats.charisma}`);
  ns.print(`Config: deprioritizeDonatable=${deprioritizeDonatable}`);
  ns.print("");
  
  const jobs = getPriorityJobs(ns, stats, forSleeves, new Set(), config);
  
  if (jobs.length === 0) {
    ns.print("No priority jobs found!");
    return [];
  }
  
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const repProgress = `${ns.formatNumber(job.currentRep, 1)} / ${ns.formatNumber(job.targetRep, 1)}`;
    const timeStr = job.timeUnits === -Infinity ? "HIGHEST PRIORITY" : ns.formatNumber(job.timeUnits, 1);
    
    ns.print(`#${i + 1}: [${job.type.toUpperCase()}] ${job.name}`);
    ns.print(`    Activity: ${job.activity}`);
    ns.print(`    Rep: ${repProgress} (favor: ${job.favor.toFixed(1)})`);
    ns.print(`    Time Units: ${timeStr}`);
    
    if (job.type === "faction") {
      ns.print(`    Target Aug: ${job.targetAug}`);
      if (job.cappedForDonation) {
        ns.print(`    ⚠ Capped at ${ns.formatNumber(job.targetRep, 0)} for donation favor (aug needs ${ns.formatNumber(job.actualAugRep, 0)})`);
      }
      if (job.canDonate) {
        ns.print(`    💰 Can donate for rep (favor ≥150)`);
      }
      if (job.isDaedalusRedPill) {
        ns.print(`    *** THE RED PILL - ABSOLUTE PRIORITY ***`);
      }
    } else {
      ns.print(`    Goal: ${job.goalDescription} (unlocks ${job.associatedFaction})`);
    }
    ns.print("");
  }
  
  return jobs;
}