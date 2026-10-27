import { Buffer } from "node:buffer";
import { compress, decompress } from "lzma";
import type { Appearance, FlagValue } from "./appearances.js";
import type { DatCategory, DatGroupSpec, DatRecordView } from "./dat.js";
import { checkOutfitAnimation, compareAnimations, type AnimationGroup, type AnimationReport } from "./animation-check.js";

/**
 * Object Builder Data (OBD): a little-endian payload compressed as LZMA "alone"
 * (13-byte header: properties, dictionary size, 64-bit uncompressed size).
 * Layout reference: ottools/ObjectBuilder, src/otlib/obd/OBDEncoder.as (checked against the `encodeV2`,
 * `encodeV3` and `decodeV3` bytecode shipped in Object Builder 0.5.5).
 * - v2 stores one frame group; each sprite is `u32 id` + 4096 ARGB bytes.
 * - v3 adds, for outfits only, a `u8` group count and a `u8` type before each group (Object Builder reads groups
 *   by position and ignores the type), and each sprite is `u32 id` + `u32 length` (4096) + ARGB bytes.
 * The encoders write v3 only when an object has more than one frame group (outfits with idle and walking
 * animations), so everything else stays readable by older Object Builder releases.
 */
export const OBD_VERSION_2 = 200;
export const OBD_VERSION_3 = 300;
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

/** LZMA mode 1 is the fastest preset of the pure-JS encoder; mode 5 was ~2.7x slower on sprite data. */
export const OBD_COMPRESSION_LEVEL = 1;

export function compressObd(raw: Buffer, level: number = OBD_COMPRESSION_LEVEL): Buffer {
  const packed = compress(raw, level);
  return Buffer.from(Int8Array.from(packed).buffer);
}

export interface ObdPayload {
  /** Uncompressed OBD payload; `compressObd` turns it into the final file. */
  readonly raw: Buffer;
  readonly warnings: string[];
  readonly spriteCount: number;
  /** What the export check confirmed (e.g. "2 grupos · 4 direções · andando 8 frames"), when it ran. */
  readonly validation?: string;
}

export function encodeObd(input: ObdEncodeInput, level: number = OBD_COMPRESSION_LEVEL): ObdEncodeResult {
  const payload = buildObdPayload(input);
  return { data: compressObd(payload.raw, level), warnings: payload.warnings };
}

interface ObdGroupLayout {
  readonly width: number;
  readonly height: number;
  readonly exactSize: number;
  readonly layers: number;
  readonly patternX: number;
  readonly patternY: number;
  readonly patternZ: number;
  readonly frames: number;
  readonly animation?: {
    readonly mode: number;
    readonly loopCount: number;
    readonly startFrame: number;
    readonly durations: readonly (readonly [number, number])[];
  };
}

function writeHeader(output: Writer, version: number, clientVersion: number, category: DatCategory, properties: Readonly<Record<string, PropertyValue>>): void {
  output.u16(version);
  output.u16(clientVersion);
  output.u8(CATEGORY_VALUES[category]);
  const patternsPosition = output.length;
  output.u32(0);
  writeProperties(output, properties);
  output.patchU32(patternsPosition, output.length);
}

function writeGroupLayout(output: Writer, group: ObdGroupLayout): void {
  output.u8(group.width);
  output.u8(group.height);
  if (group.width > 1 || group.height > 1) output.u8(group.exactSize);
  output.u8(group.layers);
  output.u8(group.patternX);
  output.u8(group.patternY);
  output.u8(group.patternZ);
  output.u8(group.frames);
  if (group.frames > 1) {
    output.u8(group.animation?.mode ?? 0);
    output.u32(group.animation?.loopCount ?? 0);
    output.u8(group.animation?.startFrame ?? 0);
    for (let frame = 0; frame < group.frames; frame += 1) {
      const [minimum, maximum] = group.animation?.durations[frame] ?? [500, 500];
      output.u32(minimum);
      output.u32(maximum);
    }
  }
}

