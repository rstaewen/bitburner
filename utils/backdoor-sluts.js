/** @param {NS} ns */

const BACKDOOR_TARGETS = ["CSEC", "I.I.I.I", "avmnite-02h", "run4theh111z", "fulcrumassets", "powerhouse-fitness", "zb-institute", "w0r1d_d43m0n"];

/**
 * Find path from home to target using BFS
 * @param {NS} ns
 * @param {string} target
 * @returns {string[] | null}
 */
function findPath(ns, target) {
  if (target === "home") return ["home"];

  const visited = new Set(["home"]);
  const queue = [["home"]];

  while (queue.length > 0) {
    const path = queue.shift();
    const current = path[path.length - 1];

    for (const neighbor of ns.scan(current)) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);

      const newPath = [...path, neighbor];
      if (neighbor === target) return newPath;
      queue.push(newPath);
    }
  }
  return null;
}

/**
 * Check if a server can be backdoored
 * @param {NS} ns
 * @param {string} server
 * @returns {{canBackdoor: boolean, reason?: string}}
 */
function canBackdoor(ns, server) {
  if (!ns.serverExists(server)) {
    return { canBackdoor: false, reason: "not found" };
  }

  const serverObj = ns.getServer(server);

  if (serverObj.backdoorInstalled) {
    return { canBackdoor: false, reason: "already done" };
  }

  if (!serverObj.hasAdminRights) {
    return { canBackdoor: false, reason: "no root" };
  }

  if (ns.getHackingLevel() < serverObj.requiredHackingSkill) {
    return { canBackdoor: false, reason: `need ${serverObj.requiredHackingSkill} hack` };
  }

  return { canBackdoor: true };
}

/**
 * Backdoor a single server (navigate, backdoor, return home)
 * @param {NS} ns
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function backdoorServer(ns, target) {
  const path = findPath(ns, target);
  if (!path) {
    ns.print(`ERROR: No path to ${target}`);
    return false;
  }

  // Navigate to target
  for (const hop of path) {
    if (!ns.singularity.connect(hop)) {
      ns.print(`ERROR: Failed to connect to ${hop}`);
      ns.singularity.connect("home");
      return false;
    }
  }

  // Install backdoor (this takes time!)
  ns.print(`Installing backdoor on ${target}...`);
  await ns.singularity.installBackdoor();

  // Return home
  ns.singularity.connect("home");

  ns.tprint(`SUCCESS: Backdoored ${target}`);
  await ns.sleep(1000);
  const invitations = ns.singularity.checkFactionInvitations();
  for (let i = 0; i< invitations.length; i++) {
    ns.tprint(`SUCCESS: Attempting to join: ${invitations[i]}`);
    ns.singularity.joinFaction(invitations[i]);
  }
  return true;
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // Optional: pass specific target as argument, otherwise process all
  const targets = ns.args.length > 0
    ? ns.args.filter(arg => BACKDOOR_TARGETS.includes(arg))
    : BACKDOOR_TARGETS;

  let count = 0;

  for (const target of targets) {
    const { canBackdoor: ready, reason } = canBackdoor(ns, target);

    if (!ready) {
      ns.print(`SKIP: ${target} - ${reason}`);
      continue;
    }

    const success = await backdoorServer(ns, target);
    if (success) count++;
  }

  ns.print(`Backdoored ${count} server(s)`);
}