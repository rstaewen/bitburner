/** @param {NS} ns */
export async function main(ns) {
  const target = ns.args[0];
  const currentMoney = ns.getServerMoneyAvailable(target);
  const maxMoney = ns.getServerMaxMoney(target);
  
  const moneyPercent = maxMoney > 0 ? currentMoney / maxMoney : 0;

  while (moneyPercent > 0.01) {
    await ns.hack(target);
  }
}
