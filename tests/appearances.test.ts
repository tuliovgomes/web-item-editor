import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { AppearanceLibrary, AppearancesFormatError } from "../src/formats/appearances.js";

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
};
const num = (field: number, value: number): number[] => [...varint(field * 8), ...varint(value)];
const msg = (field: number, ...parts: number[][]): number[] => {
  const body = parts.flat();
  return [...varint(field * 8 + 2), ...varint(body.length), ...body];
};

test("parses objects, frame groups, animation and flags", () => {
  const spriteInfo = msg(3, num(1, 1), num(2, 1), num(3, 1), num(4, 2), num(5, 300), num(5, 301), num(5, 302), num(5, 303),
    msg(6, num(4, 1), msg(6, num(1, 100), num(2, 200)), msg(6, num(1, 50), num(2, 50))));
  const item = msg(1, num(1, 2160), msg(2, num(1, 2), spriteInfo),
    msg(3, num(5, 1), msg(23, num(1, 7), num(2, 215)), msg(40, [0x0a, 1, 0x41], num(3, 500)), num(63, 20)));
  const outfit = msg(2, num(1, 128), [0x22, 3, 0x42, 0x6f, 0x62]);

  const library = AppearanceLibrary.parse(Buffer.from([...item, ...outfit]));
  assert.deepEqual(library.counts, { items: 1, outfits: 1, effects: 0, missiles: 0 });
  const parsed = library.get("items", 2160)!;
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0]!.layers, 2);
  assert.equal(parsed.groups[0]!.frames, 2);
  assert.deepEqual(parsed.groups[0]!.spriteIds, [300, 301, 302, 303]);
  assert.deepEqual(parsed.groups[0]!.animation?.phases, [[100, 200], [50, 50]]);
  assert.deepEqual(parsed.flags, {
    container: true,
    light: { brightness: 7, color: 215 },
    npcSaleData: [{ name: "A", salePrice: 500 }],
    minimumLevel: 20,
  });
  assert.equal(library.get("outfits", 128)!.name, "Bob");
  assert.deepEqual(library.list("items", "216").map((entry) => entry.id), [2160]);
});

test("rejects truncated and empty appearance files", () => {
  assert.throws(() => AppearanceLibrary.parse(Buffer.from([0x0a, 0x10, 0x08])), AppearancesFormatError);
  assert.throws(() => AppearanceLibrary.parse(Buffer.alloc(0)), AppearancesFormatError);
});

test("exports a modern appearance as OBD v2 with 64px sprites cut into 32px cells", async () => {
  const { buildModernObdPayload, decodeObd, compressObd } = await import("../src/formats/obd.js");
  const rgba = Buffer.alloc(64 * 64 * 4);
  // Mark the top-left 32x32 cell (the image's cell at column 1 / row 1 in OBD order) with red.
  for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) rgba.set([255, 0, 0, 255], (y * 64 + x) * 4);
  const appearance = AppearanceLibrary.parse(Buffer.from(msg(1, num(1, 7), msg(2, num(1, 2), msg(3, num(1, 1), num(2, 1), num(3, 1), num(4, 1), num(5, 900)), ), msg(3, num(5, 1), num(18, 1))))).get("items", 7)!;
  const payload = buildModernObdPayload({
    appearance,
    clientVersion: 1524,
    getSprite: (id) => (id === 900 ? { width: 64, height: 64, rgba } : undefined),
  });
  const thing = decodeObd(compressObd(payload.raw));
  assert.equal(thing.clientVersion, 1524);
  assert.equal(thing.category, "items");
  assert.equal(thing.properties["isContainer"], true);
  assert.equal(thing.properties["isPickupable"], true);
  assert.equal(thing.group.width, 2);
  assert.equal(thing.group.height, 2);
  assert.deepEqual([...thing.sprites.get(4)!.subarray(0, 4)], [255, 0, 0, 255]);
  assert.equal(thing.group.spriteIds.filter((id) => id !== 0).length, 1);
  // Cell order is (row, column) with column 0 at the right edge: the red top-left cell is the last one.
  assert.deepEqual([...thing.group.spriteIds], [0, 0, 0, 4]);
});