function writeSprite(output: Writer, version: number, id: number, rgba: Buffer | undefined): void {
  const argb = Buffer.alloc(OBD_PIXEL_BYTES);
  if (rgba !== undefined) {
    for (let offset = 0; offset < OBD_PIXEL_BYTES; offset += 4) {
      argb[offset] = rgba[offset + 3]!;
      argb[offset + 1] = rgba[offset]!;
      argb[offset + 2] = rgba[offset + 1]!;
      argb[offset + 3] = rgba[offset + 2]!;
    }
  }
  output.u32(id);
  if (version === OBD_VERSION_3) output.u32(OBD_PIXEL_BYTES);
  output.raw(argb);
}

/** Writes the group count and, before each group, its type (Object Builder writes the index; 1 for a lone group). */
function groupPrefix(output: Writer, version: number, category: DatCategory, count: number, index: number): void {
  if (version !== OBD_VERSION_3 || category !== "outfits") return;
  if (index === 0) output.u8(count);
  output.u8(count < 2 ? 1 : index);
}

/** Frame-duration block of a DAT group, as stored after the frame count (6 + 8 × frames bytes). */
function datAnimation(group: DatRecordView["groups"][number]): ObdGroupLayout["animation"] {
  const data = group.animationData;
  if (group.frames <= 1 || data.length < 6 + group.frames * 8) return undefined;
  const durations: [number, number][] = [];
  for (let frame = 0; frame < group.frames; frame += 1) durations.push([data.readUInt32LE(6 + frame * 8), data.readUInt32LE(10 + frame * 8)]);
  return { mode: data.readUInt8(0), loopCount: data.readInt32LE(1), startFrame: data.readInt8(5), durations };
}

export function buildObdPayload(input: ObdEncodeInput): ObdPayload {
  const { record, clientVersion } = input;
  if (input.spriteSize !== OBD_SPRITE_SIZE) {
    throw new ObdFormatError(`OBD only stores ${OBD_SPRITE_SIZE}×${OBD_SPRITE_SIZE} sprites; this project uses ${input.spriteSize}`);
  }
  const groups = record.groups;
  if (groups.length === 0) throw new ObdFormatError("Record has no sprite group");
  for (const group of groups) {
    if (group.spriteIds.length > MAX_OBD_SPRITES) throw new ObdFormatError(`OBD supports at most ${MAX_OBD_SPRITES} sprites per frame group`);
  }
  const version = groups.length > 1 ? OBD_VERSION_3 : OBD_VERSION_2;
  const warnings: string[] = [];
  const lost = UNREPRESENTABLE.filter((name) => record.properties[name] === true);
  if (lost.length > 0) warnings.push(`${record.category} ${record.id}: propriedades sem equivalente no OBD foram omitidas (${lost.join(", ")}).`);

  const output = new Writer();
  writeHeader(output, version, clientVersion, record.category, record.properties as Readonly<Record<string, PropertyValue>>);
  let spriteCount = 0;
  groups.forEach((group, index) => {
    groupPrefix(output, version, record.category, groups.length, index);
    const animation = datAnimation(group);
    writeGroupLayout(output, { ...group, ...(animation === undefined ? {} : { animation }) });
    for (const spriteId of group.spriteIds) {
      const rgba = spriteId === 0 ? undefined : input.getSprite(spriteId);
      if (rgba !== undefined && rgba.length !== OBD_PIXEL_BYTES) throw new ObdFormatError(`Sprite ${spriteId} has an unexpected size`);
      writeSprite(output, version, spriteId, rgba);
      spriteCount += 1;
    }
  });
  return { raw: output.toBuffer(), warnings, spriteCount };
}

const MODERN_BOOLEAN_FLAGS: readonly (readonly [string, string])[] = [
  ["clip", "isGroundBorder"], ["bottom", "isOnBottom"], ["top", "isOnTop"], ["container", "isContainer"],
  ["cumulative", "isStackable"], ["usable", "usable"], ["forceuse", "forceUse"], ["multiuse", "isUseable"],
  ["liquidpool", "isFluid"], ["liquidcontainer", "isFluidContainer"], ["unpass", "isUnpassable"],
  ["unmove", "isUnmoveable"], ["unsight", "blocksMissiles"], ["avoid", "blocksPathfinder"],
  ["noMovementAnimation", "noMoveAnimation"], ["take", "isPickupable"], ["hang", "isHangable"],
  ["rotate", "isRotatable"], ["dontHide", "dontHide"], ["translucent", "isTranslucent"],
  ["lyingObject", "isLyingObject"], ["animateAlways", "animateAlways"], ["fullbank", "fullGround"],
  ["ignoreLook", "ignoreLook"], ["wrap", "wrappable"], ["unwrap", "unwrappable"], ["topeffect", "topEffect"],
];

