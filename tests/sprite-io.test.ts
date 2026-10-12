import assert from "node:assert/strict";
import { test } from "node:test";
import { AssetProject } from "../src/project/project.js";
import { createEditorServer } from "../src/server.js";

interface Cell { id?: number; x: number; y: number }
interface SpriteIo {
  crc32(bytes: Uint8Array): number;
  buildZip(entries: { name: string; data: Uint8Array }[]): Uint8Array;
  sniffImageType(bytes: Uint8Array): string | null;
  sheetIndexOf(id: number): number;
  sheetRange(index: number, count: number): number[];
  sheetPosition(id: number): { sheet: number; column: number; row: number };
  composeSheet(ids: number[], frames: Uint8ClampedArray[], size: number, columns: number): {
    width: number; height: number; rgba: Uint8ClampedArray; metadata: { cells: Cell[]; tileSize: number };
  };
  sliceSheet(rgba: Uint8ClampedArray, width: number, height: number, size: number, options?: {
    skipEmpty?: boolean; metadata?: unknown; maxTiles?: number;
  }): { tiles: { x: number; y: number; rgba: Uint8ClampedArray }[]; skipped: number };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- classic browser script shared with the tests
const io = require("../web/sprite-io.js") as SpriteIo;

function frame(size: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return data;
}

test("computes the standard CRC-32 and a readable stored ZIP", () => {
  assert.equal(io.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const zip = io.buildZip([{ name: "a.txt", data: new TextEncoder().encode("hello") }, { name: "b/c.bin", data: new Uint8Array([1, 2, 3]) }]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 12, true), 2);
  assert.throws(() => io.buildZip([{ name: "x", data: new Uint8Array() }, { name: "x", data: new Uint8Array() }]), /Duplicate/);
});

test("identifies image formats by content, not extension", () => {
  assert.equal(io.sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "png");
  assert.equal(io.sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(io.sniffImageType(new TextEncoder().encode("MZ not an image")), null);
  assert.equal(io.sniffImageType(new Uint8Array()), null);
});

test("maps sprite IDs to 32x32 sheets and positions", () => {
  assert.equal(io.sheetIndexOf(1), 0);
  assert.equal(io.sheetIndexOf(1024), 0);
  assert.equal(io.sheetIndexOf(1025), 1);
  assert.deepEqual(io.sheetPosition(34), { sheet: 0, column: 1, row: 1 });
  assert.deepEqual(io.sheetRange(1, 1030), [1025, 1026, 1027, 1028, 1029, 1030]);
});

test("composes a sheet preserving dimensions, alpha and relative positions, then slices it back", () => {
  const size = 4;
  const red = frame(size, [255, 0, 0, 255]);
  const half = frame(size, [0, 255, 0, 128]);
  const empty = frame(size, [0, 0, 0, 0]);
  const sheet = io.composeSheet([7, 8, 9], [red, half, empty], size, 2);
  assert.deepEqual([sheet.width, sheet.height], [8, 8]);
  assert.deepEqual(sheet.metadata.cells, [{ id: 7, x: 0, y: 0 }, { id: 8, x: 4, y: 0 }, { id: 9, x: 0, y: 4 }]);
  assert.deepEqual([...sheet.rgba.subarray(4 * 4, 4 * 4 + 4)], [0, 255, 0, 128]);

  const grid = io.sliceSheet(sheet.rgba, sheet.width, sheet.height, size);
  assert.equal(grid.tiles.length, 2);
  assert.equal(grid.skipped, 2);
  assert.deepEqual([...grid.tiles[1]!.rgba], [...half]);

  const withEmpty = io.sliceSheet(sheet.rgba, sheet.width, sheet.height, size, { skipEmpty: false });
  assert.equal(withEmpty.tiles.length, 4);
  const byMetadata = io.sliceSheet(sheet.rgba, sheet.width, sheet.height, size, { metadata: sheet.metadata, skipEmpty: false });
  assert.equal(byMetadata.tiles.length, 3);
  assert.deepEqual([...byMetadata.tiles[0]!.rgba], [...red]);
});

test("refuses to cut irregular images and rejects invalid metadata or limits", () => {
  const rgba = new Uint8ClampedArray(10 * 8 * 4);
  assert.throws(() => io.sliceSheet(rgba, 10, 8, 4), /not a regular grid/);
  assert.throws(() => io.sliceSheet(rgba, 10, 8, 4, { metadata: { tileSize: 4, cells: [{ x: 8, y: 0 }] } }), /outside the image/);
  assert.throws(() => io.sliceSheet(rgba, 10, 8, 4, { metadata: { tileSize: 8, cells: [] } }), /tile size/);
  assert.throws(() => io.sliceSheet(new Uint8ClampedArray(8 * 8 * 4), 8, 8, 4, { maxTiles: 3 }), /limit/);
  assert.throws(() => io.sliceSheet(new Uint8ClampedArray(3), 8, 8, 4), /does not match/);
});

test("batch sprite endpoints append without overwriting and return exact RGBA", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const project = AssetProject.create(1, { clientVersion: 1057 });
    const files = project.compile();
    const upload = async (kind: string, index: number) => fetch(`${base}/api/upload?kind=${kind}`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(files[index]!.data),
    });
    await upload("dat", 0);
    await upload("spr", 1);
    await upload("otfi", 2);
    assert.equal((await fetch(`${base}/api/project/open?clientVersion=0`, { method: "POST" })).status, 200);

    const first = Buffer.from(frame(32, [10, 20, 30, 255]).buffer);
    const second = Buffer.from(frame(32, [1, 2, 3, 0]).buffer);
    const added = await fetch(`${base}/api/project/sprites`, { method: "POST", body: new Uint8Array(Buffer.concat([first, second])) });
    const body = await added.json() as { firstId: number; count: number };
    assert.deepEqual([added.status, body.firstId, body.count], [201, 1, 2]);

    const again = await (await fetch(`${base}/api/project/sprites`, { method: "POST", body: new Uint8Array(first) })).json() as { firstId: number };
    assert.equal(again.firstId, 3);

    const read = await fetch(`${base}/api/project/sprites?ids=2,1`);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), Buffer.concat([second, first]));

    assert.equal((await fetch(`${base}/api/project/sprites`, { method: "POST", body: new Uint8Array(first.subarray(0, 100)) })).status, 400);
    assert.equal((await fetch(`${base}/api/project/sprites?ids=99`)).status, 400);
    assert.equal((await fetch(`${base}/api/project/sprites?ids=abc`)).status, 400);
    const script = await fetch(`${base}/sprite-io.js`);
    assert.equal(script.status, 200);
  } finally {
    await editor.close();
  }
});
