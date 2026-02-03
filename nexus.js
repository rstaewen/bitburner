/** @param {NS} ns */
export async function main(ns) {
  ns.kill("orchestrateSleeves.js", ns.getServer().hostname);
  ns.exec("orchestrateSleeves.js", ns.getServer().hostname);
  ns.kill("progression.js", ns.getServer().hostname);
  ns.exec("progression.js", ns.getServer().hostname);
  ns.kill("managejobs.js", ns.getServer().hostname);
  ns.exec("managejobs.js", ns.getServer().hostname);
}