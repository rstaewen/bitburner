import { getTargets } from "utils/findAugRepTarget.js";

/** @param {NS} ns */
export async function main(ns) {
  const CYCLE_TIME = 10 * 60 * 1000; // 10 minutes in milliseconds
  const CHECK_INTERVAL = 1000; // Check every second
  
  ns.disableLog("sleep");
  ns.ui.openTail();
  const SLEEVE_NUMBER = ns.args[0] || 0;
  const sleeve = ns.sleeve.getSleeve(SLEEVE_NUMBER);
  
  while (true) {
    const targets = getTargets(ns, true);

    if (targets.length > 0) {
      const workTypes = ns.singularity.getFactionWorkTypes(targets[0].minRepReqFaction).sort();
      const setWork = ns.sleeve.setToFactionWork(SLEEVE_NUMBER, targets[0].minRepReqFaction, workTypes[0])

      ns.print("set work to: ", targets[0].name, "type:", workTypes[0], "status:", setWork);
    } else {
      ns.print("no targets?");
    }

    await ns.sleep(CYCLE_TIME);
  }
}