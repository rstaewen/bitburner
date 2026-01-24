export const ORCHESTRATOR_INFO_FILE = "/data/orchestrator-info.json";

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
  const info = readOrchestratorInfo(ns);
  if (!info) return false;

  return (
    info.saturated &&
    info.shareThreads > info.totalThreads * 0.3
  );
}
