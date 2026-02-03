import { 
  execSingleton
} from "utils/server-utils.js";

/** @param {NS} ns */
export async function main(ns) {
  const currentServer = ns.getServer().hostname;
  execSingleton(ns, "hacknet-manager.js", currentServer, false);
  execSingleton(ns, "orchestrateSleeves.js", currentServer, false);
  execSingleton(ns, "progression.js", currentServer, false);
  execSingleton(ns, "managejobs.js", currentServer, false);
}