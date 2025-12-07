/** @param {NS} ns */

/**
 * Attempt to gain root access to a server
 * @param {NS} ns
 * @param {string} server
 * @returns {boolean} Whether root access was obtained
 */
export function tryNuke(ns, server) {
  // Already have root
  if (ns.hasRootAccess(server)) {
    return true;
  }
  
  // Check hacking level requirement
  const requiredLevel = ns.getServerRequiredHackingLevel(server);
  if (ns.getHackingLevel() < requiredLevel) {
    return false;
  }
  
  // Open all available ports
  let portsOpened = 0;
  
  if (ns.fileExists("BruteSSH.exe", "home")) {
    ns.brutessh(server);
    portsOpened++;
  }
  
  if (ns.fileExists("FTPCrack.exe", "home")) {
    ns.ftpcrack(server);
    portsOpened++;
  }
  
  if (ns.fileExists("relaySMTP.exe", "home")) {
    ns.relaysmtp(server);
    portsOpened++;
  }
  
  if (ns.fileExists("HTTPWorm.exe", "home")) {
    ns.httpworm(server);
    portsOpened++;
  }
  
  if (ns.fileExists("SQLInject.exe", "home")) {
    ns.sqlinject(server);
    portsOpened++;
  }
  
  // Check if we opened enough ports
  const requiredPorts = ns.getServerNumPortsRequired(server);
  if (portsOpened < requiredPorts) {
    return false;
  }
  
  // Nuke it
  ns.nuke(server);
  return ns.hasRootAccess(server);
}

/**
 * Attempt to nuke all servers in list
 * @param {NS} ns
 * @param {string[]} servers
 * @returns {number} Count of newly nuked servers
 */
export function nukeAll(ns, servers) {
  let newlyNuked = 0;
  
  for (const server of servers) {
    const hadRoot = ns.hasRootAccess(server);
    if (tryNuke(ns, server) && !hadRoot) {
      newlyNuked++;
      ns.tprint(`[+] Gained root on ${server}`);
    }
  }
  
  return newlyNuked;
}
