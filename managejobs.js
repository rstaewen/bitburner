/**
 * manageJobs.js - Manages megacorp job applications and promotions
 * 
 * Flies to different cities to apply for jobs at all megacorps,
 * and requests promotions when stats allow.
 * 
 * Run on home with minimal RAM requirements.
 */

// Megacorps and their locations
const MEGACORPS = {
  // Sector-12
  "MegaCorp": "Sector-12",
  "Blade Industries": "Sector-12",
  "Four Sigma": "Sector-12",
  // Aevum
  "ECorp": "Aevum",
  "Bachman & Associates": "Aevum",
  "Clarke Incorporated": "Aevum",
  "Fulcrum Technologies": "Aevum",
  // Volhaven
  "NWO": "Volhaven",
  "OmniTek Incorporated": "Volhaven",
  // Chongqing
  "KuaiGong International": "Chongqing",
};

// Job fields in order of preference
// Security (combat) is prioritized because sleeves do most of the company work
// and they have better combat stats than hacking (player gets script hacking, sleeves don't)
const JOB_FIELDS = [
  "Software",      // Best if we somehow have high hacking
  "Security",      // Best for sleeves (combat stats)
  "IT",            // Backup hacking option
  "Agent",         // Mixed requirements
  // "Business",   // Skip - scales off charisma which grows very slowly
];

/** @param {NS} ns */
export async function main(ns) {
  const args = ns.flags([
    ['once', false],    // Run once and exit (vs continuous loop)
    ['debug', false],   // Extra logging
  ]);
  
  ns.disableLog('ALL');
  
  if (!args.once) {
    ns.ui.openTail();
    ns.print('=== manageJobs.js starting ===');
  }
  
  while (true) {
    const player = ns.getPlayer();
    
    // Group megacorps by city to minimize travel
    const corpsByCity = groupByCity();
    
    for (const [city, corps] of Object.entries(corpsByCity)) {
      let needsTravel = false;
      
      // Check if any corp in this city needs attention
      for (const corp of corps) {
        if (needsJobApplication(ns, corp) || canGetPromotion(ns, corp)) {
          needsTravel = true;
          break;
        }
      }
      
      if (!needsTravel) continue;
      
      // Travel to city
      if (player.city !== city) {
        ns.singularity.travelToCity(city);
        if (args.debug) {
          ns.print(`DEBUG: Traveled to ${city}`);
        }
      }
      
      // Process each corp in this city
      for (const corp of corps) {
        // Apply for job if we don't have one
        if (needsJobApplication(ns, corp)) {
          const applied = applyForJob(ns, corp, args.debug);
          if (applied) {
            ns.print(`INFO: Got job at ${corp}`);
          }
        }
        
        // Try for promotion
        if (canGetPromotion(ns, corp)) {
          const promoted = tryPromotion(ns, corp, args.debug);
          if (promoted) {
            ns.print(`INFO: Promoted at ${corp}`);
          }
        }
      }
    }
    
    if (args.once) {
      ns.print('Job management complete (one-time run)');
      return;
    }
    
    // Check every 5 minutes
    await ns.sleep(5 * 60 * 1000);
  }
}

/**
 * Group megacorps by city for efficient travel
 * @returns {Object<string, string[]>}
 */
function groupByCity() {
  const byCity = {};
  for (const [corp, city] of Object.entries(MEGACORPS)) {
    if (!byCity[city]) byCity[city] = [];
    byCity[city].push(corp);
  }
  return byCity;
}

/**
 * Check if we need to apply for a job at this company
 * @param {NS} ns
 * @param {string} company
 * @returns {boolean}
 */
function needsJobApplication(ns, company) {
  // Check if we already have a job there
  const jobs = ns.singularity.getCompanyPositions(company);
  const currentJob = getCurrentJob(ns, company);
  
  return currentJob === null;
}

/**
 * Get current job at a company, or null if none
 * @param {NS} ns
 * @param {string} company
 * @returns {string|null}
 */
function getCurrentJob(ns, company) {
  const player = ns.getPlayer();
  return player.jobs[company] || null;
}

/**
 * Apply for a job at a company
 * @param {NS} ns
 * @param {string} company
 * @param {boolean} debug
 * @returns {boolean}
 */
function applyForJob(ns, company, debug) {
  // Try all fields - the game will give us the best position we qualify for
  // in each field, and we keep whichever is best overall
  let gotJob = false;
  
  for (const field of JOB_FIELDS) {
    const success = ns.singularity.applyToCompany(company, field);
    if (success) {
      gotJob = true;
      // Don't break - keep trying other fields to potentially get a better job
    }
  }
  
  if (gotJob && debug) {
    const job = getCurrentJob(ns, company);
    ns.print(`DEBUG: Got job at ${company}: ${job}`);
  } else if (!gotJob && debug) {
    ns.print(`DEBUG: Could not get job at ${company} - stats too low`);
  }
  
  return gotJob;
}

/**
 * Check if we might be eligible for a promotion
 * @param {NS} ns
 * @param {string} company
 * @returns {boolean}
 */
function canGetPromotion(ns, company) {
  const currentJob = getCurrentJob(ns, company);
  if (!currentJob) return false;
  
  // We have a job - might be able to get promoted
  // The game doesn't expose promotion requirements directly,
  // so we just try periodically
  return true;
}

/**
 * Try to get a promotion at a company
 * @param {NS} ns
 * @param {string} company
 * @param {boolean} debug
 * @returns {boolean}
 */
function tryPromotion(ns, company, debug) {
  const oldJob = getCurrentJob(ns, company);
  
  // Try to apply for a better position in the same field
  // The game will give us the best position we qualify for
  for (const field of JOB_FIELDS) {
    ns.singularity.applyToCompany(company, field);
  }
  
  const newJob = getCurrentJob(ns, company);
  
  if (newJob !== oldJob) {
    if (debug) {
      ns.print(`DEBUG: Promoted at ${company}: ${oldJob} -> ${newJob}`);
    }
    return true;
  }
  
  return false;
}