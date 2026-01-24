/**
 * orchestrateSleeves.js - Sleeve management script
 * 
 * Manages sleeve job assignments with priorities:
 * 1. Purchase augmentations (if available and affordable)
 * 2. Train stats (if below threshold)
 * 3. Grind faction/company rep (using priorityJobs system)
 * 4. Commit crimes (fallback)
 */

import {
  getPriorityJobs,
  getSleeveStats,
} from "utils/priorityJobs.js";

// === CONFIGURATION ===

const CONFIG = {
  CHECK_INTERVAL: 1000,
  STAT_FLOOR: 20000, // Average exp threshold for training
  DEPRIORITIZE_DONATABLE_FACTIONS: true, // Match progression.js setting
};

// === JOB TYPES ===

const Jobs = Object.freeze({
  IDLE: 'idle',
  TRAIN: 'training',
  AUG: 'purchase augments',
  REP: 'grind rep',
  CRIME: 'commit crimes',
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
      
      // Track which factions/companies are already being worked by sleeves
      // Sleeves can work the same job as each other AND the player
      const usedJobs = new Set();
      
      // First pass: record jobs already in use by sleeves that don't need reassignment
      for (let i = 0; i < numSleeves; i++) {
        const task = ns.sleeve.getTask(i);
        const desiredJob = getDesiredJob(ns, i);
        
        // If sleeve is doing REP work and should continue, mark the job as used
        if (desiredJob === Jobs.REP && task) {
          if (task.type === "FACTION" && task.factionName) {
            // Check if this sleeve should continue this work
            const stats = getSleeveStats(ns, i);
            const jobs = getPriorityJobs(ns, stats, true, usedJobs, { 
              deprioritizeDonatable: CONFIG.DEPRIORITIZE_DONATABLE_FACTIONS 
            });
            
            // If current work matches a priority job, keep doing it
            const currentJobMatch = jobs.find(j => 
              j.type === "faction" && j.name === task.factionName
            );
            if (currentJobMatch) {
              usedJobs.add(task.factionName);
            }
          } else if (task.type === "COMPANY" && task.companyName) {
            const stats = getSleeveStats(ns, i);
            const jobs = getPriorityJobs(ns, stats, true, usedJobs, { 
              deprioritizeDonatable: CONFIG.DEPRIORITIZE_DONATABLE_FACTIONS 
            });
            
            const currentJobMatch = jobs.find(j => 
              j.type === "company" && j.name === task.companyName
            );
            if (currentJobMatch) {
              usedJobs.add(task.companyName);
            }
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
          needsAction = shouldReassignSleeve(ns, i, task, usedJobs);
        } else if (desiredJob === Jobs.CRIME) {
          needsAction = task?.type !== "CRIME";
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
          const assignment = getBestSleeveAssignment(ns, i, usedJobs);
          
          if (assignment) {
            const success = executeSleeveAssignment(ns, i, assignment);
            
            if (success) {
              // Mark this job as used
              usedJobs.add(assignment.name);
              ns.print(`Sleeve ${i}: ${assignment.type} - ${assignment.name} (${assignment.activity})`);
            } else {
              ns.print(`Sleeve ${i}: Failed to assign ${assignment.type} - ${assignment.name}`);
              // Fallback to crime
              ns.sleeve.setToCommitCrime(i, "Homicide");
              ns.print(`Sleeve ${i}: Fallback to Homicide`);
            }
          } else {
            // No valid assignment, commit crimes
            ns.sleeve.setToCommitCrime(i, "Homicide");
            ns.print(`Sleeve ${i}: No priority jobs available, committing Homicide`);
          }
        }
        else if (desiredJob === Jobs.CRIME) {
          ns.sleeve.setToCommitCrime(i, "Homicide");
          ns.print(`Sleeve ${i}: Committing Homicide (fallback)`);
        }
      }
    } catch (e) {
      ns.print(`ERROR: ${e}`);
      ns.print(e.stack);
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

/** 
 * Determine what job type a sleeve should be doing
 * @param {NS} ns 
 */
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

/**
 * Check if a sleeve should be reassigned to a different job
 * @param {NS} ns
 * @param {number} sleeveNumber
 * @param {Object} currentTask - Current sleeve task
 * @param {Set} usedJobs - Jobs already taken by other sleeves
 * @returns {boolean}
 */
function shouldReassignSleeve(ns, sleeveNumber, currentTask, usedJobs) {
  // If not doing faction or company work, needs reassignment
  if (!currentTask) return true;
  if (currentTask.type !== "FACTION" && currentTask.type !== "COMPANY") return true;
  
  const currentJobName = currentTask.factionName || currentTask.companyName;
  if (!currentJobName) return true;
  
  // Get priority jobs for this sleeve
  const stats = getSleeveStats(ns, sleeveNumber);
  const jobs = getPriorityJobs(ns, stats, true, usedJobs, { 
    deprioritizeDonatable: CONFIG.DEPRIORITIZE_DONATABLE_FACTIONS 
  });
  
  if (jobs.length === 0) return true;
  
  // Check if current job is still a valid priority job
  const currentJobInPriority = jobs.find(j => j.name === currentJobName);
  
  if (!currentJobInPriority) {
    // Current job is no longer a priority - reassign
    return true;
  }
  
  // Check if there's a significantly better job available
  // Only reassign if the best job has much lower time units (e.g., 50% less)
  const bestJob = jobs[0];
  if (bestJob.name !== currentJobName) {
    // Check if best job is significantly better (avoid constant thrashing)
    const currentTimeUnits = currentJobInPriority.timeUnits;
    const bestTimeUnits = bestJob.timeUnits;
    
    // Only switch if best job is at least 50% faster
    if (bestTimeUnits < currentTimeUnits * 0.5) {
      return true;
    }
  }
  
  // Check if we're doing the right activity type for our stats
  const currentActivity = currentTask.factionWorkType || "unknown";
  if (currentJobInPriority.activity !== currentActivity && currentJobInPriority.type === "faction") {
    // Wrong activity type - reassign to get better rep gain
    return true;
  }
  
  return false;
}

/**
 * Get the best work assignment for a sleeve
 * @param {NS} ns
 * @param {number} sleeveNumber
 * @param {Set} usedJobs - Jobs already taken by other sleeves
 * @returns {Object|null} Job assignment or null
 */
function getBestSleeveAssignment(ns, sleeveNumber, usedJobs) {
  const stats = getSleeveStats(ns, sleeveNumber);
  const jobs = getPriorityJobs(ns, stats, true, usedJobs, { 
    deprioritizeDonatable: CONFIG.DEPRIORITIZE_DONATABLE_FACTIONS 
  });
  
  // Find first job not already used by another sleeve
  for (const job of jobs) {
    if (!usedJobs.has(job.name)) {
      return job;
    }
  }
  
  return null;
}

/**
 * Execute a job assignment for a sleeve
 * @param {NS} ns
 * @param {number} sleeveNumber
 * @param {Object} job - Job from priorityJobs system
 * @returns {boolean} Success
 */
function executeSleeveAssignment(ns, sleeveNumber, job) {
  if (job.type === "faction") {
    try {
      return ns.sleeve.setToFactionWork(sleeveNumber, job.name, job.activity);
    } catch (e) {
      ns.print(`ERROR: Failed to set sleeve ${sleeveNumber} to faction work: ${e}`);
      return false;
    }
  } else if (job.type === "company") {
    try {
      // For company work, we need to make sure the sleeve has a job at this company
      // Sleeves can work at companies the player has applied to
      return ns.sleeve.setToCompanyWork(sleeveNumber, job.name);
    } catch (e) {
      ns.print(`ERROR: Failed to set sleeve ${sleeveNumber} to company work: ${e}`);
      return false;
    }
  }
  
  return false;
}