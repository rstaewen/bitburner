/** @param {NS} ns */
export async function main(ns) {
  const GITHUB_USER = "rstaewen";
  const REPO = "bitburner";
  const BRANCH = "main";
  
  const files = [
    "orchestrator.js",
    "hack.js",
    "hack-clean.js",
    "grow.js",
    "weaken.js",
    "utils/scanner.js",
    "utils/nuker.js"
    // Add all your files here
  ];
  
  const baseUrl = `https://raw.githubusercontent.com/${GITHUB_USER}/${REPO}/${BRANCH}`;
  
  for (const file of files) {
    const url = `${baseUrl}/${file}`;
    ns.tprint(`Downloading ${file}...`);
    const success = await ns.wget(url, file);
    if (success) {
      ns.tprint(`✓ ${file}`);
    } else {
      ns.tprint(`✗ Failed: ${file}`);
    }
  }
  
  ns.tprint("Download complete!");
}