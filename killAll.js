/**
 * Kill every running script across the network (including home).
 * Usage: run killAll.js
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("killall");
  const serversToClean = ns.scan("home");
  const visited = new Set(["home"]);
  const queue = [...serversToClean];
  const data = ns.flags([
    ['x', 'home'], // a default number means this flag is a number
  ]);
  const serverException = data['x']

  // Always kill scripts on home first to free up local RAM
  ns.killall("home", true);

  while (queue.length > 0) {
    const server = queue.shift();
    if (visited.has(server) || server === serverException) continue;
    visited.add(server);

    ns.killall(server, true);

    for (const neighbor of ns.scan(server)) {
      if (!visited.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  ns.tprint(`🔪 Killed scripts on ${visited.size} servers (including home).`);
}
