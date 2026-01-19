/** @param {NS} ns */
const DEST_FOLDER = "copied";
const ALLOWED_SUFFIXES = [".js", ".ns", ".script", ".lit", ".txt"];

function isAllowedFile(filename) {
  const lower = filename.toLowerCase();
  return ALLOWED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function buildTraversal(ns) {
  const visited = new Set(["home"]);
  const queue = [{ server: "home", depth: 0, path: ["home"] }];
  const ordered = [];

  while (queue.length > 0) {
    const node = queue.shift();
    ordered.push(node);

    for (const neighbor of ns.scan(node.server)) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push({
        server: neighbor,
        depth: node.depth + 1,
        path: [...node.path, neighbor]
      });
    }
  }

  return ordered;
}

function formatPath(path) {
  return path.join(" -> ");
}

async function copyUniqueFile(ns, host, file) {
  const existingContent = ns.fileExists(file, "home") ? ns.read(file) : null;
  await ns.scp(file, "home", host);

  const destination = `${DEST_FOLDER}/${file}`;
  const moved = ns.mv("home", file, destination);

  if (!moved) {
    ns.print(`    ⚠️ Failed to move ${file} into ${DEST_FOLDER}/`);
    if (existingContent !== null) {
      ns.write(file, existingContent, "w");
    }
    return false;
  }

  if (existingContent !== null) {
    ns.write(file, existingContent, "w");
  }

  ns.print(`    📥 ${file} -> ${destination}`);
  return true;
}

function recordBlocked(blockedMap, server, path, reason) {
  if (!blockedMap.has(server)) {
    blockedMap.set(server, { server, path: [...path], reasons: new Set() });
  }
  blockedMap.get(server).reasons.add(reason);
}

export async function main(ns) {
  ns.disableLog("ALL");
  const traversal = buildTraversal(ns);
  const collected = new Set();
  const blocked = new Map();

  let copiedCount = 0;
  for (const node of traversal) {
    const prefix = node.depth === 0 ? "" : `${"|  ".repeat(node.depth - 1)}|-`;
    ns.print(`${prefix}${node.server} (${formatPath(node.path)})`);

    if (node.server === "home") continue;
    if (!ns.hasRootAccess(node.server)) {
      ns.print(`    ⚠️ Skipping ${node.server} (no root access)`);
      recordBlocked(blocked, node.server, node.path, "no root access");
      continue;
    }

    const files = ns.ls(node.server).filter((file) => !file.startsWith(`${DEST_FOLDER}/`));
    const unsupported = [];
    for (const file of files) {
      if (!isAllowedFile(file)) {
        unsupported.push(file);
        continue;
      }

      if (collected.has(file)) {
        ns.print(`    ↷ ${file} already collected`);
        continue;
      }

      const success = await copyUniqueFile(ns, node.server, file);
      if (success) {
        collected.add(file);
        copiedCount += 1;
        await ns.sleep(1);
      }
    }

    if (unsupported.length > 0) {
      recordBlocked(blocked, node.server, node.path, `unsupported files (${unsupported.join(", ")})`);
      ns.print(`    ⚠️ ${unsupported.length} unsupported file(s) cannot be copied`);
    }
  }

  ns.tprint(`Scan complete. Servers visited: ${traversal.length}. Unique files copied: ${copiedCount}.`);
  if (blocked.size > 0) {
    ns.tprint("Manual follow-up required:");
    for (const entry of blocked.values()) {
      const reasons = Array.from(entry.reasons).join("; ");
      ns.tprint(`  - ${entry.server} via ${formatPath(entry.path)} (${reasons})`);
    }
  }
}
