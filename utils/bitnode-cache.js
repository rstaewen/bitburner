/** @param {NS} ns */

/**
 * utils/bitnode-cache.js - Read cached BitNode multipliers and reset info (0 GB RAM cost!)
 * 
 * Requires cache-bitnode-mults.js to have been run first (typically from start.js)
 * 
 * Saves:
 *   - ns.getBitNodeMultipliers() - 4 GB
 *   - ns.getResetInfo() - 1 GB
 */

const CACHE_FILE = "/data/bitnode-cache.json";

/**
 * @typedef {Object} ResetInfoCache
 * @property {number} currentNode
 * @property {Object<string, number>} ownedSF
 * @property {string[]} ownedAugs
 * @property {number} lastAugReset
 * @property {number} lastNodeReset
 */

/**
 * @typedef {Object} BitNodeCache
 * @property {number} cachedAt
 * @property {ResetInfoCache} resetInfo
 * @property {Object} multipliers
 */

/**
 * Read the cached bitnode data
 * @param {NS} ns
 * @returns {BitNodeCache | null}
 */
export function getBitNodeCache(ns) {
  try {
    if (!ns.fileExists(CACHE_FILE)) {
      return null;
    }
    const data = ns.read(CACHE_FILE);
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Get the cached reset info (saves 1 GB vs ns.getResetInfo())
 * @param {NS} ns
 * @returns {ResetInfoCache | null}
 */
export function getResetInfo(ns) {
  const cache = getBitNodeCache(ns);
  return cache?.resetInfo ?? null;
}

/**
 * Get a specific multiplier from the cache
 * @param {NS} ns
 * @param {string} key - The multiplier key (e.g., "HackExpGain")
 * @param {number} defaultValue - Default if cache missing
 * @returns {number}
 */
export function getMultiplier(ns, key, defaultValue = 1) {
  const cache = getBitNodeCache(ns);
  return cache?.multipliers?.[key] ?? defaultValue;
}

/**
 * Get the current bitnode number from cache
 * @param {NS} ns
 * @returns {number}
 */
export function getCurrentNode(ns) {
  const cache = getBitNodeCache(ns);
  return cache?.resetInfo?.currentNode ?? 1;
}

/**
 * Get a source file level from cache
 * @param {NS} ns
 * @param {number} sfNumber - Source file number (e.g., 4 for SF4)
 * @returns {number}
 */
export function getSourceFileLevel(ns, sfNumber) {
  const cache = getBitNodeCache(ns);
  const ownedSF = cache?.resetInfo?.ownedSF;
  return ownedSF?.[sfNumber] ?? ownedSF?.[String(sfNumber)] ?? 0;
}

/**
 * Get list of owned augmentations from cache
 * @param {NS} ns
 * @returns {string[]}
 */
export function getOwnedAugs(ns) {
  const cache = getBitNodeCache(ns);
  return cache?.resetInfo?.ownedAugs ?? [];
}

/**
 * Check if a specific augmentation is owned
 * @param {NS} ns
 * @param {string} augName
 * @returns {boolean}
 */
export function hasAug(ns, augName) {
  return getOwnedAugs(ns).includes(augName);
}

/**
 * Get timestamp of last augmentation reset
 * @param {NS} ns
 * @returns {number}
 */
export function getLastAugReset(ns) {
  const cache = getBitNodeCache(ns);
  return cache?.resetInfo?.lastAugReset ?? 0;
}

/**
 * Get timestamp of last bitnode reset
 * @param {NS} ns
 * @returns {number}
 */
export function getLastNodeReset(ns) {
  const cache = getBitNodeCache(ns);
  return cache?.resetInfo?.lastNodeReset ?? 0;
}

/**
 * Get time since last aug reset in milliseconds
 * @param {NS} ns
 * @returns {number}
 */
export function getTimeSinceAugReset(ns) {
  const lastReset = getLastAugReset(ns);
  return lastReset > 0 ? Date.now() - lastReset : 0;
}

/**
 * Check if we're in a specific bitnode
 * @param {NS} ns
 * @param {number} nodeNumber
 * @returns {boolean}
 */
export function isInBitNode(ns, nodeNumber) {
  return getCurrentNode(ns) === nodeNumber;
}

/**
 * Check if the cache exists and is valid
 * @param {NS} ns
 * @returns {boolean}
 */
export function isCacheValid(ns) {
  const cache = getBitNodeCache(ns);
  return cache !== null && cache.cachedAt > 0;
}