import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { DatDocument, DatFormatError } from "../src/formats/dat.js";
import { OtfiDocument } from "../src/formats/otfi.js";

const classic = { clientVersion: 772 } as const;

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function makeDat(options: {
  readonly itemFlags?: Buffer;
  readonly spriteId?: number;
  readonly extended?: boolean;
} = {}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x1234_5678);
  header.writeUInt16LE(100, 4);
  const flags = options.itemFlags ?? Buffer.from([0xff]);
  const spriteId = options.spriteId ?? 42;
  const spriteBytes = options.extended ? u32(spriteId) : u16(spriteId);
  return Buffer.concat([header, flags, Buffer.from([1, 1, 1, 1, 1, 1, 1]), spriteBytes]);
}

test("reads the DAT header, category ID and classic sprite layout", () => {
  const source = makeDat({ itemFlags: Buffer.from([0, 150, 0, 0xff]) });
  const document = DatDocument.parse(source, classic);
  const item = document.getRecord("items", 100);
  assert.equal(document.signature, 0x1234_5678);
  assert.equal(document.getRecordCount("items"), 1);
  assert.deepEqual(item?.flags, [0]);
  assert.deepEqual(item?.groups[0]?.spriteIds, [42]);
  assert.deepEqual(document.serialize(), source);
});

test("edits a sprite reference and reopens the compiled DAT", () => {
  const source = makeDat();
  const document = DatDocument.parse(source, classic);
  document.setSpriteId("items", 100, 0, 0, 300);
  const output = document.serialize();
  assert.equal(document.dirty, true);
  assert.equal(DatDocument.parse(output, classic).getRecord("items", 100)?.groups[0]?.spriteIds[0], 300);
  assert.equal(source.readUInt16LE(source.length - 2), 42);
});

test("edits flag properties and their numeric payloads then reopens semantically", () => {
  const flagRecord = Buffer.from([0, 150, 0, 5, 0xff]);
  const document = DatDocument.parse(makeDat({ itemFlags: flagRecord }), classic);
  document.setProperty("items", 100, "isStackable", true);
  document.setProperty("items", 100, "groundSpeed", 250);
  document.setProperty("items", 100, "isGround", false);
  document.setProperty("items", 100, "isWritable", true);
  document.setProperty("items", 100, "writableOnce", true);
  document.setProperty("items", 100, "maxTextLength", 700);
  const reopened = DatDocument.parse(document.serialize(), classic);
  const properties = reopened.getRecord("items", 100)?.properties;
  assert.equal(properties?.isGround, undefined);
  assert.equal(properties?.groundSpeed, undefined);
  assert.equal(properties?.isStackable, true);
  assert.equal(properties?.isWritable, true);
  assert.equal(properties?.writableOnce, true);
  assert.equal(properties?.maxTextLength, 700);
});

test("edits special flag payloads and rejects invalid versions and ranges", () => {
  const document = DatDocument.parse(makeDat(), {
    clientVersion: 1200,
    otfi: { extended: false, frameDurations: false, frameGroups: false },
  });
  document.setProperty("items", 100, "hasLight", true);
  document.setProperty("items", 100, "lightLevel", 120);
  document.setProperty("items", 100, "lightColor", 250);
  document.setProperty("items", 100, "hasMarket", true);
  document.setProperty("items", 100, "marketCategory", 4);
  document.setProperty("items", 100, "marketName", "sample");
  const reopened = DatDocument.parse(document.serialize(), {
    clientVersion: 1200,
    otfi: { extended: false, frameDurations: false, frameGroups: false },
  });
  assert.equal(reopened.getRecord("items", 100)?.properties.lightLevel, 120);
  assert.equal(reopened.getRecord("items", 100)?.properties.lightColor, 250);
  assert.equal(reopened.getRecord("items", 100)?.properties.marketName, "sample");
  assert.throws(() => document.setProperty("items", 100, "offsetX", 40_000), /supported range/);
  const legacy = DatDocument.parse(makeDat(), {
    clientVersion: 772,
    otfi: { extended: false, frameDurations: false, frameGroups: false },
  });
  assert.throws(() => legacy.setProperty("items", 100, "hasCloth", true), /client version/);
  assert.throws(() => document.setProperty("items", 100, "unknownFlag", true), /Unsupported DAT property/);
});

