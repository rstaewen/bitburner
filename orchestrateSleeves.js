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
  STAT_FLOOR: 10000, // Average exp threshold for training
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

// Track failed company jobs to avoid thrashing
// Maps company name -> timestamp of failure (to allow retry after cooldown)
const failedCompanyJobs = new Map();
const FAILED_JOB_COOLDOWN_MS = 60000; // Retry failed jobs after 60 seconds

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
      
      // Get full priority list ONCE (no exclusions) - sorted by priority
      const dummyStats = getSleeveStats(ns, 0);
      const allPriorityJobs = getPriorityJobs(ns, dummyStats, true, new Set(), { 
        deprioritizeDonatable: CONFIG.DEPRIORITIZE_DONATABLE_FACTIONS 
      });
      
      // Only the top N jobs (where N = numSleeves) are considered "high priority"
      // Jobs beyond that shouldn't be worked on when better options exist
      const topPriorityJobNames = new Set(
        allPriorityJobs.slice(0, numSleeves).map(j => j.name)
      );
      
      // Track which jobs are being worked by sleeves that should continue
      const usedJobs = new Set();
      
      // First pass: determine which sleeves should keep their current job
      // Only keep if it's a TOP PRIORITY job, not just any valid job
      const sleeveNeedsReassignment = [];
      
      for (let i = 0; i < numSleeves; i++) {
        const task = ns.sleeve.getTask(i);
        const desiredJob = getDesiredJob(ns, i);
        const currentJobName = task?.factionName || task?.companyName || null;
        
        let needsReassignment = true;
        
        if (desiredJob === Jobs.REP && currentJobName && topPriorityJobNames.has(currentJobName)) {
          // Current job is still a TOP priority - keep it
          usedJobs.add(currentJobName);
          needsReassignment = false;
        }
        
        sleeveNeedsReassignment.push(needsReassignment);
      }
      
      // Second pass: assign jobs to sleeves that need them
      for (let i = 0; i < numSleeves; i++) {
        const task = ns.sleeve.getTask(i);
        const desiredJob = getDesiredJob(ns, i);
        
        // Check if we need to do anything
        let needsAction = false;
        
        if (desiredJob === Jobs.AUG) {
          needsAction = !ns.isRunning("utils/augmentSleeve.js", ns.getServer().hostname, i);
        } else if (desiredJob === Jobs.TRAIN) {
          needsAction = !ns.isRunning("utils/trainSleeve.js", ns.getServer().hostname, i);
        } else if (desiredJob === Jobs.REP) {
          // Use the pre-computed reassignment flag
          needsAction = sleeveNeedsReassignment[i];
          
          // Also check if not doing faction/company work at all
          // But if already doing crime, only reassign if there's actually a job available
          if (!task || (task.type !== "FACTION" && task.type !== "COMPANY")) {
            if (task?.crimeType) {
              // Already on crime fallback - only reassign if a real job exists
              const potentialJob = getBestSleeveAssignment(ns, i, usedJobs);
              needsAction = potentialJob !== null;
              if (potentialJob) usedJobs.add(potentialJob.name); // Reserve it
            } else {
              needsAction = true;
            }
          }
        } else if (desiredJob === Jobs.CRIME) {
          needsAction = !task?.crimeType;
        }
        
        if (!needsAction) {
          continue;
        }
        
        // Kill any existing scripts for this sleeve before reassigning
        killSleeveScripts(ns, i);
        
        // Assign the job
        if (desiredJob === Jobs.AUG) {
          const pid = ns.exec("utils/augmentSleeve.js", ns.getServer().hostname, 1, i);
          ns.print(`Sleeve ${i}: Started augment purchasing, pid=${pid}`);
        } 
        else if (desiredJob === Jobs.TRAIN) {
          const pid = ns.exec("utils/trainSleeve.js", ns.getServer().hostname, 1, i);
          ns.print(`Sleeve ${i}: Started training, pid=${pid}`);
        } 
        else if (desiredJob === Jobs.REP) {
          const assignment = getBestSleeveAssignment(ns, i, usedJobs);
          
          if (assignment) {
            const success = executeSleeveAssignment(ns, i, assignment);
            
            if (success) {
              // Mark this job as used
              usedJobs.add(assignment.name);
              // Clear from failed jobs if it was there
              failedCompanyJobs.delete(assignment.name);
              ns.print(`Sleeve ${i}: ${assignment.type} - ${assignment.name} (${assignment.activity})`);
            } else {
              ns.print(`Sleeve ${i}: Failed to assign ${assignment.type} - ${assignment.name}`);
              // Track failed company jobs to prevent thrashing
              if (assignment.type === "company") {
                failedCompanyJobs.set(assignment.name, Date.now());
              }
              // Fallback to crime
              ns.sleeve.setToCommitCrime(i, "Homicide");
              ns.print(`Sleeve ${i}: Fallback to Homicide`);
            }
          } else {
            // No valid assignment - only assign to crime if not already doing it
            if (task?.crimeType !== "Homicide") {
              ns.sleeve.setToCommitCrime(i, "Homicide");
              ns.print(`Sleeve ${i}: No priority jobs available, committing Homicide`);
            }
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
    if (ns.isRunning(script, ns.getServer().hostname, sleeveNumber)) {
      ns.kill(script, ns.getServer().hostname, sleeveNumber);
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
  const avgExp = (sleeve.exp.agility + sleeve.exp.defense + sleeve.exp.dexterity + sleeve.exp.strength) / 4;
  const avgPlayerExp = (ns.getPlayer().exp.agility + ns.getPlayer().exp.defense + ns.getPlayer().exp.dexterity + ns.getPlayer().exp.strength) / 4;
  
  if (purchasableAugs.length > 0 && sleeve.shock === 0) {
    return Jobs.AUG;
  } else if (avgExp < CONFIG.STAT_FLOOR) {
    return Jobs.TRAIN;
  } else if (avgPlayerExp < CONFIG.STAT_FLOOR) {
    return Jobs.TRAIN;
  } else {
    return Jobs.REP;
  }
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
  
  const now = Date.now();
  
  // Find first job not already used by another sleeve and not recently failed
  for (const job of jobs) {
    if (usedJobs.has(job.name)) continue;
    
    // Check if this company job recently failed (still on cooldown)
    if (job.type === "company" && failedCompanyJobs.has(job.name)) {
      const failedAt = failedCompanyJobs.get(job.name);
      if (now - failedAt < FAILED_JOB_COOLDOWN_MS) {
        continue; // Skip, still on cooldown
      } else {
        // Cooldown expired, clear and allow retry
        failedCompanyJobs.delete(job.name);
      }
    }
    
    return job;
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