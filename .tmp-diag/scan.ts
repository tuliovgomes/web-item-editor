import { readFileSync } from "node:fs";
import { AssetProject } from "../src/project/project.js";
const dir = "D:/otserv/rme-crystalserver/1530";
const project = AssetProject.open({ dat: readFileSync(`${dir}/Tibia.dat`), spr: readFileSync(`${dir}/Tibia.spr`) }, { clientVersion: 0 });
const total = project.summary.counts.outfits;
const kinds = new Map<string, number>();
const examples = new Map<string, string>();
let errors = 0;
const started = Date.now();
for (let id = 1; id <= total; id += 1) {
  try {
    const payload = project.prepareObd("outfits", id);
    for (const warning of payload.warnings) {
      const kind = warning.replace(/^outfits \d+( \([^)]*\))?: /, "").replace(/\d+/g, "N").slice(0, 70);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (!examples.has(kind)) examples.set(kind, warning);
    }
    if (id === 128) console.log("outfit 128:", payload.validation, payload.warnings);
  } catch (error) {
    errors += 1;
    if (errors <= 5) console.log("ERRO", id, String(error).slice(0, 200));
  }
}
console.log(`${total} outfits, ${errors} erros, ${Date.now() - started} ms`);
for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(count, "|", examples.get(kind));
