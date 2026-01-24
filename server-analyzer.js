/**
 * Server Value Analyzer
 * Ranks servers by true profitability, accounting for growth difficulty
 * 
 * Usage: run server-analyzer.js [minHackLevel] [maxHackLevel]
 * Example: run server-analyzer.js 1 3000
 */

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();
  
  const minHackLevel = parseInt(ns.args[0]) || 1;
  const maxHackLevel = parseInt(ns.args[1]) || ns.getHackingLevel();
  const stepSize = parseInt(ns.args[2]) || 100;
  
  // Get all hackable servers
  const allServers = getAllServers(ns);
  const hackableServers = allServers.filter(s => {
    const server = ns.getServer(s);
    return server.moneyMax > 0 && !server.purchasedByPlayer && s !== "home";
  });
  
  ns.print(`\n${"═".repeat(70)}`);
  ns.print(`           SERVER VALUE ANALYZER`);
  ns.print(`${"═".repeat(70)}`);
  ns.print(`Analyzing ${hackableServers.length} hackable servers`);
  ns.print(`Hacking level range: ${minHackLevel} - ${maxHackLevel} (step ${stepSize})\n`);
  
  // Constants matching orchestrator
  const HACK_TARGET = 0.95;  // Hack away 95%, leave 5%
  const HOME_CORES = ns.getServer("home").cpuCores;
  
  // Analyze at different hacking levels
  const results = new Map(); // level -> sorted server list
  
  for (let level = minHackLevel; level <= maxHackLevel; level += stepSize) {
    const serverValues = [];
    
    for (const serverName of hackableServers) {
      const server = ns.getServer(serverName);
      
      // Skip if we can't hack at this level
      if (server.requiredHackingSkill > level) continue;
      
      // Create a mock player at this level
      const player = ns.getPlayer();
      player.skills.hacking = level;
      
      // Calculate server value
      const value = calculateServerValue(ns, server, player, HOME_CORES, HACK_TARGET);
      
      if (value.profitPerSecond > 0) {
        serverValues.push({
          name: serverName,
          ...value
        });
      }
    }
    
    // Sort by profit per second
    serverValues.sort((a, b) => b.profitPerSecond - a.profitPerSecond);
    results.set(level, serverValues);
  }
  
  // Print results for each level
  for (const [level, servers] of results) {
    ns.print(`\n${"─".repeat(70)}`);
    ns.print(`  HACKING LEVEL ${level} - Top 15 Servers`);
    ns.print(`${"─".repeat(70)}`);
    ns.print(`${"Server".padEnd(20)} ${"$/sec".padStart(12)} ${"GrowTh".padStart(8)} ${"GrowEff".padStart(12)} ${"GrowRate".padStart(8)} ${"CycleTime".padStart(10)} ${"MaxMoney".padStart(12)}`);
    ns.print(`${"-".repeat(20)} ${"-".repeat(12)} ${"-".repeat(8)} ${"-".repeat(9)} ${"-".repeat(8)} ${"-".repeat(10)} ${"-".repeat(12)}`);
    
    for (const s of servers.slice(0, 15)) {
      const cycleTimeStr = formatTime(s.totalCycleTime);
      ns.print(
        `${s.name.padEnd(20)} ` +
        `${("$" + ns.formatNumber(s.profitPerSecond)).padStart(12)} ` +
        `${s.growThreads.toString().padStart(8)} ` +
        `${("$" + ns.formatNumber(s.profitPerSecond / s.growThreads)).padStart(12)} ` +
        `${s.growthRate.toString().padStart(8)} ` +
        `${cycleTimeStr.padStart(10)} ` +
        `${("$" + ns.formatNumber(s.maxMoney)).padStart(12)}`
      );
    }
    
    // Show worst servers too
    if (servers.length > 15) {
      ns.print(`\n  ... and ${servers.length - 15} more servers`);
      ns.print(`\n  WORST 5 Servers (avoid these):`);
      for (const s of servers.slice(-5).reverse()) {
        const cycleTimeStr = formatTime(s.totalCycleTime);
        ns.print(
          `${s.name.padEnd(20)} ` +
          `${("$" + ns.formatNumber(s.profitPerSecond)).padStart(12)} ` +
          `${s.growThreads.toString().padStart(8)} ` +
          `${("$" + ns.formatNumber(s.profitPerSecond / s.growThreads)).padStart(12)} ` +
          `${s.growthRate.toString().padStart(8)} ` +
          `${cycleTimeStr.padStart(10)} ` +
          `${("$" + ns.formatNumber(s.maxMoney)).padStart(12)}`
        );
      }
    }
  }
  
  // Generate priority lists for orchestrator
  ns.print(`\n${"═".repeat(70)}`);
  ns.print(`  RECOMMENDED PRIORITY_PREP_TARGETS BY LEVEL`);
  ns.print(`${"═".repeat(70)}`);
  
  for (const [level, servers] of results) {
    const top10 = servers.slice(0, 10).map(s => `"${s.name}"`).join(", ");
    ns.print(`\n// Hacking Level ${level}:`);
    ns.print(`const PRIORITY_PREP_TARGETS = [${top10}];`);
  }
  
  // Generate blacklist (servers that should never be hacked)
  ns.print(`\n${"═".repeat(70)}`);
  ns.print(`  RECOMMENDED BLACKLIST (growthRate <= 10)`);
  ns.print(`${"═".repeat(70)}`);
  
  const blacklist = hackableServers.filter(s => {
    const growth = ns.getServerGrowth(s);
    return growth <= 10;
  }).map(s => ({
    name: s,
    growth: ns.getServerGrowth(s),
    maxMoney: ns.getServerMaxMoney(s)
  }));
  
  blacklist.sort((a, b) => a.growth - b.growth);
  
  ns.print(`\nServers with growthRate <= 10 (consider skipping):`);
  for (const s of blacklist) {
    ns.print(`  ${s.name.padEnd(20)} growth=${s.growth.toString().padStart(3)}, max=$${ns.formatNumber(s.maxMoney)}`);
  }
  
  const blacklistNames = blacklist.map(s => `"${s.name}"`).join(", ");
  ns.print(`\nconst BLACKLIST_SERVERS = [${blacklistNames}];`);
  
  // Write results to file
  const outputFile = "/data/server-analysis.txt";
  let output = "SERVER VALUE ANALYSIS\n";
  output += `Generated: ${new Date().toLocaleString()}\n\n`;
  
  for (const [level, servers] of results) {
    output += `\n=== HACKING LEVEL ${level} ===\n`;
    for (const s of servers) {
      output += `${s.name}: $${ns.formatNumber(s.profitPerSecond)}/s, eff=$${s.profitPerSecond/s.growThreads}/t, grow=${s.growThreads}t, rate=${s.growthRate}\n`;
    }
  }
  
  await ns.write(outputFile, output, "w");
  ns.print(`\n✅ Full results written to ${outputFile}`);
}

