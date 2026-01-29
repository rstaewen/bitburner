/** @param {NS} ns */
import { getServerValues, getServerEfficiencies, getServerXPEfficiencies, getBestHacknetBoostTarget } from '/utils/server-utils.js';

export async function main(ns) {
  ns.ui.openTail();
  ns.disableLog("ALL");
  
  ns.print("=== Testing getServerValues ===");
  const serverValues = getServerValues(ns);
  
  // Sort by value and show top 15
  const sortedByValue = Array.from(serverValues.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);
  
  ns.print("\nTop 15 servers by value ($/sec):");
  for (const s of sortedByValue) {
    ns.print(`  ${s.server}: $${ns.formatNumber(s.value)}/s (maxMoney: $${ns.formatNumber(s.maxMoney)}, reqLevel: ${s.reqLevel}, cycle: ${s.cycleTime.toFixed(1)}s)`);
  }
  
  ns.print("\n=== Testing getServerEfficiencies ===");
  const efficiencies = getServerEfficiencies(ns);
  
  // Sort by efficiency and show top 15
  const sortedByEfficiency = Array.from(efficiencies.values())
    .sort((a, b) => b.efficiency - a.efficiency)
    .slice(0, 15);
  
  ns.print("\nTop 15 servers by efficiency ($/sec/thread):");
  for (const s of sortedByEfficiency) {
    ns.print(`  ${s.server}: $${ns.formatNumber(s.efficiency)}/s/thread (value: $${ns.formatNumber(s.value)}/s, threads: ${s.totalThreads}, reqLevel: ${s.reqLevel})`);
  }
  
  ns.print("\n=== Testing getServerXPEfficiencies ===");
  const xpEfficiencies = getServerXPEfficiencies(ns);
  
  // Sort by XP efficiency and show top 15
  const sortedByXP = Array.from(xpEfficiencies.values())
    .sort((a, b) => b.xpEfficiency - a.xpEfficiency)
    .slice(0, 15);
  
  ns.print("\nTop 15 servers by XP efficiency (XP/thread/sec):");
  for (const s of sortedByXP) {
    ns.print(`  ${s.server}: ${ns.formatNumber(s.xpEfficiency)} XP/t/s (xp/thread: ${ns.formatNumber(s.xpPerThread)}, cycle: ${s.cycleTime.toFixed(1)}s, reqLevel: ${s.reqLevel})`);
  }
  
  ns.print("\n=== Testing getBestHacknetBoostTarget ===");
  const target = getBestHacknetBoostTarget(ns);
  ns.print(`Selected target: ${target}`);
}