test("reads and writes signed offsets and leaves records unchanged after rejected edits", () => {
  const source = makeDat({ itemFlags: Buffer.from([24, 0xff, 0xff, 2, 0, 0xff]) });
  const document = DatDocument.parse(source, classic);
  assert.equal(document.getRecord("items", 100)?.properties.offsetX, -1);
  assert.equal(document.getRecord("items", 100)?.properties.offsetY, 2);

  document.setProperty("items", 100, "offsetX", -2);
  const beforeRejectedEdit = document.serialize();
  assert.throws(() => document.setProperty("items", 100, "offsetX", 40_000), /supported range/);
  assert.deepEqual(document.serialize(), beforeRejectedEdit);

  const reopened = DatDocument.parse(document.serialize(), classic);
  assert.equal(reopened.getRecord("items", 100)?.properties.offsetX, -2);
});

test("creates and removes category records while updating DAT maximum IDs", () => {
  const document = DatDocument.parse(makeDat(), classic);
  const createdId = document.createRecord("items", 100);
  assert.equal(createdId, 101);
  document.removeRecord("items", 100);
  const output = document.serialize();
  const reopened = DatDocument.parse(output, classic);
  assert.equal(reopened.getRecordCount("items"), 1);
  assert.equal(reopened.getRecord("items", 100)?.groups[0]?.spriteIds[0], 42);
});

test("supports extended sprite IDs and OTFI frame-group layout", () => {
  const extended = DatDocument.parse(makeDat({ extended: true, spriteId: 70_000 }), {
    clientVersion: 960,
  });
  assert.equal(extended.getRecord("items", 100)?.groups[0]?.spriteIds[0], 70_000);

  const outfitHeader = Buffer.alloc(12);
  outfitHeader.writeUInt32LE(7);
  outfitHeader.writeUInt16LE(99, 4);
  outfitHeader.writeUInt16LE(1, 6);
  const outfitRecord = Buffer.from([0xff, 1, 0, 1, 1, 1, 1, 1, 1, 1, 55, 0]);
  const outfitDocument = DatDocument.parse(Buffer.concat([outfitHeader, outfitRecord]), {
    clientVersion: 1000,
    otfi: { extended: false, frameDurations: false, frameGroups: true },
  });
  const output = outfitDocument.serialize();
  assert.equal(DatDocument.parse(output, {
    clientVersion: 1000,
    otfi: { extended: false, frameDurations: false, frameGroups: true },
  }).getRecord("outfits", 1)?.groups[0]?.spriteIds[0], 55);
});

test("creates an empty DAT project with valid category maxima", () => {
  const output = DatDocument.create(9, classic).serialize();
  const reopened = DatDocument.parse(output, classic);
  assert.equal(reopened.signature, 9);
  assert.equal(reopened.getRecordCount("items"), 0);
});

test("creates and compiles a new default item record", () => {
  const document = DatDocument.create(9, classic);
  assert.equal(document.createRecord("items"), 100);
  const reopened = DatDocument.parse(document.serialize(), classic);
  assert.deepEqual(reopened.getRecord("items", 100)?.groups[0]?.spriteIds, [0]);
});

test("rejects truncated records, unknown flags, version mismatches and excessive sizes", () => {
  assert.throws(() => DatDocument.parse(Buffer.alloc(11), classic), DatFormatError);
  assert.throws(() => DatDocument.parse(makeDat().subarray(0, -1), classic), /Truncated/);
  assert.throws(
    () => DatDocument.parse(makeDat({ itemFlags: Buffer.from([0x70]) }), classic),
    /Unsupported DAT flag 112 .*items record 100 at byte offset 12 for client version 772/,
  );
  assert.throws(() => DatDocument.parse(makeDat(), { clientVersion: 1057 }), /Truncated|mismatch/);
  assert.throws(() => DatDocument.parse(makeDat(), { ...classic, maxFileBytes: 12 }), /exceeds configured limit/);
  assert.throws(() => DatDocument.create(1, { clientVersion: 0 }), /positive integer/);
});

test("validates OTFI boolean values rather than coercing invalid text to false", () => {
  const document = OtfiDocument.parse("DatSpr\n  extended: maybe\n");
  assert.throws(() => document.settings, /Invalid boolean value/);
});
