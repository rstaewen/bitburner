import { getTargets } from "utils/findAugRepTarget.js";

/** @param {NS} ns */
export async function main(ns) {
  const CHECK_INTERVAL = 1000;
  
  ns.disableLog("sleep");
  ns.disableLog("exec");
  ns.disableLog("kill");
  ns.ui.openTail();
  
  ns.print("Starting sleeve controller...");

  while (true) {
    try {
      const numSleeves = ns.sleeve.getNumSleeves();
      const repTargets = getTargets(ns, true);
      const usedFactions = new Set();
      
      // First pass: record factions AND companies already in use by REP sleeves
      for (let i = 0; i < numSleeves; i++) {
        const task = ns.sleeve.getTask(i);
        const desiredJob = getDesiredJob(ns, i);
        const currentActivity = classifyTask(task);
        
        if (currentActivity === "REP" && desiredJob === "REP") {
          if (task?.factionName) {
            usedFactions.add(task.factionName);
          }
          if (task?.companyName) {
            usedFactions.add(task.companyName);
          }
        }
      }
      
      // Build faction priority list
      const factionPriority = [];
      for (const target of repTargets) {
        if (target && target.minRepReqFaction && !factionPriority.includes(target.minRepReqFaction)) {
          factionPriority.push(target.minRepReqFaction);
        }
      }
      
      // Second pass: assign jobs
      let factionIdx = 0;
      for (let i = 0; i < numSleeves; i++) {
        const task = ns.sleeve.getTask(i);
        const desiredJob = getDesiredJob(ns, i);
        
        // Check if we need to do anything
        let needsAction = false;
        
        if (desiredJob === "AUG") {
          needsAction = !ns.isRunning("utils/augmentSleeve.js", "nexus", i);
        } else if (desiredJob === "TRAIN") {
          needsAction = !ns.isRunning("utils/trainSleeve.js", "nexus", i);
        } else if (desiredJob === "REP") {
          const currentlyDoingFaction = task?.type === "FACTION";
          const currentlyDoingCompany = task?.type === "COMPANY";
          
          // Find next available priority faction
          let priorityFactionAvailable = false;
          for (let j = factionIdx; j < factionPriority.length; j++) {
            if (!usedFactions.has(factionPriority[j])) {
              priorityFactionAvailable = true;
              break;
            }
          }
          
          // Check if there's a company under threshold available
          let underThresholdCompanyAvailable = false;
          const corps = Object.values(ns.enums.CompanyName);
          const allFactions = Object.values(ns.enums.FactionName);
          const megacorps = corps.filter(corp => allFactions.includes(corp));
          const neededMegacorps = megacorps.filter(corp => ns.singularity.getFactionRep(corp) === 0);
          for (const company of neededMegacorps) {
            if (!usedFactions.has(company) && ns.singularity.getCompanyRep(company) < 25000) {
              underThresholdCompanyAvailable = true;
              break;
            }
          }
          
          if (currentlyDoingFaction) {
            needsAction = false;
          } else if (currentlyDoingCompany) {
            const companyRep = ns.singularity.getCompanyRep(task.companyName);
            const pastThreshold = companyRep >= 25000;
            const factionUnlocked = ns.singularity.getFactionRep(task.companyName) > 0;
            
            if (factionUnlocked) {
              // Faction is now unlocked, no point continuing company work
              needsAction = true;
            } else if (priorityFactionAvailable) {
              needsAction = true;
            } else if (pastThreshold && underThresholdCompanyAvailable) {
              needsAction = true;
            } else {
              needsAction = false;
            }
          } else {
            needsAction = true;
          }
        }
        
        if (!needsAction) {
          continue;
        }
        
        // Kill any existing scripts for this sleeve before reassigning
        killSleeveScripts(ns, i);
        
        // Assign the job
        if (desiredJob === "AUG") {
          const pid = ns.exec("utils/augmentSleeve.js", "nexus", 1, i);
          ns.print(`Sleeve ${i}: Started augment purchasing, pid=${pid}`);
        } 
        else if (desiredJob === "TRAIN") {
          const pid = ns.exec("utils/trainSleeve.js", "nexus", 1, i);
          ns.print(`Sleeve ${i}: Started training, pid=${pid}`);
        } 
        else if (desiredJob === "REP") {
          let assigned = false;
          
          // First priority: factions from augment targets
          while (factionIdx < factionPriority.length) {
            const faction = factionPriority[factionIdx];
            
            if (!usedFactions.has(faction)) {
              const workTypes = ns.singularity.getFactionWorkTypes(faction);
              if (workTypes.length > 0) {
                const priority = {
                  "Security Work": 0,
                  "Field Work": 1,
                  "Hacking Contracts": 2
                };
                workTypes.sort((a, b) => {
                  const priorityA = priority[a] ?? 999; // Unknown types go to end
                  const priorityB = priority[b] ?? 999;
                  return priorityA - priorityB;
                });
                ns.sleeve.setToFactionWork(i, faction, workTypes[0]);
                usedFactions.add(faction);
                assigned = true;
                ns.print(`Sleeve ${i}: Grinding rep with ${faction}`);
                factionIdx++;
                break;
              }
            }
            factionIdx++;
          }
          
          // Second priority: company jobs under 25k rep (optimal reset point)
          if (!assigned) {
            const OPTIMAL_REP_THRESHOLD = 25000;
            const FACTION_UNLOCK_REP = 400000;
            const corps = Object.values(ns.enums.CompanyName);
            const allFactions = Object.values(ns.enums.FactionName);
            const megacorps = corps.filter(corp => allFactions.includes(corp));
            const neededMegacorps = megacorps.filter(corp => ns.singularity.getFactionRep(corp) === 0);
            
            // First try: companies under optimal threshold
            for (const company of neededMegacorps) {
              if (usedFactions.has(company)) continue;
              
              const rep = ns.singularity.getCompanyRep(company);
              if (rep < OPTIMAL_REP_THRESHOLD) {
                if (task?.type !== "COMPANY" || task?.companyName !== company) {
                  ns.sleeve.setToCompanyWork(i, company);
                  ns.print(`Sleeve ${i}: Working at ${company} (${(rep/1000).toFixed(0)}k rep)`);
                }
                usedFactions.add(company);
                assigned = true;
                break;
              }
            }
            
            // Fallback: any company under 400k (highest rep first to unlock associated faction sooner)
            if (!assigned) {
              const sortedByEffectiveRep = neededMegacorps
                .filter(corp => !usedFactions.has(corp))
                .map(corp => ({ 
                  company: corp, 
                  rep: ns.singularity.getCompanyRep(corp), 
                  favor: ns.singularity.getCompanyFavor(corp) 
                }))
                .filter(c => c.rep < FACTION_UNLOCK_REP)
                .sort((a, b) => {
                  const timeToUnlockA = (FACTION_UNLOCK_REP - a.rep) / (1 + a.favor / 100);
                  const timeToUnlockB = (FACTION_UNLOCK_REP - b.rep) / (1 + b.favor / 100);
                  return timeToUnlockA - timeToUnlockB; // lowest time first
                });
              
              if (sortedByEffectiveRep.length > 0) {
                const { company, rep } = sortedByEffectiveRep[0];
                if (task?.type !== "COMPANY" || task?.companyName !== company) {
                  ns.sleeve.setToCompanyWork(i, company);
                  ns.print(`Sleeve ${i}: Working at ${company} (${(rep/1000).toFixed(0)}k rep, past threshold)`);
                }
                usedFactions.add(company);
                assigned = true;
              }
            }
          }
          
          // Last resort: crime
          if (!assigned) {
            if (task?.type !== "CRIME" || task?.crimeType !== "Homicide") {
              ns.sleeve.setToCommitCrime(i, "Homicide");
              ns.print(`Sleeve ${i}: No faction available, committing crimes`);
            }
          }
        }
      }
    } catch (e) {
      ns.print(`ERROR: ${e}`);
    }
    
    await ns.sleep(CHECK_INTERVAL);
  }
}

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

//don't try to purchase this even if purchasable, too expensive for the effort
const augExceptions = ["QLink"];

/** @param {NS} ns */
function getDesiredJob(ns, sleeveNumber) {
  const sleeve = ns.sleeve.getSleeve(sleeveNumber);
  const purchasableAugs = ns.sleeve.getSleevePurchasableAugs(sleeveNumber);
  const appropriateAugs = purchasableAugs.filter(aug => augExceptions.includes(aug.name) === false);
  const avgExp = (sleeve.exp.agility + sleeve.exp.defense + sleeve.exp.dexterity + sleeve.exp.strength) / 4;
  
  if (appropriateAugs.length > 0 && sleeve.shock === 0) {
    return "AUG";
  } else if (avgExp < 6000) {
    return "TRAIN";
  } else {
    return "REP";
  }
}

/** @param {SleeveTask} task */
function classifyTask(task) {
  if (!task) return "IDLE";
  
  switch (task.type) {
    case "FACTION":
      return "REP";
    case "COMPANY":
      return "REP";
    case "CLASS":
      return "TRAIN";
    case "CRIME":
      return "IDLE";
    default:
      return "IDLE";
  }
}