/**
 * Calculate the true value of a server accounting for growth difficulty
 * @param {NS} ns
 * @param {Server} server
 * @param {Player} player
 * @param {number} homeCores
 * @param {number} hackTarget - fraction to hack away (0.95 = leave 5%)
 */
function calculateServerValue(ns, server, player, homeCores, hackTarget) {
  const maxMoney = server.moneyMax;
  const growthRate = server.serverGrowth;
  const minSec = server.minDifficulty;
  
  // Create a "prepped" version of the server for calculations
  const preppedServer = { ...server };
  preppedServer.hackDifficulty = minSec;
  preppedServer.moneyAvailable = maxMoney;
  
  // 1. Calculate hack phase
  const hackPercent = ns.formulas.hacking.hackPercent(preppedServer, player);
  if (hackPercent <= 0) {
    return { profitPerSecond: 0, growThreads: 0, growthRate, maxMoney, totalCycleTime: Infinity };
  }
  
  // Threads to hack away 95%
  const hackThreads = Math.ceil(hackTarget / hackPercent);
  const actualHackPercent = hackThreads * hackPercent;
  const moneyStolen = maxMoney * Math.min(actualHackPercent, 1);
  const moneyAfterHack = maxMoney - moneyStolen;
  
  // Security increase from hack
  const hackSecIncrease = hackThreads * 0.002;
  
  // Hack time at min security
  const hackTime = ns.formulas.hacking.hackTime(preppedServer, player);
  
  // 2. Calculate grow phase
  // Server state after hack (elevated security)
  const postHackServer = { ...preppedServer };
  postHackServer.moneyAvailable = Math.max(moneyAfterHack, 1); // At least $1
  postHackServer.hackDifficulty = minSec + hackSecIncrease;
  
  // Threads to grow back to max
  let growThreads;
  try {
    growThreads = Math.ceil(ns.formulas.hacking.growThreads(postHackServer, player, maxMoney, homeCores));
  } catch {
    // Fallback if formulas fail
    growThreads = Math.ceil(Math.log(maxMoney / Math.max(moneyAfterHack, 1)) / Math.log(1.03) * (100 / growthRate));
  }
  
  // Cap grow threads at something reasonable to avoid Infinity
  growThreads = Math.min(growThreads, 1000000);
  
  // Security increase from grow
  const growSecIncrease = growThreads * 0.004;
  
  // Grow time (at elevated security from hack)
  const growTime = ns.formulas.hacking.growTime(postHackServer, player);
  
  // 3. Calculate weaken phase(s)
  // Total security to remove: hack increase + grow increase
  const totalSecIncrease = hackSecIncrease + growSecIncrease;
  const weakenThreads = Math.ceil(totalSecIncrease / 0.05); // 0.05 per thread
  
  // Weaken time at max elevated security (worst case)
  const postGrowServer = { ...preppedServer };
  postGrowServer.hackDifficulty = minSec + totalSecIncrease;
  const weakenTime = ns.formulas.hacking.weakenTime(postGrowServer, player);
  
  // 4. Calculate total cycle time
  // In our batched approach: H+W lands together, then G+W lands together
  // So cycle time is approximately: max(hackTime, weakenTime) + max(growTime, weakenTime)
  // But weaken time varies... let's use a weighted average
  
  // Simplified: hackTime + growTime + weakenTime (conservative estimate)
  // The batching saves us one full weaken cycle, so:
  const batchedCycleTime = Math.max(hackTime, weakenTime) + Math.max(growTime, weakenTime);
  
  // Alternative: sequential cycle time for comparison
  const sequentialCycleTime = hackTime + weakenTime + growTime + weakenTime;
  
  // Use batched time since that's what we do
  const totalCycleTime = batchedCycleTime;
  
  // 5. Calculate profit per second
  const profitPerSecond = moneyStolen / (totalCycleTime / 1000);
  
  // 6. Calculate "adjusted" profit that penalizes high thread counts
  // This represents opportunity cost - threads used here can't be used elsewhere
  const totalThreads = hackThreads + growThreads + weakenThreads;
  const threadEfficiency = moneyStolen / totalThreads; // $/thread
  
  return {
    profitPerSecond,
    threadEfficiency,
    growThreads,
    hackThreads,
    weakenThreads,
    totalThreads,
    growthRate,
    maxMoney,
    moneyStolen,
    hackTime,
    growTime,
    weakenTime,
    totalCycleTime,
    hackSecIncrease,
    growSecIncrease,
    totalSecIncrease
  };
}

/**
 * Get all servers in the network
 * @param {NS} ns
 * @returns {string[]}
 */
function getAllServers(ns) {
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
 * Format milliseconds as human readable time
 * @param {number} ms
 * @returns {string}
 */
function formatTime(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms/60000).toFixed(1)}m`;
  return `${(ms/3600000).toFixed(1)}h`;
}