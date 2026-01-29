/** @param {NS} ns */
export async function main(ns) {
  ns.ui.openTail();
  
    const candidates = [
    // Endgame ($10T+ potential)
    { server: "ecorp", reqLevel: 1350, priority: 1 },
    { server: "megacorp", reqLevel: 1300, priority: 2 },
    { server: "4sigma", reqLevel: 1200, priority: 3 },
    { server: "b-and-a", reqLevel: 1100, priority: 4 },
    { server: "kuai-gong", reqLevel: 1250, priority: 5 },
    { server: "nwo", reqLevel: 1200, priority: 6 },
    { server: "clarkinc", reqLevel: 1200, priority: 7 },
    { server: "blade", reqLevel: 1150, priority: 8 },
    { server: "omnitek", reqLevel: 1100, priority: 9 },
    
    // Late game
    { server: "alpha-ent", reqLevel: 600, priority: 10 },
    { server: "rho-construction", reqLevel: 650, priority: 11 },
    { server: "global-pharm", reqLevel: 750, priority: 12 },
    { server: "zb-institute", reqLevel: 725, priority: 13 },
    
    // Mid game
    { server: "the-hub", reqLevel: 275, priority: 14 },
    { server: "catalyst", reqLevel: 400, priority: 15 },
    { server: "computek", reqLevel: 300, priority: 16 },
    { server: "omega-net", reqLevel: 187, priority: 17 },
    
    // Early-mid (fallback - these have lower max money but are reachable)
    { server: "phantasy", reqLevel: 100, priority: 18 },
    { server: "silver-helix", reqLevel: 150, priority: 19 },
    { server: "max-hardware", reqLevel: 80, priority: 20 },
    { server: "joesguns", reqLevel: 10, priority: 21 },
    // n00dles explicitly excluded - too low max money
  ];
  for (const candidate of candidates) {
    ns.print(`${candidate.server} - ${candidate.reqLevel} (${candidate.priority})`);
  }
}