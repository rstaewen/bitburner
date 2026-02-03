/**
 * repTargets.js - Shared utility for reputation grinding priorities
 * 
 * Used by both orchestrateSleeves.js and progression.js to determine
 * optimal faction/company work assignments.
 */

import { getTargets } from "utils/findAugRepTarget.js";

// === CONFIGURATION ===

export const REP_CONFIG = {
  COMPANY_REP_FAVOR_THRESHOLD: 25000,   // Spread favor efficiently below this
  COMPANY_REP_FACTION_UNLOCK: 400000,   // Rep needed to unlock megacorp faction
};

// === TYPES ===

/**
 * @typedef {Object} WorkAssignment
 * @property {'faction' | 'company' | 'crime'} type
 * @property {string} [target] - Faction or company name
 * @property {string} [workType] - For factions: hacking, field, security
 * @property {string} [crimeType] - For crime: Homicide, etc.
 */

// === MAIN FUNCTIONS ===

/**
 * Get prioritized list of factions to grind rep for (based on aug targets)
 * @param {NS} ns
 * @param {boolean} forSleeves - true for sleeve augs, false for player augs
 * @returns {string[]} - Faction names in priority order
 */
export function getFactionPriority(ns, forSleeves) {
  const repTargets = getTargets(ns, forSleeves);
  const factionPriority = [];
  
  for (const target of repTargets) {
    if (target && target.minRepReqFaction && !factionPriority.includes(target.minRepReqFaction)) {
      factionPriority.push(target.minRepReqFaction);
    }
  }
  
  return factionPriority;
}

/**
 * Get list of megacorps that have associated factions we haven't unlocked yet
 * @param {NS} ns
 * @returns {string[]} - Company names
 */
export function getNeededMegacorps(ns) {
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
  
  // Only corps where we haven't unlocked the faction yet
  const neededMegacorps = megacorps.filter(mcorp => ns.singularity.getFactionRep(mcorp.faction) === 0);
  
  // Return only the corp string
  return neededMegacorps.map(mcorp => mcorp.corp);
}

/**
 * Get the best work assignment for an entity (sleeve or player)
 * @param {NS} ns
 * @param {Object} options
 * @param {Set<string>} options.usedFactions - Factions/companies already assigned to other entities
 * @param {string[]} options.factionPriority - Priority-ordered faction list
 * @param {boolean} options.forSleeves - Whether this is for sleeves (affects company check)
 * @param {Object} [options.currentTask] - Current task (to avoid reassigning same thing)
 * @returns {WorkAssignment | null} - Best work assignment, or null if no change needed
 */
export function getBestWorkAssignment(ns, options) {
  const { usedFactions, factionPriority, forSleeves, currentTask } = options;
  
  // Priority 1: Faction rep for aug targets
  const factionAssignment = tryAssignFaction(ns, usedFactions, factionPriority, currentTask);
  if (factionAssignment) return factionAssignment;
  
  // Priority 2: Company jobs under 25k rep (spread favor)
  const underThresholdAssignment = tryAssignCompanyUnderThreshold(ns, usedFactions, forSleeves, currentTask);
  if (underThresholdAssignment) return underThresholdAssignment;
  
  // Priority 3: Company jobs under 400k rep (highest rep first to unlock faster)
  const companyAssignment = tryAssignCompanyToUnlock(ns, usedFactions, forSleeves, currentTask);
  if (companyAssignment) return companyAssignment;
  
  // Priority 4: Crime as fallback
  return tryAssignCrime(ns, currentTask);
}

/**
 * Check if current task should be interrupted for a better assignment
 * @param {NS} ns
 * @param {Object} currentTask - Current sleeve/player task
 * @param {Set<string>} usedFactions - Already-used factions/companies
 * @param {string[]} factionPriority - Priority faction list
 * @param {boolean} forSleeves - Whether this is for sleeves
 * @returns {boolean} - True if we should reassign
 */
