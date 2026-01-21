/** @param {NS} ns */
export async function main(ns) {
  ns.ui.openTail();
  while(true) {
    ns.print(ns.heart.break());
    await ns.sleep(1000);
  }
}