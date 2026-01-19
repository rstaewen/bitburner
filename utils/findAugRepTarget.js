const KEY_AUGS = ["Cranial Signal Processors - Gen I", "Cranial Signal Processors - Gen II", //Cybersec
"Embedded Netburner Module", "Cranial Signal Processors - Gen III", "CRTX42-AA Gene Modification", //Nitesec
"The Black Hand", //Black hand
"Social Negotiation Assistant (S.N.A)", //Tian Di Hua ex - faction rep gain! only 6.5k
"SmartSonar Implant", //Slum snakes ex
"PCMatrix", //Aevum ex
"INFRARET Enhancement", //Ishima ex
"NutriGen Implant", //NeoTokyo ex
"Neuregen Gene Modification", //Chongqing ex
"DermaForce Particle Barrier", //Volhaven ex
"BrachiBlades", //Syndicate ex
"Bionic Legs", "Bionic Arms", //(Bionic legs and arms are prerequisites for end stage augs)
"Cranial Signal Processors - Gen V", //BitRunners exclusive
"Artificial Bio-neural Network Implant", //medium hack skill, hack power speed etc. Not great for sleeves but it's only 25k more than Gen V above - easy pickup
"OmniTek InfoLoad", //+25% hacking skill/xp OmniTek
"Xanipher", //+20% all skills
"SmartJaw", //+50% charisma skill, xp, +25% factions & companies (high priority)
"Enhanced Social Interaction Implant", //+60% cha stuff (4sigma)
"CordiARC Fusion Reactor", //+35% all combat skills, +35% combat xp, pretty great!
"Graphene BrachiBlades Upgrade", //upgrades for life of crime
"Graphene Bionic Spine Upgrade", //+60% all combat skills, freakin awesome for sleeves
"Graphene Bionic Arms Upgrade",
"Graphene Bionic Legs Upgrade",
"Graphene Bone Lacings",
"SPTN-97 Gene Modification", //+75% all combat skills, +15% for hacking, even more awesome! (covenant ex)
"PC Direct-Neural Interface", //+30% rep, prereq for following two
"PC Direct-Neural Interface Optimization Submodule", //+75% rep from companies
"PC Direct-Neural Interface NeuroNet Injector", //+100% rep from companies, essential for unlocking more factions
"Neotra", //+55% STR, DEX
"Hydroflame Left Arm", //+180% STR, last priority hopefully
"nextSENS Gene Modification", //+20% all skills clarke ex
"Photosynthetic Cells", //KG ex, +40% to 3 combat skills
"The Red Pill" //obviously!!!
]

const KEY_GRAFTS = [
  "BitRunners Neurolink", //Exclusive to bitrunners, needs 875k rep (3x nearest neighbor) and doesn't benefit sleeves much, does hack grow power stuff
  "QLink", //Illuminati ultimate hacking - 50% hack skill but mostly in non-sleeve stuff. 7.5t
  "violet Congruity Implant", // of course - removes penalties which by the end of the graft list means +(2*x)% to all stats
  "Embedded Netburner Module Direct Memory Access Upgrade", //only hack power and chance
  "Embedded Netburner Module Analyze Engine", //10% faster grow, weaken, hack - no sleeve
  "ECorp HVMind Implant", //+some confusing ridiculous pct to grow power (3x)
]

/** @param {NS} ns */
export async function main(ns) {
  ns.print("What does Hivemind do?:", ns.singularity.getAugmentationStats("ECorp HVMind Implant"));
  const forSleeves = ns.args[0];
  const targets = getTargets(ns, forSleeves);
  ns.ui.openTail();
  ns.print("TARGETS: ")
  for (let i = 0; i< targets.length; i++) {
    const target = targets[i];
    ns.print(`Target Aug: ${target.name}`);
    ns.print(`Rep Required: ${target.repReq}`);
    ns.print(`Available from: ${target.factions.join(', ')}`);
  }
  return targets;
}

/** @param {NS} ns 
 * @param {Boolean} forSleeves
*/
export function getTargets(ns, forSleeves) {

  let ownedAugs, purchasableAugs;
  let allFactions = Object.values(ns.enums.FactionName); // or however you get faction names
  // Get all factions you've joined (have rep with)
  const factionsJoined = allFactions.filter(faction => ns.singularity.getFactionRep(faction) > 0);

  if (forSleeves === true) {
    // assume all sleeves have same augs as sleeve 0, since we upgrade them all at once
    // warning - that means dont upgrade them manually!
    ownedAugs = ns.sleeve.getSleeveAugmentations(0);
  } else {
    ownedAugs = ns.singularity.getOwnedAugmentations(true);
  }
  
  // Get all augs from those factions
  const targetAugs = factionsJoined.flatMap(name => ns.singularity.getAugmentationsFromFaction(name));
  
  // Remove duplicates and filter out owned augs
  const uniqueTargetAugs = [...new Set(targetAugs)];
  purchasableAugs = uniqueTargetAugs.filter(aug => !ownedAugs.includes(aug));

  const purchasableKeyAugs = purchasableAugs.filter(augName => KEY_AUGS.includes(augName));

  let selectedAugs = [];
  if (purchasableKeyAugs.length === 0) {
    selectedAugs = purchasableAugs;
  } else {
    selectedAugs = purchasableKeyAugs;
  }

  // Now find cheapest (in remaining rep required) aug from purchasableAugs
  // You'll need to get aug info to find prices and rep requirements
  const augDetails = selectedAugs.map(augName => {
    const repReq = ns.singularity.getAugmentationRepReq(augName);
    const price = ns.singularity.getAugmentationPrice(augName);
    
    // Find which faction(s) offer this aug
    const offeringFactions = factionsJoined.filter(faction => 
      ns.singularity.getAugmentationsFromFaction(faction).includes(augName)
    );

    if (offeringFactions.length == 0) {
      return null;
    }

    // need to find the faction that requires the least ADDITIONAL rep in order to purchase the aug
    // But first, check if ANY faction already has enough rep - if so, skip this aug
    const alreadyAcquirable = offeringFactions.some(faction => {
      const currentRep = ns.singularity.getFactionRep(faction);
      return currentRep >= repReq;
    });

    if (alreadyAcquirable) {
      return null;
    }

    // reduce function should find the faction that offers this aug with the least amount of additional rep required
    const minRepReqFaction = offeringFactions.reduce((best, faction) => {
      const currentRep = ns.singularity.getFactionRep(faction);
      const repNeeded = repReq - currentRep;
      
      if (!best || repNeeded < best.repNeeded) {
        return { faction: faction, repNeeded: repNeeded };
      }
      return best;
    }, null);

    if (minRepReqFaction === null) {
      return null;
    }
    
    return {
      name: augName,
      repReq: repReq,
      price: price,
      factions: offeringFactions,
      minRepReqFaction: minRepReqFaction.faction,
      additionalRepNeeded: minRepReqFaction.repNeeded
    };
  });

  // Sort by additional rep needed (ascending - least rep needed first)
  return augDetails.filter(ad => ad !== null).sort((a, b) => a.additionalRepNeeded - b.additionalRepNeeded);
}