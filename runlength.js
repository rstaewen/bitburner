/** @param {NS} ns */
export async function main(ns) {
  ns.ui.openTail();
  const input = ns.args[0]
  let array = "";
  let current = input.at(0);
  let l = 1;
  for(let i=1; i< input.length; i++) {
    if (input.at(i) == current && l < 9) {
      l++;
    } else {
      array += `${l}${current}`
      l=1;
      current = input.at(i);
    }
  }
  current = input.at(input.length - 1);
  array += `${l}${current}`
  ns.print(array);
}