export function shouldReassign(ns, currentTask, usedFactions, factionPriority, forSleeves) {
  if (!currentTask) return true;
  
  const taskType = currentTask.type;
  
  // Already doing faction work - stay put
  if (taskType === 'FACTION') {
    return false;
  }

  // Explicit company → faction mapping for exceptions
  const COMPANY_TO_FACTION_OVERRIDES = {
    "Fulcrum Technologies": "Fulcrum Secret Technologies",
  };
  
  // Doing company work - check if we should switch
  if (taskType === 'COMPANY') {
    const companyName = currentTask.companyName;
    const factionName = COMPANY_TO_FACTION_OVERRIDES[companyName] ?? companyName;
    const companyRep = ns.singularity.getCompanyRep(companyName);
    const factionUnlocked = ns.singularity.getFactionRep(factionName) > 0;
    const pastThreshold = companyRep >= REP_CONFIG.COMPANY_REP_FAVOR_THRESHOLD;
    const companyMaxedOut = companyRep >= REP_CONFIG.COMPANY_REP_FACTION_UNLOCK;
    
    // Faction unlocked or company maxed - definitely reassign
    if (factionUnlocked || companyMaxedOut) {
      return true;
    }
    
    // Check if priority faction is available
    const priorityFactionAvailable = factionPriority.some(f => !usedFactions.has(f));
    if (priorityFactionAvailable) {
      return true;
    }
    
    // Past threshold - check if under-threshold company available
    if (pastThreshold) {
      const neededMegacorps = getNeededMegacorps(ns);
      const underThresholdAvailable = neededMegacorps.some(corp => {
        if (usedFactions.has(corp)) return false;
        const rep = ns.singularity.getCompanyRep(corp);
        return rep < REP_CONFIG.COMPANY_REP_FAVOR_THRESHOLD;
      });
      
      if (underThresholdAvailable) {
        return true;
      }
    }
    
    return false;
  }
  
  // Doing crime or anything else - check if there's real work available
  return true;
}

// === HELPER FUNCTIONS ===

/**
 * Try to assign faction work
 * @returns {WorkAssignment | null}
 */
function tryAssignFaction(ns, usedFactions, factionPriority, currentTask) {
  for (const faction of factionPriority) {
    if (usedFactions.has(faction)) continue;
    
    const workTypes = ns.singularity.getFactionWorkTypes(faction);
    if (workTypes.length > 0) {
      // Check if already doing this
      if (currentTask?.type === 'FACTION' && currentTask?.factionName === faction) {
        usedFactions.add(faction);
        return null; // No change needed
      }
      
      usedFactions.add(faction);
      return {
        type: 'faction',
        target: faction,
        workType: workTypes[0], // Usually 'hacking' is first and best
      };
    }
  }
  
  return null;
}

/**
 * Try to assign company work for companies under the favor threshold
 * @returns {WorkAssignment | null}
 */
function tryAssignCompanyUnderThreshold(ns, usedFactions, forSleeves, currentTask) {
  const neededMegacorps = getNeededMegacorps(ns);
  
  for (const company of neededMegacorps) {
    if (usedFactions.has(company)) continue;
    
    const rep = ns.singularity.getCompanyRep(company);
    if (rep < REP_CONFIG.COMPANY_REP_FAVOR_THRESHOLD) {
      // Check if already doing this
      if (currentTask?.type === 'COMPANY' && currentTask?.companyName === company) {
        usedFactions.add(company);
        return null; // No change needed
      }
      
      // For player: need to have a job there
      // For sleeves: can work if player has job
      if (!forSleeves) {
        const jobs = ns.singularity.getPlayer().jobs || {};
        if (!jobs[company]) continue; // Player doesn't have a job here
      }
      
      usedFactions.add(company);
      return {
        type: 'company',
        target: company,
      };
    }
  }
  
  return null;
}

/**
 * Try to assign company work to unlock factions (highest rep first)
 * @returns {WorkAssignment | null}
 */
