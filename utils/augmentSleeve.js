/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("sleep");
  const SLEEVE_NUMBER = ns.args[0] || 0;
  const sleeve = ns.sleeve.getSleeve(SLEEVE_NUMBER);

  const augs = ns.sleeve.getSleevePurchasableAugs(SLEEVE_NUMBER).sort();
  while (augs.length > 0) {
    let failedPuchase = false;
    for (let i = 0; i< augs.length; i++) {
      if (augs[i].name == "QLink") {
        ns.tprint("DO NOT BUY QLINK!");
        continue;
      }
      let succededPurchase = ns.sleeve.purchaseSleeveAug(SLEEVE_NUMBER, augs[i].name);
      failedPuchase |= !succededPurchase;
    }
    if (failedPuchase) {
      ns.print("Failed purchase! waiting 10s")
    } else {
      return true;
    }
    await ns.sleep(10000);
  }
}