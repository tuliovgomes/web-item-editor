import { Buffer } from "node:buffer";
import { compress, decompress } from "lzma";
import type { DatCategory, DatGroupSpec, DatRecordView } from "./dat.js";

/**
 * Object Builder Data (OBD) version 2: a little-endian payload compressed as LZMA "alone"
 * (13-byte header: properties, dictionary size, 64-bit uncompressed size).
 * Layout reference: ottools/ObjectBuilder, src/otlib/obd/OBDEncoder.as.
 */
export const OBD_VERSION_2 = 200;
const MAX_OBD_SPRITES = 4096;
const MAX_OBD_BYTES = 64 * 1024 * 1024;
const OBD_SPRITE_SIZE = 32;
const OBD_PIXEL_BYTES = OBD_SPRITE_SIZE * OBD_SPRITE_SIZE * 4;
const LAST_FLAG = 0xff;

const CATEGORY_VALUES: Readonly<Record<DatCategory, number>> = { items: 1, outfits: 2, effects: 3, missiles: 4 };
const CATEGORY_BY_VALUE: Readonly<Record<number, DatCategory>> = { 1: "items", 2: "outfits", 3: "effects", 4: "missiles" };

export class ObdFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObdFormatError";
  }
}

type PropertyValue = boolean | number | string;

// OBD flag byte -> editor boolean property. Flags that carry a payload are handled separately.
const SIMPLE_FLAGS: readonly (readonly [number, string])[] = [
  [0x01, "isGroundBorder"],
  [0x02, "isOnBottom"],
  [0x03, "isOnTop"],
  [0x04, "isContainer"],
  [0x05, "isStackable"],
  [0x06, "forceUse"],
  [0x07, "isUseable"],
  [0x0a, "isFluidContainer"],
  [0x0b, "isFluid"],
  [0x0c, "isUnpassable"],
  [0x0d, "isUnmoveable"],
  [0x0e, "blocksMissiles"],
  [0x0f, "blocksPathfinder"],
  [0x10, "noMoveAnimation"],
  [0x11, "isPickupable"],
  [0x12, "isHangable"],
  [0x13, "isVertical"],
  [0x14, "isHorizontal"],
  [0x15, "isRotatable"],
  [0x17, "dontHide"],
  [0x18, "isTranslucent"],
  [0x1b, "isLyingObject"],
  [0x1c, "animateAlways"],
  [0x1f, "fullGround"],
  [0x20, "ignoreLook"],
  [0x24, "wrappable"],
  [0x25, "unwrappable"],
  [0x26, "topEffect"],
  [0xfc, "chargeable"],
  [0xfd, "floorChange"],
  [0xfe, "usable"],
];

// Editor properties that OBD v2 has no flag for; exporting them loses information.
const UNREPRESENTABLE = ["hasBones", "npcSaleData", "changer", "podium"];

export interface ObdEncodeInput {
  readonly record: DatRecordView;
  readonly clientVersion: number;
  readonly spriteSize: number;
  /** Returns RGBA pixels, or undefined for an empty/missing sprite. */
  readonly getSprite: (id: number) => Buffer | undefined;
}

export interface ObdEncodeResult {
  readonly data: Buffer;
  readonly warnings: readonly string[];
}

