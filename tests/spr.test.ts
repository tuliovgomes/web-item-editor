import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { SprDocument, SprFormatError } from "../src/formats/spr.js";

const options = { extended: false, transparency: true, spriteSize: 32 } as const;

function samplePixels(): Buffer {
  const rgba = Buffer.alloc(32 * 32 * 4);
  rgba.set([12, 34, 56, 255], 0);
  rgba.set([240, 120, 60, 128], 4);
  return rgba;
}

test("creates, serializes, decodes and reopens alpha SPR sprites", () => {
  const source = SprDocument.create(0x1234_5678, options);
  const firstId = source.addSprite(samplePixels());
  assert.equal(firstId, 1);
  const bytes = source.serialize();
  const reopened = SprDocument.parse(bytes, options, 0x1234_5678);
  assert.equal(reopened.info.spriteCount, 1);
  assert.deepEqual(reopened.getSprite(1), samplePixels());
  assert.deepEqual(reopened.serialize(), bytes);
});

test("replaces/adds/removes sprites while retaining stable IDs", () => {
  const source = SprDocument.create(42, options);
  source.addSprite(samplePixels());
  source.addSprite(samplePixels());
  const loaded = SprDocument.parse(source.serialize(), options);
  const replacement = Buffer.alloc(32 * 32 * 4);
  replacement.set([1, 2, 3, 255], 0);
  loaded.replaceSprite(1, replacement);
  const newId = loaded.addSprite(samplePixels());
  loaded.removeSprite(2);

  const reopened = SprDocument.parse(loaded.serialize(), options);
  assert.equal(reopened.info.spriteCount, 3);
  assert.deepEqual(reopened.getSprite(1), replacement);
  assert.equal(reopened.getSprite(2)?.every((byte) => byte === 0), true);
  assert.deepEqual(reopened.getSprite(newId), samplePixels());
});

test("supports legacy RGB, empty sprites and extended sprite-count headers", () => {
  const rgbOptions = { extended: false, transparency: false, spriteSize: 32 } as const;
  const rgb = Buffer.alloc(32 * 32 * 4);
  rgb.set([10, 20, 30, 255], 0);
  const document = SprDocument.create(8, rgbOptions);
  document.addSprite(rgb);
  document.addSprite(Buffer.alloc(rgb.length));
  const reopened = SprDocument.parse(document.serialize(), rgbOptions);
  assert.deepEqual(reopened.getSprite(1)?.subarray(0, 4), Buffer.from([10, 20, 30, 255]));
  assert.equal(reopened.getSprite(2)?.every((value) => value === 0), true);

  const extendedOptions = { ...options, extended: true };
  const extended = SprDocument.create(9, extendedOptions);
  extended.addSprite(samplePixels());
  assert.equal(SprDocument.parse(extended.serialize(), extendedOptions).info.spriteCount, 1);
});

test("accepts arbitrary three-byte SPR color keys and rejects malformed headers, offsets, runs and pixel lengths", () => {
  assert.throws(() => SprDocument.parse(Buffer.alloc(5), options), /header is truncated/);
  const tooManyEntries = Buffer.alloc(6);
  tooManyEntries.writeUInt16LE(2, 4);
  assert.throws(() => SprDocument.parse(tooManyEntries, options), /offset table exceeds/);

  const makeMalformedSprite = (payload: Buffer): Buffer => {
    const header = Buffer.alloc(10);
    header.writeUInt16LE(1, 4);
    header.writeUInt32LE(10, 6);
    const block = Buffer.alloc(5 + payload.length);
    block.set([0xff, 0, 0xff], 0);
    block.writeUInt16LE(payload.length, 3);
    payload.copy(block, 5);
    return Buffer.concat([header, block]);
  };
  const colorKey = makeMalformedSprite(Buffer.from([0, 0, 1, 0, 1, 2, 3, 255]));
  colorKey[10] = 0;
  const parsedColorKey = SprDocument.parse(colorKey, options);
  assert.equal(parsedColorKey.info.spriteCount, 1);
  assert.deepEqual(parsedColorKey.getSprite(1)?.subarray(0, 4), Buffer.from([1, 2, 3, 255]));

  const badRun = makeMalformedSprite(Buffer.from([0, 0, 0, 0]));
  assert.throws(() => SprDocument.parse(badRun, options), /does not advance/);

  const badPixels = makeMalformedSprite(Buffer.from([0, 0, 1, 0, 1, 2]));
  assert.throws(() => SprDocument.parse(badPixels, options), /Truncated SPR colored-pixel/);
  assert.throws(() => SprDocument.parse(SprDocument.create(1, options).serialize(), options, 2), SprFormatError);
});

test("detects extended count and RGBA layout from sprite blocks without OTFI", async () => {
  const { SprDocument } = await import("../src/formats/spr.js");
  const header = Buffer.alloc(12);
  header.writeUInt32LE(1, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(12, 8);
  // block: color key (3), size u16, one run: 0 transparent, 1 colored RGBA pixel
  const block = Buffer.from([0xff, 0x00, 0xff, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 1, 2, 3, 4]);
  const detected = SprDocument.detectLayout(Buffer.concat([header, block]));
  assert.deepEqual(detected, { extended: true, transparency: true });
});
