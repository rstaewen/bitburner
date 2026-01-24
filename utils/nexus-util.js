export function getNexusDefaultName(ns) {
  const node = ns.getResetInfo().currentNode;

  if (node !== 9) {
    return "nexus";
  }

  return "hacknet-server";
}

/**
 * Returns the hostname that should be treated as "nexus"
 * - Normal nodes: purchased server named "nexus"
 * - BN9: a suitable hacknet server
 *
 * @param {NS} ns
 * @param {number} minRam minimum RAM required
 * @returns {string|null}
 */
export function getNexusHost(ns, minRam = 1) {
  const node = ns.getResetInfo().currentNode;

  // ─────────────────────────────
  // Normal BitNodes
  // ─────────────────────────────
  if (node !== 9) {
    if (ns.serverExists("nexus")) return "nexus";
    if (ns.serverExists("nexus-0")) return "nexus-0";
    return null;
  }

  // ─────────────────────────────
  // BitNode 9: hacknet-backed nexus
  // ─────────────────────────────
  return selectHacknetNexus(ns, minRam);
}

/**
 * Selects the best hacknet server to act as nexus
 * Strategy:
 *  - must have >= minRam
 *  - prefer unused RAM
 *  - prefer largest RAM
 *
 * @param {NS} ns
 * @param {number} minRam
 * @returns {string|null}
 */
function selectHacknetNexus(ns, minRam) {
  const count = ns.hacknet.numNodes();
  let best = null;
  let bestScore = -1;

  for (let i = 0; i < count; i++) {
    const host = `hacknet-server-${i}`;
    const max = ns.getServerMaxRam(host);
    const used = ns.getServerUsedRam(host);

    if (max < minRam) continue;

    // Hard preference: empty nodes
    const score = (used === 0 ? 1_000_000 : 0) + max - used;

    if (score > bestScore) {
      bestScore = score;
      best = host;
    }
  }

  return best;
}
