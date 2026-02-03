export const ORCHESTRATOR_INFO_FILE = "/data/orchestrator-info.json";
import {
  isInBitNode
} from "utils/bitnode-cache.js";

/**
 * Read orchestrator info from shared file
 * @param {NS} ns
 * @returns {{
 *   shareRatio: number,
 *   shareThreads: number,
 *   totalThreads: number,
 *   saturated: boolean,
 *   timestamp: number
 * } | null}
 */
export function readOrchestratorInfo(ns) {
  try {
    const fileMissing = !ns.fileExists(ORCHESTRATOR_INFO_FILE);
    if (fileMissing) return null;

    const info = JSON.parse(ns.read(ORCHESTRATOR_INFO_FILE));

    // stale guard
    if (Date.now() - info.timestamp > 2 * 60 * 1000) return null;

    return info;
  } catch {
    return null;
  }
}

/**
 * True if adding RAM is currently wasteful
 * @param {NS} ns
 * @returns {boolean}
 */
export function isRamSaturated(ns) {
  // just return 'saturated' in bitnode 9, actually saturating here in BN9 properly is almost impossible
  // we can only get RAM on home. extra servers can't be bought. extra RAM on home is also 5x more expensive because reasons
  // we can't just gate untils saturated in bitnode 9
  if (isInBitNode(ns, 9)) return true;
  const info = readOrchestratorInfo(ns);
  if (!info) return false;

  return (
    info.saturated &&
    info.shareThreads > info.totalThreads * 0.3
  );
}
