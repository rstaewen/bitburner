/**
 * orchestrateSleeves.js - Sleeve management script
 * 
 * Manages sleeve job assignments with priorities:
 * 1. Purchase augmentations (if available and affordable)
 * 2. Train stats (if below threshold)
 * 3. Grind faction rep (for aug targets)
 * 4. Grind company rep (spread favor, then unlock factions)
 * 5. Commit crimes (fallback)
 */

import {
  getFactionPriority,
  getBestWorkAssignment,
  shouldReassign,
  executeSleeveAssignment,
  classifyTask,
  REP_CONFIG,
} from "utils/repTargets.js";

// === CONFIGURATION ===

const CONFIG = {
  CHECK_INTERVAL: 1000,
  STAT_FLOOR: 20000, // Average exp threshold for training
};

// === JOB TYPES ===

const Jobs = Object.freeze({
  IDLE: 'idle',
  TRAIN: 'training',
  AUG: 'purchase augments',
  REP: 'grind rep',
});

// === MAIN ===

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("exec");
  ns.disableLog("kill");
  ns.ui.openTail();
  
  ns.print("Starting sleeve controller...");

  while (true) {
    try {
      const numSleeves = ns.sleeve.getNumSleeves();
      const factionPriority = getFactionPriority(ns, true); // true = for sleeves
      const usedFactions = new Set();
      
      // First pass: record factions/companies already in use by sleeves doing REP
      for (let i = 0; i < numSleeves; i++) {
        const task = ns.sleeve.getTask(i);
        const desiredJob = getDesiredJob(ns, i);
        const currentActivity = classifyTask(task);
        
        if ((currentActivity === "FACTION" || currentActivity === "COMPANY") && desiredJob === Jobs.REP) {
          if (task?.factionName) {
            usedFactions.add(task.factionName);
          }
          if (task?.companyName) {
            usedFactions.add(task.companyName);
          }
        }
      }
      
      // Second pass: assign jobs
      for (let i = 0; i < numSleeves; i++) {
        const task = ns.sleeve.getTask(i);
        const desiredJob = getDesiredJob(ns, i);
        
        // Check if we need to do anything
        let needsAction = false;
        
        if (desiredJob === Jobs.AUG) {
          needsAction = !ns.isRunning("utils/augmentSleeve.js", "nexus", i);
        } else if (desiredJob === Jobs.TRAIN) {
          needsAction = !ns.isRunning("utils/trainSleeve.js", "nexus", i);
        } else if (desiredJob === Jobs.REP) {
          needsAction = shouldReassign(ns, task, usedFactions, factionPriority, true);
        }
        
        if (!needsAction) {
          continue;
        }
        
        // Kill any existing scripts for this sleeve before reassigning
        killSleeveScripts(ns, i);
        
        // Assign the job
        if (desiredJob === Jobs.AUG) {
          const pid = ns.exec("utils/augmentSleeve.js", "nexus", 1, i);
          ns.print(`Sleeve ${i}: Started augment purchasing, pid=${pid}`);
        } 
        else if (desiredJob === Jobs.TRAIN) {
          const pid = ns.exec("utils/trainSleeve.js", "nexus", 1, i);
          ns.print(`Sleeve ${i}: Started training, pid=${pid}`);
        } 
        else if (desiredJob === Jobs.REP) {
          const assignment = getBestWorkAssignment(ns, {
            usedFactions,
            factionPriority,
            forSleeves: true,
            currentTask: task,
          });
          
          if (assignment) {
            const failure = executeSleeveAssignment(ns, i, assignment);
            let assignmentString = "RESULT: "
            if (failure === true && assignment.type === "company") {
              assignmentString += "failed, probably haven't joined company"; 
            } else if (failure === true && assignment.type === "faction") {
              assignmentString += "failed, probably haven't joined faction"; 
            } else if (failure === true) {
              assignmentString += "failed, reason unknown";
            } else {
              assignmentString += "succeded!";
            }
            ns.print(`Sleeve ${i}: ${assignment.type} - ${assignment.target || assignment.crimeType}: ${assignmentString}`);
          }
        }
      }
    } catch (e) {
      ns.print(`ERROR: ${e}`);
    }
    
    await ns.sleep(CONFIG.CHECK_INTERVAL);
  }
}

// === HELPERS ===

/** @param {NS} ns */
function killSleeveScripts(ns, sleeveNumber) {
  const scripts = ["utils/trainSleeve.js", "utils/augmentSleeve.js"];
  for (const script of scripts) {
    if (ns.isRunning(script, "nexus", sleeveNumber)) {
      ns.kill(script, "nexus", sleeveNumber);
      ns.print(`Sleeve ${sleeveNumber}: Killed ${script}`);
    }
  }
}

/** @param {NS} ns */
function getDesiredJob(ns, sleeveNumber) {
  const sleeve = ns.sleeve.getSleeve(sleeveNumber);
  const purchasableAugs = ns.sleeve.getSleevePurchasableAugs(sleeveNumber);
  const avgExp = (sleeve.exp.agility + sleeve.exp.charisma + sleeve.exp.defense + sleeve.exp.dexterity + sleeve.exp.strength) / 5;
  
  if (purchasableAugs.length > 0 && sleeve.shock === 0) {
    return Jobs.AUG;
  } else if (avgExp < CONFIG.STAT_FLOOR) {
    return Jobs.TRAIN;
  } else {
    return Jobs.REP;
  }
}
