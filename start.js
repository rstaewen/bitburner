/** @param {NS} ns */
export async function main(ns) {
  ns.tprint("Killing all scripts before beginning new run...");
  ns.killall("home", true);
  ns.tprint("Starting up server-ugrader and orchestrator, in that order...");
  ns.exec("server-upgrader.js", "home");
  ns.exec("orchestratorv2.js", "home");
  ns.singularity.createProgram("BruteSSH.exe", false);
}