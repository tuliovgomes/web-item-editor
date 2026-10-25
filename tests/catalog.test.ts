import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { compress } from "lzma";
import { CatalogFormatError, SpriteCatalog, decodeSheet } from "../src/formats/catalog.js";

const SIZE = 384;

/** Builds a bottom-up BITFIELDS BMP like the official sheets; sprite N of a 32x32 grid is filled with colour N. */
function sheetBmp(): Buffer {
  const header = Buffer.alloc(122);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(122 + SIZE * SIZE * 4, 2);
  header.writeUInt32LE(122, 10);
  header.writeUInt32LE(108, 14);
  header.writeInt32LE(SIZE, 18);
  header.writeInt32LE(SIZE, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(3, 30);
  header.writeUInt32LE(0x00ff0000, 54);
  header.writeUInt32LE(0x0000ff00, 58);
  header.writeUInt32LE(0x000000ff, 62);
  header.writeUInt32LE(0xff000000, 66);
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const index = Math.floor(y / 32) * 12 + Math.floor(x / 32);
      const row = SIZE - 1 - y;
      pixels.writeUInt32LE(((0xff << 24) | (index << 16) | (x % 32 << 8) | (y % 32)) >>> 0, (row * SIZE + x) * 4);
    }
  }
  return Buffer.concat([header, pixels]);
}

function cipWrap(bmp: Buffer): Buffer {
  const packed = Buffer.from(Uint8Array.from(compress(bmp, 1), (value) => value & 0xff));
  const body = Buffer.concat([packed.subarray(0, 5), Buffer.alloc(8), packed.subarray(13)]);
  const varint = Buffer.from([0x80 | (body.length & 0x7f), 0x80 | ((body.length >> 7) & 0x7f), body.length >> 14]);
  return Buffer.concat([Buffer.alloc(16), Buffer.from([0x70, 0x0a, 0xfa, 0x80, 0x24]), varint, body]);
}

const catalogJson = JSON.stringify([
  { type: "appearances", file: "appearances-x.dat" },
  { type: "sprite", file: "sprites-a.bmp.lzma", spritetype: 0, firstspriteid: 10, lastspriteid: 153 },
]);

test("decodes a CipSoft sheet into top-down RGBA", () => {
  const image = decodeSheet(cipWrap(sheetBmp()));
  assert.equal(image.width, SIZE);
  assert.equal(image.height, SIZE);
  // Pixel (x=5, y=3) belongs to sprite index 0: r=0, g=x%32, b=y%32.
  assert.deepEqual([...image.rgba.subarray((3 * SIZE + 5) * 4, (3 * SIZE + 5) * 4 + 4)], [0, 5, 3, 255]);
});

test("cuts sprites out of a sheet by catalog ID", () => {
  const catalog = new SpriteCatalog(catalogJson);
  assert.equal(catalog.getSprite(10), undefined);
  assert.equal(catalog.addSheet("other.bmp.lzma", Buffer.alloc(1)), false);
  assert.equal(catalog.addSheet("sprites-a.bmp.lzma", cipWrap(sheetBmp())), true);

  const sprite = catalog.getSprite(10 + 13)!;
  assert.equal(sprite.width, 32);
  assert.equal(sprite.height, 32);
  assert.deepEqual([...sprite.rgba.subarray(0, 4)], [13, 0, 0, 255]);
  assert.deepEqual([...sprite.rgba.subarray((7 * 32 + 9) * 4, (7 * 32 + 9) * 4 + 4)], [13, 9, 7, 255]);
  assert.equal(catalog.getSprite(9), undefined);
  assert.deepEqual(catalog.summary.ranges, [[10, 153]]);
  assert.equal(catalog.summary.spriteCount, 144);
  assert.equal(catalog.appearancesFile, "appearances-x.dat");
});

test("rejects malformed catalogs", () => {
  assert.throws(() => new SpriteCatalog("not json"), CatalogFormatError);
  assert.throws(() => new SpriteCatalog("[]"), CatalogFormatError);
  assert.throws(
    () => new SpriteCatalog(JSON.stringify([{ type: "sprite", file: "../x", spritetype: 0, firstspriteid: 0, lastspriteid: 1 }])),
    CatalogFormatError,
  );
});
