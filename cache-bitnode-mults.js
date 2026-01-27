/** @param {NS} ns */

/**
 * cache-bitnode-mults.js - One-shot script to cache BitNode multipliers and reset info
 * 
 * Run this once at startup (from start.js) to cache expensive BitNode info.
 * Other scripts can then read from the JSON file instead of paying RAM costs.
 * 
 * Saves:
 *   - ns.getBitNodeMultipliers() - 4 GB
 *   - ns.getResetInfo() - 1 GB
 * 
 * Usage: run cache-bitnode-mults.js
 * 
 * Output: /data/bitnode-cache.json
 */

const OUTPUT_FILE = "/data/bitnode-cache.json";

/** @param {NS} ns */
export async function main(ns) {
  const resetInfo = ns.getResetInfo();
  const bitNodeMults = ns.getBitNodeMultipliers();
  
  const data = {
    // Cache timestamp
    cachedAt: Date.now(),
    
    // === Reset Info (saves 1 GB) ===
    resetInfo: {
      currentNode: resetInfo.currentNode,
      
      // Source file levels (convert Map to object)
      ownedSF: Object.fromEntries(resetInfo.ownedSF),
      
      // Augmentations installed this bitnode
      ownedAugs: resetInfo.ownedAugs,
      
      // Last reset timestamps
      lastAugReset: resetInfo.lastAugReset,
      lastNodeReset: resetInfo.lastNodeReset,
    },
    
    // === BitNode Multipliers (saves 4 GB) ===
    multipliers: {
      // Hacking
      HackExpGain: bitNodeMults.HackExpGain,
      HackingLevelMultiplier: bitNodeMults.HackingLevelMultiplier,
      HackingSpeedMultiplier: bitNodeMults.HackingSpeedMultiplier,
      
      // Server
      ServerGrowthRate: bitNodeMults.ServerGrowthRate,
      ServerMaxMoney: bitNodeMults.ServerMaxMoney,
      ServerStartingMoney: bitNodeMults.ServerStartingMoney,
      ServerStartingSecurity: bitNodeMults.ServerStartingSecurity,
      ServerWeakenRate: bitNodeMults.ServerWeakenRate,
      ServerMinSecurityLevel: bitNodeMults.ServerMinSecurityLevel ?? 1,
      
      // Purchased servers
      PurchasedServerCost: bitNodeMults.PurchasedServerCost,
      PurchasedServerSoftcap: bitNodeMults.PurchasedServerSoftcap,
      PurchasedServerLimit: bitNodeMults.PurchasedServerLimit,
      PurchasedServerMaxRam: bitNodeMults.PurchasedServerMaxRam,
      
      // Home computer
      HomeComputerRamCost: bitNodeMults.HomeComputerRamCost,
      
      // Money
      ScriptHackMoney: bitNodeMults.ScriptHackMoney,
      ScriptHackMoneyGain: bitNodeMults.ScriptHackMoneyGain,
      ManualHackMoney: bitNodeMults.ManualHackMoney,
      CrimeMoney: bitNodeMults.CrimeMoney,
      InfiltrationMoney: bitNodeMults.InfiltrationMoney,
      
      // Combat/Crime
      StrengthLevelMultiplier: bitNodeMults.StrengthLevelMultiplier,
      DefenseLevelMultiplier: bitNodeMults.DefenseLevelMultiplier,
      DexterityLevelMultiplier: bitNodeMults.DexterityLevelMultiplier,
      AgilityLevelMultiplier: bitNodeMults.AgilityLevelMultiplier,
      CharismaLevelMultiplier: bitNodeMults.CharismaLevelMultiplier,
      
      // Faction/Company
      FactionWorkExpGain: bitNodeMults.FactionWorkExpGain,
      FactionWorkRepGain: bitNodeMults.FactionWorkRepGain,
      FactionPassiveRepGain: bitNodeMults.FactionPassiveRepGain,
      CompanyWorkExpGain: bitNodeMults.CompanyWorkExpGain,
      CompanyWorkRepGain: bitNodeMults.CompanyWorkRepGain,
      
      // Augmentations
      AugmentationMoneyCost: bitNodeMults.AugmentationMoneyCost,
      AugmentationRepCost: bitNodeMults.AugmentationRepCost,
      
      // Hacknet
      HacknetNodeMoney: bitNodeMults.HacknetNodeMoney,
      
      // Stock
      FourSigmaMarketDataCost: bitNodeMults.FourSigmaMarketDataCost,
      FourSigmaMarketDataApiCost: bitNodeMults.FourSigmaMarketDataApiCost,
      
      // Bladeburner
      BladeburnerRank: bitNodeMults.BladeburnerRank,
      BladeburnerSkillCost: bitNodeMults.BladeburnerSkillCost,
      
      // Gang
      GangSoftcap: bitNodeMults.GangSoftcap,
      GangUniqueAugs: bitNodeMults.GangUniqueAugs,
      
      // Corporation
      CorporationSoftcap: bitNodeMults.CorporationSoftcap,
      CorporationValuation: bitNodeMults.CorporationValuation,
      CorporationDivisions: bitNodeMults.CorporationDivisions,
      
      // World Daemon
      WorldDaemonDifficulty: bitNodeMults.WorldDaemonDifficulty,
      
      // Misc
      CodingContractMoney: bitNodeMults.CodingContractMoney,
      ClassGymExpGain: bitNodeMults.ClassGymExpGain,
      InfiltrationRep: bitNodeMults.InfiltrationRep,
      StaneksGiftPowerMultiplier: bitNodeMults.StaneksGiftPowerMultiplier,
      StaneksGiftExtraSize: bitNodeMults.StaneksGiftExtraSize,
      GoPower: bitNodeMults.GoPower,
    }
  };
  
  ns.write(OUTPUT_FILE, JSON.stringify(data, null, 2), "w");
  
  ns.tprint(`✅ Cached BitNode data to ${OUTPUT_FILE}`);
  ns.tprint(`   BitNode: ${data.resetInfo.currentNode}`);
  ns.tprint(`   Source Files: ${JSON.stringify(data.resetInfo.ownedSF)}`);
  ns.tprint(`   Owned Augs: ${data.resetInfo.ownedAugs.length}`);
}