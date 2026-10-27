import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { compress } from "lzma";
import { AppearanceLibrary, type Appearance } from "../src/formats/appearances.js";
import { SpriteCatalog, decodeSheet, parseCatalogContent } from "../src/formats/catalog.js";
import type { DatRecordView } from "../src/formats/dat.js";
import { OBD_VERSION_2, OBD_VERSION_3, buildModernObdPayload, buildObdPayload, compressObd, decodeObd } from "../src/formats/obd.js";
import { AssetProject } from "../src/project/project.js";

/** Opaque 32×32 sprite whose every pixel encodes `id` (so any mix-up of sprites is visible). */
function pixels(id: number): Buffer {
  const rgba = Buffer.alloc(32 * 32 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([id & 0xff, (id >> 8) & 0xff, 7, 255], offset);
  return rgba;
}

/**
 * Outfit like the real 10.57+ ones: an idle group (1 frame) and a walking group (8 frames with durations),
 * 4 directions, 2 layers (layer 1 = color mask) and 2×2 tiles, every slot pointing to a distinct sprite.
 */
function outfitRecord(): DatRecordView {
  let next = 1;
  const group = (type: number, frames: number) => {
    const count = 2 * 2 * 2 * 4 * 1 * 1 * frames;
    const animationData = frames > 1 ? Buffer.alloc(6 + frames * 8) : Buffer.alloc(0);
    if (frames > 1) {
      animationData.writeUInt8(1, 0);
      animationData.writeInt32LE(0, 1);
      animationData.writeInt8(0, 5);
      for (let frame = 0; frame < frames; frame += 1) {
        animationData.writeUInt32LE(100 + frame, 6 + frame * 8);
        animationData.writeUInt32LE(200 + frame, 10 + frame * 8);
      }
    }
    return {
      type, width: 2, height: 2, exactSize: 64, layers: 2, patternX: 4, patternY: 1, patternZ: 1, frames,
      spriteIds: Array.from({ length: count }, () => next++), animationData,
    };
  };
  return { id: 7, category: "outfits", flags: [], properties: {}, groups: [group(0, 1), group(1, 8)] };
}

test("exports idle and walking outfit groups as OBD v3, with the byte layout Object Builder reads", () => {
  const record = outfitRecord();
  const payload = buildObdPayload({ record, clientVersion: 1098, spriteSize: 32, getSprite: pixels });
  assert.deepEqual(payload.warnings, [], "no frame group is dropped any more");
  const raw = payload.raw;
  assert.equal(raw.readUInt16LE(0), OBD_VERSION_3);
  assert.equal(raw.readUInt16LE(2), 1098);
  assert.equal(raw[4], 2, "outfit category");
  const patterns = raw.readUInt32LE(5);
  assert.equal(raw[patterns - 1], 0xff, "properties end right before the texture patterns");
  assert.equal(raw[patterns], 2, "group count");
  assert.equal(raw[patterns + 1], 0, "idle group type");
  // idle: w h exact layers x y z frames (no animation block for 1 frame), then 32 sprites of id+length+pixels
  assert.deepEqual([...raw.subarray(patterns + 2, patterns + 10)], [2, 2, 64, 2, 4, 1, 1, 1]);
  const firstSprite = patterns + 10;
  assert.equal(raw.readUInt32LE(firstSprite), 1);
  assert.equal(raw.readUInt32LE(firstSprite + 4), 4096, "v3 stores each sprite's pixel length");
  const walking = firstSprite + 32 * (8 + 4096);
  assert.equal(raw[walking], 1, "walking group type");
  assert.equal(raw[walking + 8], 8, "walking frames");
  assert.equal(raw.readUInt32LE(walking + 9 + 6), 100, "first frame minimum duration");

  const decoded = decodeObd(compressObd(raw));
  assert.equal(decoded.obdVersion, OBD_VERSION_3);
  assert.equal(decoded.groups.length, 2);
  assert.deepEqual(decoded.groups.map((group) => [group.type, group.frames, group.spriteIds.length]), [[0, 1, 32], [1, 8, 256]]);
  assert.deepEqual(decoded.groups[1]!.animation?.durations[7], [107, 207]);
  assert.equal(decoded.sprites.size, 288, "every distinct sprite of both groups");
  for (const group of decoded.groups) {
    for (const id of group.spriteIds) assert.deepEqual(decoded.sprites.get(id), pixels(id));
  }
});

test("keeps single-group objects in OBD v2", () => {
  const record = outfitRecord();
  const single = { ...record, groups: [record.groups[1]!] };
  const payload = buildObdPayload({ record: single, clientVersion: 860, spriteSize: 32, getSprite: pixels });
  assert.equal(payload.raw.readUInt16LE(0), OBD_VERSION_2);
  const decoded = decodeObd(compressObd(payload.raw));
  assert.equal(decoded.groups.length, 1);
  assert.equal(decoded.group.frames, 8);
});

test("imports both outfit groups into a 10.57+ project and the walking group into an older one", () => {
  const file = compressObd(buildObdPayload({ record: outfitRecord(), clientVersion: 1098, spriteSize: 32, getSprite: pixels }).raw);

  const modern = AssetProject.create(1, { clientVersion: 1098 });
  const imported = modern.importObd(file);
  assert.deepEqual(imported.warnings.filter((warning) => /grupo/.test(warning)), []);
  assert.equal(imported.addedSprites, 288);
  const compiled = modern.compile();
  const reopened = AssetProject.open({ dat: compiled[0]!.data, spr: compiled[1]!.data, otfi: compiled[2]!.data }, { clientVersion: 1098 });
  const outfit = reopened.list("outfits", imported.id - 1, 1)[0]!;
  assert.deepEqual(outfit.groups.map((group) => [group.type, group.frames, group.patternX, group.layers]), [[0, 1, 4, 2], [1, 8, 4, 2]]);
  const durations = outfit.groups[1]!.animationData;
  assert.equal(durations.readUInt32LE(6 + 7 * 8), 107);
  // Every slot still shows the pixels of the sprite it pointed to in the source record.
  const source = outfitRecord();
  outfit.groups.forEach((group, groupIndex) => group.spriteIds.forEach((spriteId, slot) => {
    assert.deepEqual(reopened.getSprite(spriteId), pixels(source.groups[groupIndex]!.spriteIds[slot]!));
  }));

  const legacy = AssetProject.create(1, { clientVersion: 860 });
  const old = legacy.importObd(file);
  assert.ok(old.warnings.some((warning) => /grupo andando/.test(warning)));
  assert.equal(old.addedSprites, 256, "only the walking group's sprites are added");
  const oldOutfit = legacy.list("outfits", old.id - 1, 1)[0]!;
  assert.equal(oldOutfit.groups.length, 1);
  assert.equal(oldOutfit.groups[0]!.frames, 8);
});

// --- modern appearances (catalog `.bmp.lzma` + appearances.dat) ---

function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return bytes;
}
const num = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const msg = (field: number, ...parts: number[][]) => { const body = parts.flat(); return [...varint(field * 8 + 2), ...varint(body.length), ...body]; };

