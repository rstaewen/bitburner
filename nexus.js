/** @param {NS} ns */
export async function main(ns) {
  ns.kill("stock-trader-4s.js", "nexus");
  ns.exec("stock-trader-4s.js", "nexus");
  ns.kill("orchestrateSleeves.js", "nexus");
  ns.exec("orchestrateSleeves.js", "nexus");
  ns.kill("performanceMonitor.js", "nexus");
  ns.exec("performanceMonitor.js", "nexus");
  ns.kill("progression.js", "nexus");
  ns.exec("progression.js", "nexus");
  ns.kill("managejobs.js", "nexus");
  ns.exec("managejobs.js", "nexus");
}