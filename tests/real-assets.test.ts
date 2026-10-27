import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SpriteCatalog } from "../src/formats/catalog.js";
import { buildModernObdPayload, compressObd, decodeObd } from "../src/formats/obd.js";
import { AssetProject } from "../src/project/project.js";

/*
 * Checks against real client files when they are on this machine (skipped otherwise, e.g. in Docker).
 * Override the locations with OTEDITOR_LEGACY_DIR (Tibia.dat + Tibia.spr) and OTEDITOR_CATALOG_DIR
 * (catalog-content.json + appearances + sprite sheets).
 */
const LEGACY_DIR = process.env["OTEDITOR_LEGACY_DIR"] ?? "D:/otserv/rme-crystalserver/1530";
const CATALOG_DIR = process.env["OTEDITOR_CATALOG_DIR"] ?? "D:/otserv/CrystalOTC-windows/data/things/1530";
const hasLegacy = existsSync(join(LEGACY_DIR, "Tibia.dat")) && existsSync(join(LEGACY_DIR, "Tibia.spr"));
const hasCatalog = existsSync(join(CATALOG_DIR, "catalog-content.json"));

test("real DAT/SPR: every outfit keeps all groups, directions and frames through OBD export and import", { skip: !hasLegacy && `sem ${LEGACY_DIR}` }, () => {
  const project = AssetProject.open({ dat: readFileSync(join(LEGACY_DIR, "Tibia.dat")), spr: readFileSync(join(LEGACY_DIR, "Tibia.spr")) }, { clientVersion: 0 });
  const { counts, sprites } = project.summary;
  const outfits = project.list("outfits", 0, counts.outfits);
  let groups = 0;
  for (const outfit of outfits) {
    for (const group of outfit.groups) {
      groups += 1;
      assert.equal(group.spriteIds.length, group.width * group.height * group.layers * group.patternX * group.patternY * group.patternZ * group.frames);
      assert.ok(group.spriteIds.every((id) => id <= sprites.spriteCount), `outfit ${outfit.id} points past the SPR`);
    }
  }
  assert.ok(groups > outfits.length, "outfits have idle and walking groups");

  const target = AssetProject.create(1, { clientVersion: project.summary.clientVersion });
  for (const id of [128, 136]) {
    const source = outfits.find((outfit) => outfit.id === id)!;
    assert.ok(source.groups.length > 1);
    const file = project.exportObd("outfits", id).data;
    assert.equal(decodeObd(file).groups.length, source.groups.length);
    const imported = target.importObd(file);
    const copy = target.list("outfits", imported.id - 1, 1)[0]!;
    assert.deepEqual(copy.groups.map((group) => [group.type, group.frames, group.patternX, group.patternY, group.patternZ, group.layers]),
      source.groups.map((group) => [group.type, group.frames, group.patternX, group.patternY, group.patternZ, group.layers]));
    source.groups.forEach((group, groupIndex) => group.spriteIds.forEach((spriteId, slot) => {
      const copied = copy.groups[groupIndex]!.spriteIds[slot]!;
      const original = project.getSprite(spriteId)!;
      if (copied === 0) assert.ok(original.every((byte, offset) => offset % 4 !== 3 || byte === 0), "only empty sprites are dropped");
      else assert.deepEqual(target.getSprite(copied), original);
    }));
  }
});

test("real catalog: outfits keep idle and walking groups and their sprites decode", { skip: !hasCatalog && `sem ${CATALOG_DIR}` }, () => {
  const catalog = new SpriteCatalog(readFileSync(join(CATALOG_DIR, "catalog-content.json"), "utf8"));
  catalog.loadAppearances(readFileSync(join(CATALOG_DIR, catalog.appearancesFile!)));
  const entries = JSON.parse(readFileSync(join(CATALOG_DIR, "catalog-content.json"), "utf8")) as { type: string; file: string; firstspriteid: number; lastspriteid: number }[];
  const outfits = catalog.appearances!.list("outfits");
  for (const outfit of outfits) {
    for (const group of outfit.groups) {
      assert.equal(group.spriteIds.length, group.layers * group.patternX * group.patternY * group.patternZ * group.frames, `outfit ${outfit.id}`);
    }
  }
  const outfit = catalog.appearances!.get("outfits", 128)!;
  const ids = outfit.groups.flatMap((group) => group.spriteIds);
  for (const entry of entries) {
    if (entry.type === "sprite" && ids.some((id) => id >= entry.firstspriteid && id <= entry.lastspriteid)) {
      catalog.addSheet(entry.file, readFileSync(join(CATALOG_DIR, entry.file)));
    }
  }
  for (const id of ids) assert.ok(catalog.getSprite(id), `sprite ${id} decodes`);

  const payload = buildModernObdPayload({ appearance: outfit, clientVersion: 1530, getSprite: (id) => catalog.getSprite(id) });
  const decoded = decodeObd(compressObd(payload.raw));
  const sorted = [...outfit.groups].sort((a, b) => a.fixedFrameGroup - b.fixedFrameGroup);
  assert.deepEqual(decoded.groups.map((group) => [group.frames, group.patternX, group.patternY, group.patternZ, group.layers]),
    sorted.map((group) => [group.frames, group.patternX, group.patternY, group.patternZ, group.layers]));
  // Walking group, last frame, direction west: the OBD cells reassemble into the catalog sprite.
  const walking = sorted[1]!;
  const slot = ((walking.frames - 1) * walking.patternZ * walking.patternY * walking.patternX + 3) * walking.layers;
  const sprite = catalog.getSprite(walking.spriteIds[slot]!)!;
  const { width, height } = decoded.groups[1]!;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const cellId = decoded.groups[1]!.spriteIds[slot * width * height + row * width + column]!;
      const cell = cellId === 0 ? Buffer.alloc(4096) : decoded.sprites.get(cellId)!;
      const left = (width - 1 - column) * 32;
      const top = (height - 1 - row) * 32;
      for (let y = 0; y < 32; y += 1) {
        const expected = sprite.rgba.subarray(((top + y) * sprite.width + left) * 4, ((top + y) * sprite.width + left + 32) * 4);
        const actual = cell.subarray(y * 128, y * 128 + 128);
        if (cellId === 0) assert.ok(expected.every((byte, offset) => offset % 4 !== 3 || byte === 0));
        else assert.deepEqual(actual, expected);
      }
    }
  }
});
