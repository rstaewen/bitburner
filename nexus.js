/** @param {NS} ns */
export async function main(ns) {
  ns.kill("orchestrateSleeves.js", "nexus");
  ns.exec("orchestrateSleeves.js", "nexus");
  ns.kill("progression.js", "nexus");
  ns.exec("progression.js", "nexus");
  ns.kill("managejobs.js", "nexus");
  ns.exec("managejobs.js", "nexus");
}