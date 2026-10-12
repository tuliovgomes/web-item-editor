import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { OtbDocument, OtbFormatError } from "../src/formats/otb.js";

function escapeBytes(data: Buffer): Buffer {
  const result: number[] = [];
  for (const byte of data) {
    if (byte === 0xfd || byte === 0xfe || byte === 0xff) result.push(0xfd);
    result.push(byte);
  }
  return Buffer.from(result);
}

function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value);
  return result;
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function attribute(type: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), u16(payload.length), payload]);
}

function textAttribute(type: number, value: string): Buffer {
  const encoded = Buffer.from(value, "latin1");
  return attribute(type, Buffer.concat([u16(encoded.length), encoded]));
}

function makeOtb(identifier = Buffer.from("OTBI")): Buffer {
  const root = Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 1]),
    u16(12),
    u32(3),
    u32(4),
    u32(5),
  ]);
  const unknownPayload = Buffer.from([0xfd, 0xfe, 0xff, 0x00]);
  const firstItem = Buffer.concat([
    Buffer.from([1]),
    u32(0x8000_0001),
    attribute(0x10, u16(100)),
    attribute(0x11, u16(200)),
    textAttribute(0x12, "item"),
    attribute(0x70, unknownPayload),
  ]);
  const secondItem = Buffer.concat([
    Buffer.from([15]),
    u32(7),
    attribute(0x10, u16(101)),
    textAttribute(0x12, "second"),
  ]);
  return Buffer.concat([
    identifier,
    Buffer.from([0xfe]),
    escapeBytes(root),
    Buffer.from([0xfe]),
    escapeBytes(firstItem),
    Buffer.from([0xff, 0xfe]),
    escapeBytes(secondItem),
    Buffer.from([0xff, 0xff]),
  ]);
}

test("reads OTB identifier, header version, flags and attributes", () => {
  const document = OtbDocument.parse(makeOtb());
  assert.equal(document.identifier.toString("latin1"), "OTBI");
  assert.equal(document.majorVersion, 3);
  assert.equal(document.minorVersion, 4);
  assert.equal(document.buildNumber, 5);
  assert.equal(document.itemCount, 2);
  assert.deepEqual(document.items[0], {
    group: 1,
    flags: 0x8000_0001,
    serverId: 100,
    clientId: 200,
    name: "item",
    attributes: [
      { type: 0x10, payload: Buffer.from([100, 0]) },
      { type: 0x11, payload: Buffer.from([200, 0]) },
      { type: 0x12, payload: Buffer.from([4, 0, 0x69, 0x74, 0x65, 0x6d]) },
      { type: 0x70, payload: Buffer.from([0xfd, 0xfe, 0xff, 0x00]) },
    ],
  });
});

test("preserves the exact original bytes when no edit is made", () => {
  const original = makeOtb();
  assert.deepEqual(OtbDocument.parse(original).serialize(), original);
});

test("edits a known value and retains opaque attribute bytes and order", () => {
  const document = OtbDocument.parse(makeOtb());
  document.setItemField(100, "name", "new");
  assert.equal(document.dirty, true);

  const output = document.serialize();
  assert.notDeepEqual(output, makeOtb());
  const reopened = OtbDocument.parse(output);
  const item = reopened.items[0]!;
  assert.equal(item.name, "new");
  assert.deepEqual(item.attributes.map(({ type }) => type), [0x10, 0x11, 0x12, 0x70]);
  assert.deepEqual(item.attributes[3]!.payload, Buffer.from([0xfd, 0xfe, 0xff, 0x00]));
});

test("updates the selected portion of a composite light attribute", () => {
  const fixture = makeOtb();
  const document = OtbDocument.parse(fixture);
  document.setItemField(100, "lightLevel", 120);
  const reopened = OtbDocument.parse(document.serialize());
  assert.equal(reopened.items[0]!.lightLevel, 120);
  assert.equal(reopened.items[0]!.lightColor, 0);
});

test("accepts the zero OTB identifier and preserves it", () => {
  const original = makeOtb(Buffer.alloc(4));
  const document = OtbDocument.parse(original);
  assert.deepEqual(document.identifier, Buffer.alloc(4));
  assert.deepEqual(document.serialize(), original);
});

test("rejects invalid identifiers, malformed escapes and truncation", () => {
  assert.throws(() => OtbDocument.parse(Buffer.concat([Buffer.from("NOPE"), makeOtb().subarray(4)])), OtbFormatError);
  const truncatedEscape = Buffer.concat([
    Buffer.from("OTBI"),
    Buffer.from([0xfe, 0, 0, 0, 0, 0, 0xfd]),
  ]);
  assert.throws(() => OtbDocument.parse(truncatedEscape), /Truncated escape/);
  assert.throws(() => OtbDocument.parse(makeOtb().subarray(0, -1)), /Unterminated/);
});

test("rejects malformed known attributes and configured resource-limit violations", () => {
  const badRoot = Buffer.concat([
    Buffer.from("OTBI"),
    Buffer.from([0xfe]),
    escapeBytes(Buffer.from([0, 0, 0, 0, 0])),
    Buffer.from([0xfe]),
    escapeBytes(Buffer.concat([Buffer.from([1]), u32(0), attribute(0x10, Buffer.from([1]))])),
    Buffer.from([0xff, 0xff]),
  ]);
  assert.throws(() => OtbDocument.parse(badRoot), /must contain two bytes/);
  assert.throws(() => OtbDocument.parse(makeOtb(), { maxFileBytes: 9 }), /file limit/);
  assert.throws(() => OtbDocument.parse(makeOtb(), { maxNodes: 1 }), /Node count exceeds/);
});

test("rejects ambiguous IDs and out-of-range field values", () => {
  const document = OtbDocument.parse(makeOtb());
  assert.throws(() => document.setItemField(999, "name", "missing"), /No OTB item/);
  assert.throws(() => document.setItemField(100, "speed", 65_536), /0 to 65535/);
  assert.throws(() => document.setItemField(100, "name", "not latin-1: \u20ac"), /Latin-1/);
  assert.throws(() => document.setItemField(100, "serverId", 101), /already exists/);
});

test("CLI inspects, round-trips and writes an edited copy without overwriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oteditor-ts-"));
  const input = join(directory, "source.otb");
  const copy = join(directory, "copy.otb");
  const edited = join(directory, "edited.otb");
  const cli = resolve("node_modules/tsx/dist/cli.mjs");
  const entry = resolve("src/cli.ts");

  function invoke(...args: string[]) {
    return spawnSync(process.execPath, [cli, entry, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  }

  try {
    const original = makeOtb();
    await writeFile(input, original);

    const inspected = invoke("inspect", input);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).itemCount, 2);

    const copied = invoke("roundtrip", input, copy);
    assert.equal(copied.status, 0, copied.stderr);
    assert.deepEqual(await readFile(copy), original);

    const editedResult = invoke("set", input, edited, "100", "name", "changed");
    assert.equal(editedResult.status, 0, editedResult.stderr);
    assert.equal(OtbDocument.parse(await readFile(edited)).items[0]!.name, "changed");
    assert.deepEqual(await readFile(input), original);

    const overwrite = invoke("roundtrip", input, copy);
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /Refusing to overwrite/);
    const samePath = invoke("roundtrip", input, input);
    assert.notEqual(samePath.status, 0);
    assert.match(samePath.stderr, /differ from input/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
