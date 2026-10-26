import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { AssetProject } from "../src/project/project.js";

test("opens, edits, compiles and reopens the DAT+SPR+OTFI project triplet", () => {
  const project = AssetProject.create(0x1234, { clientVersion: 772 });
  const itemId = project.createRecord("items");
  const rgba = Buffer.alloc(32 * 32 * 4);
  rgba.set([10, 20, 30, 255], 0);
  const spriteId = project.addSprite(rgba);
  project.setSpriteId("items", itemId, 0, 0, spriteId);
  project.setProperty("items", itemId, "isStackable", true);

  const files = project.compile();
  assert.deepEqual(files.map((file) => file.name), ["Tibia.dat", "Tibia.spr", "project.otfi"]);
  const reopened = AssetProject.open({
    dat: files[0]!.data,
    spr: files[1]!.data,
    otfi: files[2]!.data,
  }, { clientVersion: 772 });
  assert.equal(reopened.summary.counts.items, 1);
  assert.equal(reopened.summary.sprites.spriteCount, 1);
  assert.equal(reopened.list("items")[0]?.properties.isStackable, true);
  assert.deepEqual(reopened.getSprite(spriteId), rgba);
});

test("preserves independent DAT/SPR signatures and rejects dangling sprite references", () => {
  const project = AssetProject.create(5, { clientVersion: 772 });
  const files = project.compile();
  const mismatchedSpr = Buffer.from(files[1]!.data);
  mismatchedSpr[0] = mismatchedSpr[0]! ^ 1;
  const reopened = AssetProject.open({
    dat: files[0]!.data,
    spr: mismatchedSpr,
    otfi: files[2]!.data,
  }, { clientVersion: 772 });
  assert.notEqual(reopened.summary.sprites.signature, reopened.summary.datSignature);
  const compiled = reopened.compile();
  assert.equal(compiled[1]!.data.readUInt32LE(0), mismatchedSpr.readUInt32LE(0));

  project.createRecord("items");
  project.createRecord("items");
  assert.throws(() => project.setSpriteId("items", 100, 0, 0, 12), /does not exist/);
});

test("infers the client flag schema from modern OTFI layout when version is automatic", () => {
  const source = AssetProject.create(7, { clientVersion: 1057 });
  const itemId = source.createRecord("items");
  source.setProperty("items", itemId, "isPickupable", true);
  const [dat, spr, otfi] = source.compile();
  const reopened = AssetProject.open({ dat: dat!.data, spr: spr!.data, otfi: otfi!.data }, { clientVersion: 0 });

  assert.equal(reopened.summary.clientVersion, 1057);
  assert.equal(reopened.list("items")[0]?.properties.isPickupable, true);
});

test("reports an actionable error when the SPR layout cannot be detected without OTFI", () => {
  const source = AssetProject.create(7, { clientVersion: 1057 });
  const [dat, spr] = source.compile();
  assert.throws(
    () => AssetProject.open({ dat: dat!.data, spr: spr!.data }, { clientVersion: 0 }),
    /Could not detect the SPR layout/,
  );
});

test("adopts the real SPR pixel format when the OTFI transparency flag is wrong", () => {
  const source = AssetProject.create(3, { clientVersion: 1057 });
  source.addSprite(Buffer.alloc(32 * 32 * 4, 0xff));
  const [dat, spr, otfi] = source.compile();
  const wrong = Buffer.from(otfi!.data.toString("utf8").replace(/transparency: \w+/, "transparency: true"), "utf8");
  const reopened = AssetProject.open({ dat: dat!.data, spr: spr!.data, otfi: wrong }, { clientVersion: 0 });

  assert.equal(reopened.summary.sprites.transparency, false);
  assert.equal(reopened.summary.warnings.length, 1);
  assert.match(reopened.compile()[2]!.data.toString("utf8"), /transparency: false/);
});

test("falls back to another flag table when the OTFI-inferred version cannot parse the DAT", () => {
  const source = AssetProject.create(0x1234, { clientVersion: 854 });
  const id = source.createRecord("items");
  source.setProperty("items", id, "chargeable", true);
  const files = source.compile();
  const byName = (ext: string) => files.find((file) => file.name.endsWith(ext))!.data;
  const otfi = Buffer.from(byName(".otfi").toString("utf8").replace(/frame-groups: false/, "frame-groups: true"));
  const reopened = AssetProject.open({ dat: byName(".dat"), spr: byName(".spr"), otfi }, { clientVersion: 0 });
  assert.ok(reopened.summary.clientVersion >= 700);
});

test("removes several records by their current IDs without touching unselected ones", () => {
  const project = AssetProject.create(1, { clientVersion: 772 });
  for (let index = 0; index < 6; index += 1) {
    const id = project.createRecord("items");
    project.setProperty("items", id, "groundSpeed", id);
  }
  // IDs 100..105 carry their own ID as groundSpeed; delete 101, 103 and 104 (passed out of order, with a repeat).
  const result = project.removeRecords("items", [104, 101, 103, 101, 999]);
  assert.deepEqual(result.removed, [101, 103, 104]);
  assert.deepEqual(result.failed.map((failure) => failure.id), [999]);
  assert.match(result.failed[0]!.error, /No items record with ID 999/);
  assert.deepEqual(project.list("items").map((record) => record.properties.groundSpeed), [100, 102, 105]);
});

test("removes sprites in place, keeping every ID and reporting the records that use them", () => {
  const project = AssetProject.create(1, { clientVersion: 772 });
  // Opaque pixels: a 7.72 SPR stores RGB, so alpha always comes back as 255.
  const pixels = (value: number) => Buffer.from(Buffer.alloc(32 * 32 * 4, value).map((byte, index) => (index % 4 === 3 ? 255 : byte)));
  for (let index = 1; index <= 4; index += 1) project.addSprite(pixels(index));
  const item = project.createRecord("items");
  project.setSpriteId("items", item, 0, 0, 3);

  assert.deepEqual(project.spriteUsage([2, 3]), [{ category: "items", id: item }]);
  assert.deepEqual(project.spriteUsage([4]), []);
  const result = project.removeSprites([3, 2, 9]);
  assert.deepEqual(result.removed, [2, 3]);
  assert.deepEqual(result.failed.map((failure) => failure.id), [9]);

  const files = project.compile();
  const reopened = AssetProject.open({ dat: files[0]!.data, spr: files[1]!.data, otfi: files[2]!.data }, { clientVersion: 772 });
  assert.equal(reopened.summary.sprites.spriteCount, 4, "no sprite was renumbered");
  assert.deepEqual(reopened.getSprite(1), pixels(1));
  assert.ok(reopened.getSprite(2)!.every((byte) => byte === 0));
  assert.ok(reopened.getSprite(3)!.every((byte) => byte === 0));
  assert.deepEqual(reopened.getSprite(4), pixels(4));
  assert.equal(reopened.list("items")[0]?.groups[0]?.spriteIds[0], 3, "DAT references are unchanged");
});