/** Maps modern AppearanceFlags to the editor property names that `writeProperties` understands. */
function modernProperties(flags: Appearance["flags"]): Record<string, PropertyValue> {
  const properties: Record<string, PropertyValue> = {};
  const group = (name: string): Readonly<Record<string, FlagValue>> | undefined => {
    const value = flags[name];
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, FlagValue>> : undefined;
  };
  const numeric = (value: FlagValue | undefined): number => (typeof value === "number" ? value : 0);
  for (const [modern, editor] of MODERN_BOOLEAN_FLAGS) if (flags[modern] === true) properties[editor] = true;

  const bank = group("bank");
  if (bank !== undefined) { properties["isGround"] = true; properties["groundSpeed"] = numeric(bank["waypoints"]); }
  const write = group("write");
  const writeOnce = group("writeOnce");
  if (write !== undefined || writeOnce !== undefined) {
    properties["isWritable"] = true;
    properties["writableOnce"] = writeOnce !== undefined;
    properties["maxTextLength"] = numeric((writeOnce ?? write)?.[writeOnce !== undefined ? "maxTextLengthOnce" : "maxTextLength"]);
  }
  const hook = group("hook");
  if (flags["hookSouth"] === true || (hook !== undefined && hook["south"] !== undefined)) properties["isVertical"] = true;
  if (flags["hookEast"] === true || (hook !== undefined && hook["east"] !== undefined)) properties["isHorizontal"] = true;
  const light = group("light");
  if (light !== undefined) {
    properties["hasLight"] = true;
    properties["lightLevel"] = numeric(light["brightness"]);
    properties["lightColor"] = numeric(light["color"]);
  }
  const shift = group("shift");
  if (shift !== undefined) { properties["hasOffset"] = true; properties["offsetX"] = numeric(shift["x"]); properties["offsetY"] = numeric(shift["y"]); }
  const height = group("height");
  if (height !== undefined) { properties["hasElevation"] = true; properties["elevation"] = numeric(height["elevation"]); }
  const automap = group("automap");
  if (automap !== undefined) { properties["hasMinimapColor"] = true; properties["minimapColor"] = numeric(automap["color"]); }
  const lens = group("lenshelp");
  if (lens !== undefined) properties["lensHelp"] = numeric(lens["id"]);
  const clothes = group("clothes");
  if (clothes !== undefined) { properties["hasCloth"] = true; properties["clothSlot"] = numeric(clothes["slot"]); }
  const action = group("defaultAction");
  if (action !== undefined) { properties["hasAction"] = true; properties["defaultAction"] = numeric(action["action"]); }
  const market = group("market");
  if (market !== undefined) {
    properties["hasMarket"] = true;
    properties["marketCategory"] = numeric(market["category"]);
    properties["marketTradeAs"] = numeric(market["tradeAsObjectId"]);
    properties["marketShowAs"] = numeric(market["showAsObjectId"]);
    properties["marketName"] = typeof market["name"] === "string" ? market["name"] : "";
    properties["marketLevel"] = numeric(market["minimumLevel"]);
  }
  return properties;
}

export interface ModernObdInput {
  readonly appearance: Appearance;
  readonly clientVersion: number;
  /** Returns the sprite's RGBA pixels and size, or undefined when it is missing. */
  readonly getSprite: (id: number) => { width: number; height: number; rgba: Buffer } | undefined;
}

const MODERN_LOST_FLAGS = ["npcSaleData", "changedToExpire", "cyclopediaItem", "upgradeClassification", "skillwheelGem", "imbueable", "proficiency", "transparencyLevel", "weaponType"];

