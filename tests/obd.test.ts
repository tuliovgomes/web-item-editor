import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { decodeObd } from "../src/formats/obd.js";
import { AssetProject } from "../src/project/project.js";

function sample(): { project: AssetProject; id: number; pixels: Buffer } {
  const project = AssetProject.create(1, { clientVersion: 1057 });
  const id = project.createRecord("items");
  const pixels = Buffer.alloc(32 * 32 * 4);
  pixels.set([10, 20, 30, 255, 40, 50, 60, 128], 0);
  const sprite = project.addSprite(pixels);
  project.setSpriteId("items", id, 0, 0, sprite);
  project.setProperty("items", id, "isStackable", true);
  project.setProperty("items", id, "isGround", true);
  project.setProperty("items", id, "groundSpeed", 150);
  project.setProperty("items", id, "hasOffset", true);
  project.setProperty("items", id, "offsetX", -8);
  project.setProperty("items", id, "offsetY", 4);
  return { project, id, pixels };
}

test("exports an OBD v2 and imports it as a new record with identical pixels and flags", () => {
  const { project, id, pixels } = sample();
  const { data, warnings } = project.exportObd("items", id);
  assert.deepEqual(warnings, []);

  const decoded = decodeObd(data);
  assert.equal(decoded.category, "items");
  assert.equal(decoded.clientVersion, 1057);
  assert.equal(decoded.properties["groundSpeed"], 150);
  assert.equal(decoded.properties["offsetX"], -8);

  const target = AssetProject.create(1, { clientVersion: 1057 });
  const before = target.summary.counts.items;
  const result = target.importObd(data);
  assert.equal(result.category, "items");
  assert.equal(target.summary.counts.items, before + 1);
  assert.equal(result.addedSprites, 1);
  const record = target.list("items", result.id - 100, 1)[0]!;
  assert.equal(record.properties.isStackable, true);
  assert.equal(record.properties.groundSpeed, 150);
  assert.equal(record.properties.offsetX, -8);
  assert.deepEqual(target.getSprite(record.groups[0]!.spriteIds[0]!), pixels);
  target.compile();
});

test("round-trips animation durations", () => {
  const project = AssetProject.create(1, { clientVersion: 1057 });
  const id = project.createRecord("effects");
  const target = AssetProject.create(1, { clientVersion: 1057 });
  const reference = project.exportObd("effects", id).data;
  assert.equal(target.importObd(reference).category, "effects");
});

test("rejects empty, truncated, corrupted and oversized OBD files", () => {
  const { project, id } = sample();
  const { data } = project.exportObd("items", id);
  const target = AssetProject.create(1, { clientVersion: 1057 });
  const count = target.summary.counts.items;
  assert.throws(() => target.importObd(Buffer.alloc(0)));
  assert.throws(() => target.importObd(data.subarray(0, data.length - 20)));
  const corrupted = Buffer.from(data);
  corrupted.writeUInt32LE(0xffff_ffff, 9);
  assert.throws(() => target.importObd(corrupted), /valid|size/i);
  assert.equal(target.summary.counts.items, count);
});
