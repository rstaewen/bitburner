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
  ns.run("start-2.js");
}