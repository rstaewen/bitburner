/** @param {NS} ns */
export async function main(ns) {
  await ns.sleep(100);
  ns.tprint("Starting up server-ugrader and orchestrator, in that order. First server manager...");
  ns.exec("server-manager.js", "home");
  ns.tprint("Now orchestrator...");
  await ns.sleep(1000);
  ns.tprint("10...");
  await ns.sleep(1000);
  ns.tprint("9...");
  await ns.sleep(1000);
  ns.tprint("8...");
  await ns.sleep(1000);
  ns.tprint("7...");
  await ns.sleep(1000);
  ns.tprint("6...");
  await ns.sleep(1000);
  ns.tprint("5...");
  await ns.sleep(1000);
  ns.tprint("4...");
  await ns.sleep(1000);
  ns.tprint("3...");
  await ns.sleep(1000);
  ns.tprint("2...");
  await ns.sleep(1000);
  ns.tprint("1...");
  await ns.sleep(1000);
  ns.exec("orchestratorv2.js", "home");
}