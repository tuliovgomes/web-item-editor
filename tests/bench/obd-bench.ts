import { Buffer } from "node:buffer";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { compressObd } from "../../src/formats/obd.js";
import { ObdWorkerPool } from "../../src/project/obd-pool.js";
import { AssetProject } from "../../src/project/project.js";

function read(path: string): Buffer {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  const buffer = Buffer.allocUnsafe(size);
  for (let offset = 0; offset < size;) offset += readSync(fd, buffer, offset, Math.min(size - offset, 1 << 26), offset);
  closeSync(fd);
  return buffer;
}

const dir = process.argv[2] ?? "/assets";
const project = AssetProject.open(
  { dat: read(`${dir}/Tibia.dat`), spr: read(`${dir}/Tibia.spr`), otfi: read(`${dir}/Tibia.otfi`) },
  { clientVersion: 0 },
);
const ms = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;
const all = project.list("outfits", 0, 5000).map((record) => ({
  id: record.id,
  sprites: record.groups[0]?.spriteIds.length ?? 0,
}));
all.sort((a, b) => a.sprites - b.sprites);
const pick = (fraction: number) => all[Math.min(all.length - 1, Math.floor(all.length * fraction))]!;
type Item = { id: number; sprites: number };
const scenarios: [string, Item[]][] = [
  ["pequeno (p10)", [pick(0.1)]],
  ["mediano (p50)", [pick(0.5)]],
  ["complexo (máx)", [all.at(-1)!]],
  ["lote 36 (p50..p90)", all.slice(Math.floor(all.length * 0.5), Math.floor(all.length * 0.5) + 36)],
];

async function main(): Promise<void> {
for (const [label, items] of scenarios) {
  const sprites = items.reduce((sum, item) => sum + item.sprites, 0);
  const row: Record<string, number | string> = { cenario: label, outfits: items.length, sprites };
  for (const level of [5, 1]) {
    let prepare = 0;
    let compress = 0;
    let bytes = 0;
    const start = process.hrtime.bigint();
    for (const item of items) {
      const t0 = process.hrtime.bigint();
      const payload = project.prepareObd("outfits", item.id);
      prepare += ms(t0);
      const t1 = process.hrtime.bigint();
      bytes += compressObd(payload.raw, level).length;
      compress += ms(t1);
    }
    row[`nivel${level}_total_ms`] = Math.round(ms(start));
    row[`nivel${level}_prepara_ms`] = Math.round(prepare);
    row[`nivel${level}_lzma_ms`] = Math.round(compress);
    row[`nivel${level}_bytes`] = bytes;
  }
  for (const size of [4]) {
    const pool = new ObdWorkerPool(size);
    const start = process.hrtime.bigint();
    let bytes = 0;
    await Promise.all(
      items.map(async (item) => {
        const payload = project.prepareObd("outfits", item.id);
        const packed = await pool.compress(payload.raw);
        bytes += packed.length;
      }),
    );
    row[`pool${size}_total_ms`] = Math.round(ms(start));
    row[`pool${size}_bytes`] = bytes;
    await pool.close();
  }
  console.log(JSON.stringify(row));
}
console.log(JSON.stringify({ rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
}

void main();