/** One 32×32 cell of a larger sprite in DAT order: row/column 0 is the bottom-right corner of the image. */
function cutCell(sprite: { width: number; rgba: Buffer }, cellsWide: number, cellsHigh: number, row: number, column: number): Buffer {
  const cell = Buffer.alloc(OBD_PIXEL_BYTES);
  const left = (cellsWide - 1 - column) * OBD_SPRITE_SIZE;
  const top = (cellsHigh - 1 - row) * OBD_SPRITE_SIZE;
  for (let y = 0; y < OBD_SPRITE_SIZE; y += 1) {
    const start = ((top + y) * sprite.width + left) * 4;
    sprite.rgba.copy(cell, y * OBD_SPRITE_SIZE * 4, start, start + OBD_SPRITE_SIZE * 4);
  }
  return cell;
}

function modernAnimation(group: Appearance["groups"][number]): ObdGroupLayout["animation"] {
  if (group.frames <= 1) return undefined;
  const animation = group.animation;
  const durations: [number, number][] = [];
  for (let frame = 0; frame < group.frames; frame += 1) {
    const phase = animation?.phases[frame];
    durations.push([phase?.[0] ?? 500, phase?.[1] ?? 500]);
  }
  return {
    mode: animation?.synchronized === true ? 1 : 0,
    loopCount: animation === undefined || animation.loopType === 0 ? 0 : animation.loopType < 0 ? -1 : animation.loopCount,
    startFrame: animation?.randomStartPhase === true ? -1 : (animation?.defaultStartPhase ?? 0),
    durations,
  };
}

/**
 * Builds an OBD payload from a modern appearance, keeping every frame group (idle and walking for outfits).
 * OBD only stores 32x32 sprites, so each larger sprite is cut into 32x32 cells, ordered as the legacy DAT does
 * (frame, z, y, x, layer, then cell row and column, with column 0 at the right edge of the image).
 */
export function buildModernObdPayload(input: ModernObdInput): ObdPayload {
  const { appearance, clientVersion } = input;
  // The client's fixed frame group (0 idle, 1 moving) is the group's position in the legacy formats.
  const groups = [...appearance.groups].sort((a, b) => a.fixedFrameGroup - b.fixedFrameGroup);
  if (groups.length === 0) throw new ObdFormatError("O objeto não tem grupo de frames");
  if (groups.length > 1 && appearance.category !== "outfits") throw new ObdFormatError("Somente outfits podem ter mais de um grupo de frames no OBD");
  const warnings: string[] = [];
  const label = `${appearance.category} ${appearance.id}`;
  const lost = MODERN_LOST_FLAGS.filter((name) => appearance.flags[name] !== undefined);
  if (lost.length > 0) warnings.push(`${label}: flags sem equivalente no OBD foram omitidas (${lost.join(", ")}).`);
  const version = groups.length > 1 ? OBD_VERSION_3 : OBD_VERSION_2;

  const layouts = groups.map((group, groupIndex) => {
    let cellsWide = 1;
    let cellsHigh = 1;
    for (const id of group.spriteIds) {
      const sprite = id === 0 ? undefined : input.getSprite(id);
      if (sprite !== undefined) {
        cellsWide = Math.max(1, sprite.width / OBD_SPRITE_SIZE);
        cellsHigh = Math.max(1, sprite.height / OBD_SPRITE_SIZE);
        break;
      }
    }
    const cellCount = group.spriteIds.length * cellsWide * cellsHigh;
    const where = groups.length > 1 ? ` no grupo ${groupIndex + 1}` : "";
    if (cellCount > MAX_OBD_SPRITES) {
      throw new ObdFormatError(`OBD suporta no máximo ${MAX_OBD_SPRITES} sprites por grupo (${label} precisaria de ${cellCount}${where})`);
    }
    if (cellsWide > 255 || cellsHigh > 255 || group.patternX > 255 || group.patternY > 255 || group.patternZ > 255 || group.layers > 255 || group.frames > 255) {
      throw new ObdFormatError("O padrão do objeto excede os limites do OBD");
    }
    return { group, cellsWide, cellsHigh };
  });

  const output = new Writer();
  writeHeader(output, version, clientVersion, appearance.category, modernProperties(appearance.flags));
  let cellIndex = 0;
  layouts.forEach(({ group, cellsWide, cellsHigh }, groupIndex) => {
    groupPrefix(output, version, appearance.category, groups.length, groupIndex);
    const animation = modernAnimation(group);
    writeGroupLayout(output, {
      width: cellsWide,
      height: cellsHigh,
      exactSize: Math.max(cellsWide, cellsHigh) * OBD_SPRITE_SIZE,
      layers: group.layers,
      patternX: group.patternX,
      patternY: group.patternY,
      patternZ: group.patternZ,
      frames: group.frames,
      ...(animation === undefined ? {} : { animation }),
    });
    for (const spriteId of group.spriteIds) {
      const sprite = spriteId === 0 ? undefined : input.getSprite(spriteId);
      if (sprite !== undefined && (sprite.width !== cellsWide * OBD_SPRITE_SIZE || sprite.height !== cellsHigh * OBD_SPRITE_SIZE)) {
        throw new ObdFormatError(`Sprite ${spriteId} tem tamanho diferente das outras sprites do grupo`);
      }
      for (let row = 0; row < cellsHigh; row += 1) {
        for (let column = 0; column < cellsWide; column += 1) {
          cellIndex += 1;
          if (sprite === undefined) {
            writeSprite(output, version, 0, undefined);
            continue;
          }
          const cell = cutCell(sprite, cellsWide, cellsHigh, row, column);
          const blank = cell.every((byte, offset) => offset % 4 !== 3 || byte === 0);
          writeSprite(output, version, blank ? 0 : cellIndex, blank ? undefined : cell);
        }
      }
    }
  });
  return { raw: output.toBuffer(), warnings, spriteCount: cellIndex };
}

