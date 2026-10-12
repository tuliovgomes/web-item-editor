import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { OtfiDocument } from "../src/formats/otfi.js";

test("parses OTFI options and retains original text on no-change save", () => {
  const source = Buffer.from(
    "# project notes\r\nDatSpr\r\n  extended: true\r\n  transparency: false\r\n  frame-durations: true\r\n  frame-groups: true\r\n  metadata-file: client.dat\r\n  sprites-file: client.spr\r\n  sprite-size: 64\r\n  custom-option: keep-me\r\nOtherSection\r\n  value: 1\r\n",
  );
  const document = OtfiDocument.parse(source);
  assert.deepEqual(document.settings, {
    extended: true,
    transparency: false,
    frameDurations: true,
    frameGroups: true,
    metadataFile: "client.dat",
    spritesFile: "client.spr",
    spriteSize: 64,
  });
  assert.deepEqual(document.serialize(), source);
});

test("updates an OTFI option while preserving unknown sections and settings", () => {
  const source = "DatSpr\n  extended: false\n  private-key: value\nAnotherSection\n  x: y\n";
  const document = OtfiDocument.parse(source);
  document.set("extended", true);
  assert.match(document.serialize().toString("utf8"), /  extended: true\n/);
  assert.match(document.serialize().toString("utf8"), /  private-key: value\n/);
  assert.match(document.serialize().toString("utf8"), /AnotherSection\n  x: y\n/);
});

test("creates a complete OTFI for a new asset project", () => {
  const document = OtfiDocument.create({
    extended: true,
    transparency: true,
    frameDurations: true,
    frameGroups: true,
    metadataFile: "Tibia.dat",
    spritesFile: "Tibia.spr",
    spriteSize: 32,
  });
  assert.deepEqual(document.settings, {
    extended: true,
    transparency: true,
    frameDurations: true,
    frameGroups: true,
    metadataFile: "Tibia.dat",
    spritesFile: "Tibia.spr",
    spriteSize: 32,
    attributeServer: "tfs1.4",
    metadataController: "default",
  });
  assert.match(document.serialize().toString("utf8"), /sprite-data-size: 4096/);
});

test("rejects unsafe asset paths and unsupported sprite dimensions", () => {
  const traversal = OtfiDocument.parse("DatSpr\n  metadata-file: ../outside.dat\n");
  assert.throws(() => traversal.settings, /cannot escape/);
  const unsupportedSize = OtfiDocument.parse("DatSpr\n  sprite-size: 48\n");
  assert.throws(() => unsupportedSize.settings, /Unsupported OTFI sprite-size/);
});
