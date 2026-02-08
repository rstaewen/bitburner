import {
  execSingleton
} from "utils/server-utils.js";
import { isInBitNode } from "utils/bitnode-cache.js";

/** @param {NS} ns */
export async function main(ns) {
  // Cache bitnode info first (run once, ~4GB, then exits)
  ns.tprint("Caching bitnode multipliers...");
  ns.run("cache-bitnode-mults.js");
  ns.singularity.createProgram("BruteSSH.exe", false);
  await ns.sleep(100);
  ns.tprint("Killing all scripts before beginning new run...");
  ns.killall("home", true);
  await ns.sleep(100);
  // BN9 SPECIAL PATH: hacknet-manager is primary controller
  if (isInBitNode(ns, 9)) {
    ns.tprint("BN9 detected - starting hacknet-manager as primary controller");
    const pid = execSingleton(ns, "hacknet-manager.js", "home", false);
    if (pid > 0) {
      ns.tprint("Started hacknet-manager (BN9 primary), pid: ", pid);
    } else {
      ns.tprint("FAILED to start hacknet-manager!");
    }
    return;
  }

  ns.tprint("Starting up server-manager, which will then load the hacking orchestrator itself.");
  const pid = execSingleton(ns, "server-manager.js", "home", false);
  if (pid > 0) {
    ns.tprint("started server-manager, pid: ", pid);
  } else {
    ns.tprint("failed to start server-manager!");
  }
}