export interface ObdThing {
  readonly obdVersion: number;
  readonly clientVersion: number;
  readonly category: DatCategory;
  readonly properties: Readonly<Record<string, PropertyValue>>;
  /** First frame group (the only one in v2); spriteIds are the IDs used inside the file (keys of `sprites`). */
  readonly group: DatGroupSpec;
  /** Every frame group in file order (idle then walking for v3 outfits), with `type` set to the position. */
  readonly groups: readonly DatGroupSpec[];
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
  return decodeObdPayload(fromLzma(file));
}

/** Parses an uncompressed OBD payload (what `build*ObdPayload` returns before `compressObd`). */
export function decodeObdPayload(raw: Buffer): ObdThing {
  const reader = new Reader(raw);
  const obdVersion = reader.u16();
  if (obdVersion !== OBD_VERSION_2 && obdVersion !== OBD_VERSION_3) {
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

  // v3 outfits carry a group count and, before each group, a type byte that Object Builder itself ignores.
  const groupCount = obdVersion === OBD_VERSION_3 && category === "outfits" ? reader.u8() : 1;
  if (groupCount === 0) throw new ObdFormatError("OBD outfit has no frame groups");
  const groups: DatGroupSpec[] = [];
  const sprites = new Map<number, Buffer>();
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    if (obdVersion === OBD_VERSION_3 && category === "outfits") reader.u8();
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
    if (total > MAX_OBD_SPRITES) throw new ObdFormatError(`OBD has more than ${MAX_OBD_SPRITES} sprites in a frame group`);
    const spriteBytes = obdVersion === OBD_VERSION_3 ? 8 + OBD_PIXEL_BYTES : 4 + OBD_PIXEL_BYTES;
    reader.need(total * spriteBytes);

    const spriteIds: number[] = [];
    for (let index = 0; index < total; index += 1) {
      const id = reader.u32();
      if (obdVersion === OBD_VERSION_3 && reader.u32() !== OBD_PIXEL_BYTES) throw new ObdFormatError("OBD sprite has an invalid pixel data size");
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
    groups.push({
      ...(groupCount > 1 ? { type: groupIndex } : {}),
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
    });
  }
  if (reader.offset !== reader.buffer.length) throw new ObdFormatError("OBD has unexpected trailing data");

  return { obdVersion, clientVersion, category, properties, group: groups[0]!, groups, sprites };
}

/* ---------- Export checks: decode what was just built and compare it with the source ---------- */

function decodedGroups(thing: ObdThing): AnimationGroup[] {
  return thing.groups.map((group) => ({ ...group, ...(group.animation === undefined ? {} : { durations: group.animation.durations }) }));
}

function decodedPixels(thing: ObdThing): (id: number) => Buffer | undefined {
  return (id) => thing.sprites.get(id);
}

/** Frame groups of a DAT record in the shape the animation checks use (with its frame durations, if any). */
export function datAnimationGroups(record: DatRecordView): AnimationGroup[] {
  return record.groups.map((group) => {
    const animation = datAnimation(group);
    return { ...group, ...(animation === undefined ? {} : { durations: animation.durations }) };
  });
}

function report(label: string, category: DatCategory, groups: AnimationGroup[], pixels: (id: number) => Buffer | undefined, errors: string[]): AnimationReport {
  const animation = category === "outfits"
    ? checkOutfitAnimation(label, groups, pixels)
    : { errors: [], warnings: [], summary: `${groups.length} grupo(s) · ${groups[0]?.frames ?? 0} frame(s)` };
  return { errors: [...errors, ...animation.errors], warnings: animation.warnings, summary: animation.summary };
}

/**
 * Checks a legacy export: the payload must decode back to the record's exact groups, layout, durations and pixels
 * (so no frame, direction or sprite was dropped or swapped), and an outfit's movement is checked.
 */
export function validateObdPayload(input: ObdEncodeInput, payload: ObdPayload): AnimationReport {
  const label = `${input.record.category} ${input.record.id}`;
  const decoded = decodeObdPayload(payload.raw);
  const groups = datAnimationGroups(input.record);
  const pixels = (id: number) => (id === 0 ? undefined : input.getSprite(id));
  const errors = compareAnimations(label, { groups, pixels }, { groups: decodedGroups(decoded), pixels: decodedPixels(decoded) });
  return report(label, input.record.category, groups, pixels, errors);
}

/** Same check for an export from the client catalog, whose large sprites were cut into 32×32 cells. */
export function validateModernObdPayload(input: ModernObdInput, payload: ObdPayload): AnimationReport {
  const { appearance } = input;
  const label = `${appearance.category} ${appearance.id}`;
  const decoded = decodeObdPayload(payload.raw);
  const sorted = [...appearance.groups].sort((a, b) => a.fixedFrameGroup - b.fixedFrameGroup);
  const cells = new Map<number, Buffer>();
  let next = 0;
  const expected: AnimationGroup[] = sorted.map((group, groupIndex) => {
    const width = decoded.groups[groupIndex]?.width ?? 1;
    const height = decoded.groups[groupIndex]?.height ?? 1;
    const spriteIds: number[] = [];
    for (const spriteId of group.spriteIds) {
      const sprite = spriteId === 0 ? undefined : input.getSprite(spriteId);
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          next += 1;
          spriteIds.push(next);
          if (sprite !== undefined) cells.set(next, cutCell(sprite, width, height, row, column));
        }
      }
    }
    const animation = modernAnimation(group);
    return {
      width, height, layers: group.layers, patternX: group.patternX, patternY: group.patternY, patternZ: group.patternZ,
      frames: group.frames, spriteIds, ...(animation === undefined ? {} : { durations: animation.durations }),
    };
  });
  const errors = compareAnimations(label, { groups: expected, pixels: (id) => cells.get(id) }, { groups: decodedGroups(decoded), pixels: decodedPixels(decoded) });
  // The movement is judged on the client's own sprites (one whole image per slot).
  const whole = sorted.map((group) => {
    const animation = modernAnimation(group);
    return {
      width: 1, height: 1, layers: group.layers, patternX: group.patternX, patternY: group.patternY, patternZ: group.patternZ,
      frames: group.frames, spriteIds: group.spriteIds, ...(animation === undefined ? {} : { durations: animation.durations }),
    };
  });
  return report(label, appearance.category, whole, (id) => (id === 0 ? undefined : input.getSprite(id)?.rgba), errors);
}