function modernOutfit(): Appearance {
  let next = 1000;
  const group = (fixed: number, frames: number) => {
    const ids = Array.from({ length: 1 * 4 * 1 * 1 * frames }, () => num(5, next++));
    const phases = Array.from({ length: frames }, (_, frame) => msg(6, num(1, 50 + frame), num(2, 60 + frame)));
    const info = msg(3, num(1, 4), num(2, 1), num(3, 1), num(4, 1), ...ids, ...(frames > 1 ? [msg(6, num(4, 0), ...phases)] : []));
    return msg(2, num(1, fixed), info);
  };
  // Stored walking-first on purpose: the export must still put idle first (Object Builder reads groups by position).
  const appearances = Buffer.from(msg(2, num(1, 128), group(1, 8), group(0, 1)));
  return AppearanceLibrary.parse(appearances).get("outfits", 128)!;
}

test("exports a modern outfit with idle and walking groups, cutting 64px sprites into cells", () => {
  const appearance = modernOutfit();
  assert.deepEqual(appearance.groups.map((group) => [group.fixedFrameGroup, group.frames]), [[1, 8], [0, 1]]);
  const sprite = (id: number) => {
    const rgba = Buffer.alloc(64 * 64 * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([id & 0xff, id >> 8, (offset / 4) % 64 < 32 ? 1 : 2, 255], offset);
    return { width: 64, height: 64, rgba };
  };
  const payload = buildModernObdPayload({ appearance, clientVersion: 1530, getSprite: sprite });
  assert.deepEqual(payload.warnings, []);
  assert.equal(payload.spriteCount, (4 + 32) * 4);
  const decoded = decodeObd(compressObd(payload.raw));
  assert.equal(decoded.obdVersion, OBD_VERSION_3);
  assert.deepEqual(decoded.groups.map((group) => [group.frames, group.width, group.height, group.spriteIds.length]), [[1, 2, 2, 16], [8, 2, 2, 128]]);
  assert.deepEqual(decoded.groups[1]!.animation?.durations.slice(0, 2), [[50, 60], [51, 61]]);
  // Walking group, frame 0, direction south (x = 2): source sprite 1000 + 2; its four cells keep its pixels,
  // cell column 0 (right half of the image, blue 2) first.
  const walking = decoded.groups[1]!;
  const cells = walking.spriteIds.slice(2 * 4, 2 * 4 + 4).map((id) => decoded.sprites.get(id)!);
  for (const cell of cells) assert.deepEqual([cell[0], cell[1]], [(1002) & 0xff, 1002 >> 8]);
  assert.deepEqual(cells.map((cell) => cell[2]), [2, 1, 2, 1]);
});

test("accepts the extended sheet layouts of 15.x catalogs (e.g. 96×96 and 128×128 sprites)", () => {
  const { sheets } = parseCatalogContent(JSON.stringify([
    { type: "sprite", file: "a.bmp.lzma", spritetype: 3, firstspriteid: 1, lastspriteid: 36 },
    { type: "sprite", file: "b.bmp.lzma", spritetype: 14, firstspriteid: 37, lastspriteid: 52 },
    { type: "sprite", file: "c.bmp.lzma", spritetype: 21, firstspriteid: 53, lastspriteid: 61 },
    { type: "sprite", file: "d.bmp.lzma", spritetype: 35, firstspriteid: 62, lastspriteid: 62 },
  ]));
  assert.deepEqual(sheets.map((sheet) => [sheet.width, sheet.height]), [[64, 64], [96, 96], [128, 128], [384, 384]]);
  assert.throws(() => parseCatalogContent(JSON.stringify([{ type: "sprite", file: "x", spritetype: 36, firstspriteid: 1, lastspriteid: 1 }])), /desconhecido/);
  assert.throws(() => parseCatalogContent(JSON.stringify([{ type: "sprite", file: "x", spritetype: 21, firstspriteid: 1, lastspriteid: 20 }])), /Intervalo/);
});

function sheet128(): Buffer {
  const size = 384;
  const header = Buffer.alloc(122);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(122, 10);
  header.writeUInt32LE(108, 14);
  header.writeInt32LE(size, 18);
  header.writeInt32LE(size, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(3, 30);
  header.writeUInt32LE(0x00ff0000, 54);
  header.writeUInt32LE(0x0000ff00, 58);
  header.writeUInt32LE(0x000000ff, 62);
  header.writeUInt32LE(0xff000000, 66);
  const body = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = Math.floor(y / 128) * 3 + Math.floor(x / 128);
      // Magenta in the first sprite's top-left corner: the client's transparency key.
      const magenta = index === 0 && x < 4 && y < 4;
      const value = magenta ? 0xffff00ff : ((0xff << 24) | (index << 16) | ((x % 128) << 8) | (y % 128)) >>> 0;
      body.writeUInt32LE(value, ((size - 1 - y) * size + x) * 4);
    }
  }
  const packed = Buffer.from(Uint8Array.from(compress(Buffer.concat([header, body]), 1), (value) => value & 0xff));
  const stream = Buffer.concat([packed.subarray(0, 5), Buffer.alloc(8), packed.subarray(13)]);
  const size7 = Buffer.from([0x80 | (stream.length & 0x7f), 0x80 | ((stream.length >> 7) & 0x7f), stream.length >> 14]);
  return Buffer.concat([Buffer.alloc(16), Buffer.from([0x70, 0x0a, 0xfa, 0x80, 0x24]), size7, stream]);
}

test("cuts 128×128 sprites out of a sheet and treats magenta as transparent", () => {
  const catalog = new SpriteCatalog(JSON.stringify([{ type: "sprite", file: "big.bmp.lzma", spritetype: 21, firstspriteid: 500, lastspriteid: 508 }]));
  assert.equal(catalog.addSheet("big.bmp.lzma", sheet128()), true);
  const fifth = catalog.getSprite(504)!;
  assert.deepEqual([fifth.width, fifth.height], [128, 128]);
  // Sprite 504 is grid cell 4 (row 1, column 1); pixel (x=10, y=20) encodes its cell and position.
  assert.deepEqual([...fifth.rgba.subarray((20 * 128 + 10) * 4, (20 * 128 + 10) * 4 + 4)], [4, 10, 20, 255]);
  const first = catalog.getSprite(500)!;
  assert.deepEqual([...first.rgba.subarray(0, 4)], [0, 0, 0, 0], "magenta key becomes transparent");
  assert.deepEqual([...first.rgba.subarray((4 * 128 + 4) * 4, (4 * 128 + 4) * 4 + 4)], [0, 4, 4, 255]);
  assert.equal(decodeSheet(sheet128()).width, 384);
});
