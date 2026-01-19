/** @param {NS} ns */
export async function main(ns) {
  const CYCLE_TIME = 10 * 60 * 1000; // 10 minutes in milliseconds
  const CHECK_INTERVAL = 1000; // Check every second

  const SLEEVE_NUMBER = ns.args[0];
  
  ns.disableLog("sleep");
  ns.ui.openTail();
  let currentGymStatIndex = 0;

  ns.print(`Waiting for sleeve ${SLEEVE_NUMBER} to achieve full sync before training...`);

  ns.sleeve.setToSynchronize(SLEEVE_NUMBER)

  while (true) {
    if (ns.sleeve.getSleeve(SLEEVE_NUMBER).sync >= 100) {
      break;
    }
    await ns.sleep(CHECK_INTERVAL);
  }

  ns.print(`Waiting for sleeve ${SLEEVE_NUMBER} to heal shock before training...`);

  ns.sleeve.setToShockRecovery(SLEEVE_NUMBER)

  while (true) {
    if (ns.sleeve.getSleeve(SLEEVE_NUMBER).shock == 0) {
      break;
    }
    await ns.sleep(CHECK_INTERVAL);
  }
  
  // Best gym: Powerhouse Gym (Sector-12) - most stat gain per dollar
  const GYM = "Powerhouse Gym";
  const GYM_LOCATION = "Sector-12";
  
  // Best university: ZB Institute of Technology (Volhaven) - best Charisma training
  const UNIVERSITY = "ZB Institute of Technology";
  const UNIVERSITY_LOCATION = "Volhaven";
  
  // Gym stats to train (rotate through all 4)
  const GYM_STATS = ["strength", "defense", "dexterity", "agility"];
  
  ns.print("Starting balanced stat training script...");
  ns.print(`Gym: ${GYM} (${GYM_LOCATION})`);
  ns.print(`University: ${UNIVERSITY} (${UNIVERSITY_LOCATION})`);
  ns.print(`Cycle time: ${CYCLE_TIME / 60000} minutes per activity`);
  
  while (true) {
    for (let i = 0; i< GYM_STATS.length; i++) {
      const currentStat = GYM_STATS[i];
      ns.print(`Training ${currentStat} at ${GYM}...`);

      if (ns.sleeve.getSleeve(SLEEVE_NUMBER).city != GYM_LOCATION) {
        if (ns.sleeve.travel(SLEEVE_NUMBER, GYM_LOCATION)) {
          ns.print(`Successfully moved location to ${GYM_LOCATION}...`);
        } else {
            ns.tprint("ERROR: Failed to set sleeve gym location");
            await ns.sleep(CHECK_INTERVAL);
            continue;
        }
      }

      if (ns.sleeve.setToGymWorkout(SLEEVE_NUMBER, GYM, currentStat)) {
        await ns.sleep(CYCLE_TIME);
      } else {
          ns.tprint("ERROR: Failed to set sleeve workout");
          await ns.sleep(CHECK_INTERVAL);
          continue;
      }
    }

    if (ns.sleeve.getSleeve(SLEEVE_NUMBER).city != UNIVERSITY_LOCATION) {
      if (ns.sleeve.travel(SLEEVE_NUMBER, UNIVERSITY_LOCATION)) {
        ns.print(`Successfully moved location to ${UNIVERSITY_LOCATION}...`);
      } else {
          ns.tprint("ERROR: Failed to set university location");
          await ns.sleep(CHECK_INTERVAL);
          continue;
      }
    }
    
    // Train Charisma at university
    ns.print(`Training Charisma at ${UNIVERSITY}...`);

    if (ns.sleeve.setToUniversityCourse(SLEEVE_NUMBER, UNIVERSITY, "Leadership")) {
      await ns.sleep(CYCLE_TIME);
    } else {
        ns.tprint("ERROR: Failed to set sleeve studying leadership at university");
        await ns.sleep(CHECK_INTERVAL);
        continue;
    }

    // Train Hacking at university
    ns.print(`Training Hacking at ${UNIVERSITY}...`);

    if (ns.sleeve.setToUniversityCourse(SLEEVE_NUMBER, UNIVERSITY, "Algorithms")) {
      await ns.sleep(CYCLE_TIME);
    } else {
        ns.tprint("ERROR: Failed to set sleeve studying algorithms at university");
        await ns.sleep(CHECK_INTERVAL);
        continue;
    }
  }
}