class Writer {
  readonly #bytes: number[] = [];
  u8(value: number): void { this.#bytes.push(value & 0xff); }
  u16(value: number): void { this.u8(value); this.u8(value >> 8); }
  u32(value: number): void { this.u16(value); this.u16(value >>> 16); }
  raw(buffer: Uint8Array): void { for (const byte of buffer) this.#bytes.push(byte); }
  get length(): number { return this.#bytes.length; }
  patchU32(position: number, value: number): void {
    for (let index = 0; index < 4; index += 1) this.#bytes[position + index] = (value >>> (index * 8)) & 0xff;
  }
  toBuffer(): Buffer { return Buffer.from(this.#bytes); }
}

function flag(properties: Readonly<Record<string, PropertyValue>>, name: string): boolean {
  return properties[name] === true;
}

function num(properties: Readonly<Record<string, PropertyValue>>, name: string): number {
  const value = properties[name];
  return typeof value === "number" ? value : 0;
}

function writeProperties(output: Writer, properties: Readonly<Record<string, PropertyValue>>): void {
  if (flag(properties, "isGround")) {
    output.u8(0x00);
    output.u16(num(properties, "groundSpeed"));
  }
  for (const [code, name] of SIMPLE_FLAGS) {
    if (code === 0x0a) {
      if (flag(properties, "isWritable")) {
        output.u8(flag(properties, "writableOnce") ? 0x09 : 0x08);
        output.u16(num(properties, "maxTextLength"));
      }
    }
    if (code === 0x17 && flag(properties, "hasLight")) {
      output.u8(0x16);
      output.u16(num(properties, "lightLevel"));
      output.u16(num(properties, "lightColor"));
    }
    if (code === 0x1b && flag(properties, "hasOffset")) {
      output.u8(0x19);
      output.u16(num(properties, "offsetX"));
      output.u16(num(properties, "offsetY"));
    }
    if (code === 0x1b && flag(properties, "hasElevation")) {
      output.u8(0x1a);
      output.u16(num(properties, "elevation"));
    }
    if (code === 0x1f) {
      if (flag(properties, "hasMinimapColor")) {
        output.u8(0x1d);
        output.u16(num(properties, "minimapColor"));
      }
      if (typeof properties["lensHelp"] === "number") {
        output.u8(0x1e);
        output.u16(num(properties, "lensHelp"));
      }
    }
    if (code === 0x24) {
      if (flag(properties, "hasCloth")) {
        output.u8(0x21);
        output.u16(num(properties, "clothSlot"));
      }
      if (flag(properties, "hasMarket")) {
        const name = Buffer.from(String(properties["marketName"] ?? ""), "latin1");
        output.u8(0x22);
        output.u16(num(properties, "marketCategory"));
        output.u16(num(properties, "marketTradeAs"));
        output.u16(num(properties, "marketShowAs"));
        output.u16(name.length);
        output.raw(name);
        output.u16(num(properties, "marketVocation"));
        output.u16(num(properties, "marketLevel"));
      }
      if (flag(properties, "hasAction")) {
        output.u8(0x23);
        output.u16(num(properties, "defaultAction"));
      }
    }
    if (flag(properties, name)) output.u8(code);
  }
  output.u8(LAST_FLAG);
}

function toLzma(raw: Buffer): Buffer {
  const packed = compress(raw, 1);
  return Buffer.from(Int8Array.from(packed).buffer);
}

export function encodeObd(input: ObdEncodeInput): ObdEncodeResult {
  const { record, clientVersion } = input;
  if (input.spriteSize !== OBD_SPRITE_SIZE) {
    throw new ObdFormatError(`OBD only stores ${OBD_SPRITE_SIZE}×${OBD_SPRITE_SIZE} sprites; this project uses ${input.spriteSize}`);
  }
  const group = record.groups[0];
  if (group === undefined) throw new ObdFormatError("Record has no sprite group");
  if (group.spriteIds.length > MAX_OBD_SPRITES) throw new ObdFormatError(`OBD supports at most ${MAX_OBD_SPRITES} sprites per object`);
  const warnings: string[] = [];
  if (record.groups.length > 1) {
    warnings.push(`${record.category} ${record.id}: OBD v2 guarda um grupo de frames; ${record.groups.length - 1} grupo(s) adicional(is) foram omitidos.`);
  }
  const lost = UNREPRESENTABLE.filter((name) => record.properties[name] === true);
  if (lost.length > 0) warnings.push(`${record.category} ${record.id}: propriedades sem equivalente no OBD v2 foram omitidas (${lost.join(", ")}).`);

  const output = new Writer();
  output.u16(OBD_VERSION_2);
  output.u16(clientVersion);
  output.u8(CATEGORY_VALUES[record.category]);
  const patternsPosition = output.length;
  output.u32(0);
  writeProperties(output, record.properties as Readonly<Record<string, PropertyValue>>);
  output.patchU32(patternsPosition, output.length);

  output.u8(group.width);
  output.u8(group.height);
  if (group.width > 1 || group.height > 1) output.u8(group.exactSize);
  output.u8(group.layers);
  output.u8(group.patternX);
  output.u8(group.patternY);
  output.u8(group.patternZ);
  output.u8(group.frames);
  if (group.frames > 1) {
    const animation = group.animationData;
    if (animation.length >= 6 + group.frames * 8) {
      output.u8(animation.readUInt8(0));
      output.u32(animation.readInt32LE(1));
      output.u8(animation.readInt8(5));
      for (let frame = 0; frame < group.frames; frame += 1) {
        output.u32(animation.readUInt32LE(6 + frame * 8));
        output.u32(animation.readUInt32LE(10 + frame * 8));
      }
    } else {
      output.u8(0);
      output.u32(0);
      output.u8(0);
      for (let frame = 0; frame < group.frames; frame += 1) {
        output.u32(500);
        output.u32(500);
      }
    }
  }

  const empty = Buffer.alloc(OBD_PIXEL_BYTES);
  for (const spriteId of group.spriteIds) {
    const rgba = spriteId === 0 ? undefined : input.getSprite(spriteId);
    if (rgba !== undefined && rgba.length !== OBD_PIXEL_BYTES) throw new ObdFormatError(`Sprite ${spriteId} has an unexpected size`);
    const source = rgba ?? empty;
    const argb = Buffer.alloc(OBD_PIXEL_BYTES);
    for (let offset = 0; offset < OBD_PIXEL_BYTES; offset += 4) {
      argb[offset] = source[offset + 3]!;
      argb[offset + 1] = source[offset]!;
      argb[offset + 2] = source[offset + 1]!;
      argb[offset + 3] = source[offset + 2]!;
    }
    output.u32(spriteId);
    output.raw(argb);
  }
  return { data: toLzma(output.toBuffer()), warnings };
}

export interface ObdThing {
  readonly obdVersion: number;
  readonly clientVersion: number;
  readonly category: DatCategory;
  readonly properties: Readonly<Record<string, PropertyValue>>;
  /** Group layout; spriteIds are the IDs used inside the file (indices into `sprites`). */
  readonly group: DatGroupSpec;
  /** Distinct sprites keyed by their id inside the OBD file, as RGBA. */
  readonly sprites: ReadonlyMap<number, Buffer>;
}

class Reader {
  offset = 0;
  constructor(readonly buffer: Buffer) {}
  need(length: number): void {
    if (length < 0 || this.offset + length > this.buffer.length) throw new ObdFormatError("OBD data is truncated");
  }
  u8(): number { this.need(1); return this.buffer[this.offset++]!; }
  u16(): number { this.need(2); const value = this.buffer.readUInt16LE(this.offset); this.offset += 2; return value; }
  i16(): number { this.need(2); const value = this.buffer.readInt16LE(this.offset); this.offset += 2; return value; }
  u32(): number { this.need(4); const value = this.buffer.readUInt32LE(this.offset); this.offset += 4; return value; }
  i32(): number { this.need(4); const value = this.buffer.readInt32LE(this.offset); this.offset += 4; return value; }
  bytes(length: number): Buffer { this.need(length); const value = this.buffer.subarray(this.offset, this.offset + length); this.offset += length; return value; }
}

function fromLzma(file: Buffer): Buffer {
  if (file.length < 14) throw new ObdFormatError("File is too small to be an OBD");
  const sizeLow = file.readUInt32LE(5);
  const sizeHigh = file.readUInt32LE(9);
  if (sizeHigh !== 0 || sizeLow === 0 || sizeLow > MAX_OBD_BYTES) {
    throw new ObdFormatError("File is not a valid LZMA-compressed OBD (unexpected uncompressed size)");
  }
  let result: number[] | string;
  try {
    result = decompress(Int8Array.from(file));
  } catch (error) {
    throw new ObdFormatError(`Could not decompress OBD: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof result === "string") throw new ObdFormatError("Decompressed OBD is not binary data");
  if (result.length !== sizeLow) throw new ObdFormatError("Decompressed OBD length does not match its header");
  return Buffer.from(Uint8Array.from(result, (value) => value & 0xff));
}

export function decodeObd(file: Buffer): ObdThing {
  const reader = new Reader(fromLzma(file));
  const obdVersion = reader.u16();
  if (obdVersion !== OBD_VERSION_2) {
    throw new ObdFormatError(obdVersion >= 710
      ? "OBD v1 files are not supported yet; re-export the object from Object Builder as OBD v2"
      : `Unsupported OBD version ${obdVersion}`);
  }
  const clientVersion = reader.u16();
  const category = CATEGORY_BY_VALUE[reader.u8()];
  if (category === undefined) throw new ObdFormatError("OBD has an invalid object category");
  reader.u32(); // offset of the texture patterns; recomputed on write

  const properties: Record<string, PropertyValue> = {};
  const simple = new Map(SIMPLE_FLAGS);
  for (;;) {
    const code = reader.u8();
    if (code === LAST_FLAG) break;
    const name = simple.get(code);
    if (name !== undefined) {
      properties[name] = true;
      continue;
    }
    switch (code) {
      case 0x00: properties["isGround"] = true; properties["groundSpeed"] = reader.u16(); break;
      case 0x08:
      case 0x09:
        properties["isWritable"] = true;
        properties["writableOnce"] = code === 0x09;
        properties["maxTextLength"] = reader.u16();
        break;
      case 0x16: properties["hasLight"] = true; properties["lightLevel"] = reader.u16(); properties["lightColor"] = reader.u16(); break;
      case 0x19: properties["hasOffset"] = true; properties["offsetX"] = reader.i16(); properties["offsetY"] = reader.i16(); break;
      case 0x1a: properties["hasElevation"] = true; properties["elevation"] = reader.u16(); break;
      case 0x1d: properties["hasMinimapColor"] = true; properties["minimapColor"] = reader.u16(); break;
      case 0x1e: properties["lensHelp"] = reader.u16(); break;
      case 0x21: properties["hasCloth"] = true; properties["clothSlot"] = reader.u16(); break;
      case 0x22: {
        properties["hasMarket"] = true;
        properties["marketCategory"] = reader.u16();
        properties["marketTradeAs"] = reader.u16();
        properties["marketShowAs"] = reader.u16();
        properties["marketName"] = reader.bytes(reader.u16()).toString("latin1");
        properties["marketVocation"] = reader.u16();
        properties["marketLevel"] = reader.u16();
        break;
      }
      case 0x23: properties["hasAction"] = true; properties["defaultAction"] = reader.u16(); break;
      default:
        throw new ObdFormatError(`OBD contains unknown flag 0x${code.toString(16)}`);
    }
  }

  const width = reader.u8();
  const height = reader.u8();
  const exactSize = width > 1 || height > 1 ? reader.u8() : 32;
  const layers = reader.u8();
  const patternX = reader.u8();
  const patternY = reader.u8();
  const patternZ = reader.u8();
  const frames = reader.u8();
  if ([width, height, layers, patternX, patternY, patternZ, frames].some((value) => value === 0)) {
    throw new ObdFormatError("OBD sprite layout dimensions must be non-zero");
  }
  let animation: DatGroupSpec["animation"];
  if (frames > 1) {
    const mode = reader.u8();
    const loopCount = reader.i32();
    const startFrame = reader.u8() << 24 >> 24;
    const durations: [number, number][] = [];
    for (let frame = 0; frame < frames; frame += 1) durations.push([reader.u32(), reader.u32()]);
    animation = { mode, loopCount, startFrame, durations };
  }
  const total = width * height * layers * patternX * patternY * patternZ * frames;
  if (total > MAX_OBD_SPRITES) throw new ObdFormatError(`OBD has more than ${MAX_OBD_SPRITES} sprites`);
  reader.need(total * (4 + OBD_PIXEL_BYTES));

  const spriteIds: number[] = [];
  const sprites = new Map<number, Buffer>();
  for (let index = 0; index < total; index += 1) {
    const id = reader.u32();
    const argb = reader.bytes(OBD_PIXEL_BYTES);
    spriteIds.push(id);
    if (sprites.has(id)) continue;
    const rgba = Buffer.alloc(OBD_PIXEL_BYTES);
    for (let offset = 0; offset < OBD_PIXEL_BYTES; offset += 4) {
      rgba[offset] = argb[offset + 1]!;
      rgba[offset + 1] = argb[offset + 2]!;
      rgba[offset + 2] = argb[offset + 3]!;
      rgba[offset + 3] = argb[offset]!;
    }
    sprites.set(id, rgba);
  }
  if (reader.offset !== reader.buffer.length) throw new ObdFormatError("OBD has unexpected trailing data");

  return {
    obdVersion,
    clientVersion,
    category,
    properties,
    group: {
      width,
      height,
      exactSize,
      layers,
      patternX,
      patternY,
      patternZ,
      frames,
      spriteIds,
      ...(animation === undefined ? {} : { animation }),
    },
    sprites,
  };
}
