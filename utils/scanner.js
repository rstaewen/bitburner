/** @param {NS} ns */

/**
 * Recursively scan the entire network starting from home
 * @param {NS} ns
 * @returns {string[]} Array of all server hostnames
 */
export function getAllServers(ns) {
  const visited = new Set();
  const queue = ["home"];
  
  while (queue.length > 0) {
    const server = queue.shift();
    if (visited.has(server)) continue;
    
    visited.add(server);
    const neighbors = ns.scan(server);
    
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }
  
  return Array.from(visited);
}

/**
 * Categorize servers into targets and runners
 * @param {NS} ns
 * @param {string[]} servers
 * @param {boolean} includeHome - Whether to include home as a runner
 * @returns {{purchasedServers: string[], targetServers: string[], runnerServers: string[]}}
 */
export function categorizeServers(ns, servers, includeHome = false) {
  const purchasedServers = ns.getPurchasedServers();
  const purchasedSet = new Set(purchasedServers);
  
  const targetServers = [];
  const runnerServers = [];
  
  for (const server of servers) {
    const maxMoney = ns.getServerMaxMoney(server);
    const maxRam = ns.getServerMaxRam(server);
    const hasRoot = ns.hasRootAccess(server);
    
    // Handle home separately
    if (server === "home") {
      if (includeHome && maxRam > 0) {
        runnerServers.push(server);
      }
      continue;
    }
    
    // Target servers: have money to steal (not purchased, not home)
    if (maxMoney > 0 && !purchasedSet.has(server)) {
      targetServers.push(server);
    }
    
    // Runner servers: have RAM and root access (include purchased servers)
    if (maxRam > 0 && hasRoot) {
      runnerServers.push(server);
    }
  }
  
  return {
    purchasedServers,
    targetServers,
    runnerServers
  };
}