function tryAssignCompanyToUnlock(ns, usedFactions, forSleeves, currentTask) {
  const neededMegacorps = getNeededMegacorps(ns);
  
  // Sort by effective time to unlock (factoring in favor)
  const sortedByEffectiveRep = neededMegacorps
    .filter(corp => !usedFactions.has(corp))
    .map(corp => ({
      company: corp,
      rep: ns.singularity.getCompanyRep(corp),
      favor: ns.singularity.getCompanyFavor(corp),
    }))
    .filter(c => c.rep < REP_CONFIG.COMPANY_REP_FACTION_UNLOCK)
    .sort((a, b) => {
      // Sort by time to unlock: (target - current) / (1 + favor/100)
      const timeA = (REP_CONFIG.COMPANY_REP_FACTION_UNLOCK - a.rep) / (1 + a.favor / 100);
      const timeB = (REP_CONFIG.COMPANY_REP_FACTION_UNLOCK - b.rep) / (1 + b.favor / 100);
      return timeA - timeB; // Fastest to unlock first
    });
  
  if (sortedByEffectiveRep.length > 0) {
    const { company, rep } = sortedByEffectiveRep[0];
    
    // Check if already doing this
    if (currentTask?.type === 'COMPANY' && currentTask?.companyName === company) {
      usedFactions.add(company);
      return null; // No change needed
    }
    
    // For player: need to have a job there
    if (!forSleeves) {
      const jobs = ns.singularity.getPlayer().jobs || {};
      if (!jobs[company]) return null; // Player doesn't have a job here
    }
    
    usedFactions.add(company);
    return {
      type: 'company',
      target: company,
    };
  }
  
  return null;
}

/**
 * Assign crime as fallback
 * @returns {WorkAssignment | null}
 */
function tryAssignCrime(ns, currentTask) {
  // Check if already doing homicide
  if (currentTask?.type === 'CRIME' && currentTask?.crimeType === 'Homicide') {
    return null; // No change needed
  }
  
  return {
    type: 'crime',
    crimeType: 'Homicide',
  };
}

/**
 * Execute a work assignment for a sleeve
 * @param {NS} ns
 * @param {number} sleeveNum
 * @param {WorkAssignment} assignment
 */
export function executeSleeveAssignment(ns, sleeveNum, assignment) {
  switch (assignment.type) {
    case 'faction':
      return ns.sleeve.setToFactionWork(sleeveNum, assignment.target, assignment.workType);
    case 'company':
      return ns.sleeve.setToCompanyWork(sleeveNum, assignment.target);
    case 'crime':
      return ns.sleeve.setToCommitCrime(sleeveNum, assignment.crimeType);
  }
}

/**
 * Execute a work assignment for the player
 * @param {NS} ns
 * @param {WorkAssignment} assignment
 */
export function executePlayerAssignment(ns, assignment) {
  switch (assignment.type) {
    case 'faction':
      // Player should do hacking contracts for maximum rep gain
      const workTypes = ns.singularity.getFactionWorkTypes(assignment.target);
      let workType = 'hacking'
      if (!workTypes.includes('hacking')) {
        workType = workTypes[0];
      }
      ns.tprint("ASSIGNING: ", assignment.target, workType);
      ns.singularity.workForFaction(assignment.target, workType, false);
      break;
    case 'company':
      ns.singularity.workForCompany(assignment.target, false);
      break;
    case 'crime':
      ns.singularity.commitCrime(assignment.crimeType, false);
      break;
  }
}

/**
 * Classify a task into our work categories
 * @param {Object} task - Task object from ns.sleeve.getTask() or ns.singularity.getCurrentWork()
 * @returns {'FACTION' | 'COMPANY' | 'CRIME' | 'IDLE'}
 */
export function classifyTask(task) {
  if (!task) return 'IDLE';
  
  switch (task.type) {
    case 'FACTION':
      return 'FACTION';
    case 'COMPANY':
      return 'COMPANY';
    case 'CRIME':
      return 'CRIME';
    case 'CLASS':
      return 'TRAIN'; // For sleeves
    default:
      return 'IDLE';
  }
}
