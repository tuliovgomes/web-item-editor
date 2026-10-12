import { Buffer } from "node:buffer";
import type { OtfiSettings } from "./otfi.js";

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024 - 1;
const MAX_TOTAL_RECORDS = 262_144;
const MAX_SPRITES_PER_RECORD = 1_048_576;

export type DatCategory = "items" | "outfits" | "effects" | "missiles";

export interface DatParseOptions {
  readonly clientVersion: number;
  readonly otfi?: Pick<OtfiSettings, "extended" | "frameDurations" | "frameGroups">;
  readonly maxFileBytes?: number;
}

export interface DatFrameGroup {
  readonly type: number;
  readonly width: number;
  readonly height: number;
  readonly exactSize: number;
  readonly layers: number;
  readonly patternX: number;
  readonly patternY: number;
  readonly patternZ: number;
  readonly frames: number;
  readonly spriteIds: readonly number[];
  readonly animationData: Buffer;
}

export interface DatGroupSpec {
  readonly width: number;
  readonly height: number;
  readonly exactSize: number;
  readonly layers: number;
  readonly patternX: number;
  readonly patternY: number;
  readonly patternZ: number;
  readonly frames: number;
  readonly spriteIds: readonly number[];
  readonly animation?: {
    readonly mode: number;
    readonly loopCount: number;
    readonly startFrame: number;
    readonly durations: readonly (readonly [number, number])[];
  };
}

export interface DatRecordView {
  readonly id: number;
  readonly category: DatCategory;
  readonly flags: readonly number[];
  readonly properties: Readonly<DatProperties>;
  readonly groups: readonly DatFrameGroup[];
}

interface DatProperties extends Record<string, boolean | number | string> {
  isGround?: boolean;
  isGroundBorder?: boolean;
  isOnBottom?: boolean;
  isOnTop?: boolean;
  isContainer?: boolean;
  isStackable?: boolean;
  isUseable?: boolean;
  isWritable?: boolean;
  writableOnce?: boolean;
  isFluidContainer?: boolean;
  isFluid?: boolean;
  isUnpassable?: boolean;
  isUnmoveable?: boolean;
  blocksMissiles?: boolean;
  blocksPathfinder?: boolean;
  isPickupable?: boolean;
  isHangable?: boolean;
  isVertical?: boolean;
  isHorizontal?: boolean;
  isRotatable?: boolean;
  hasLight?: boolean;
  dontHide?: boolean;
  isTranslucent?: boolean;
  hasOffset?: boolean;
  hasBones?: boolean;
  hasElevation?: boolean;
  isLyingObject?: boolean;
  animateAlways?: boolean;
  hasMinimapColor?: boolean;
  fullGround?: boolean;
  ignoreLook?: boolean;
  floorChange?: boolean;
  forceUse?: boolean;
  hasCloth?: boolean;
  hasMarket?: boolean;
  hasAction?: boolean;
  wrappable?: boolean;
  unwrappable?: boolean;
  topEffect?: boolean;
  chargeable?: boolean;
  noMoveAnimation?: boolean;
  usable?: boolean;
  groundSpeed?: number;
  maxTextLength?: number;
  lightLevel?: number;
  lightColor?: number;
  offsetX?: number;
  offsetY?: number;
  elevation?: number;
  minimapColor?: number;
  lensHelp?: number;
  clothSlot?: number;
  marketCategory?: number;
  marketTradeAs?: number;
  marketShowAs?: number;
  marketVocation?: number;
  marketLevel?: number;
  defaultAction?: number;
  marketName?: string;
}

interface MutableFrameGroup {
  type: number;
  width: number;
  height: number;
  exactSize: number;
  layers: number;
  patternX: number;
  patternY: number;
  patternZ: number;
  frames: number;
  spriteIds: number[];
  animationData: Buffer;
  spriteOffsets: number[];
}

interface MutableRecord {
  category: DatCategory;
  flagBytes: Buffer;
  groupData: Buffer;
  flags: number[];
  properties: DatProperties;
  groups: MutableFrameGroup[];
}

const CATEGORIES: readonly DatCategory[] = ["items", "outfits", "effects", "missiles"];

const CANONICAL_FLAGS = {
  GROUND: 0,
  GROUND_BORDER: 1,
  ON_BOTTOM: 2,
  ON_TOP: 3,
  CONTAINER: 4,
  STACKABLE: 5,
  FORCE_USE: 6,
  MULTI_USE: 7,
  WRITABLE: 8,
  WRITABLE_ONCE: 9,
  FLUID_CONTAINER: 10,
  FLUID: 11,
  UNPASSABLE: 12,
  UNMOVEABLE: 13,
  BLOCK_MISSILE: 14,
  BLOCK_PATHFINDER: 15,
  PICKUPABLE: 16,
  HANGABLE: 17,
  HOOK_SOUTH: 18,
  HOOK_EAST: 19,
  ROTATABLE: 20,
  HAS_LIGHT: 21,
  DONT_HIDE: 22,
  TRANSLUCENT: 23,
  HAS_OFFSET: 24,
  HAS_ELEVATION: 25,
  LYING_OBJECT: 26,
  ANIMATE_ALWAYS: 27,
  MINI_MAP: 28,
  LENS_HELP: 29,
  FULL_GROUND: 30,
  IGNORE_LOOK: 31,
  CLOTH: 32,
  MARKET_ITEM: 33,
  DEFAULT_ACTION: 34,
  WRAPPABLE: 35,
  UNWRAPPABLE: 36,
  TOP_EFFECT: 37,
  NPC_SALE_DATA: 38,
  CHANGER: 39,
  PODIUM: 40,
  USABLE: 41,
  HAS_BONES: 42,
  FLOOR_CHANGE: 252,
  NO_MOVE_ANIMATION: 253,
  CHARGEABLE: 254,
} as const;

export class DatFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatFormatError";
  }
}

function fail(message: string, offset: number): never {
  throw new DatFormatError(`${message} at offset ${offset}`);
}

class DatCursor {
  offset = 0;

  constructor(readonly input: Buffer) {}

  ensure(length: number, description: string): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.input.length - this.offset) {
      fail(`Truncated ${description}`, this.offset);
    }
  }

  readU8(description: string): number {
    this.ensure(1, description);
    return this.input[this.offset++]!;
  }

  readU16(description: string): number {
    this.ensure(2, description);
    const value = this.input.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  readU32(description: string): number {
    this.ensure(4, description);
    const value = this.input.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  skip(length: number, description: string): void {
    this.ensure(length, description);
    this.offset += length;
  }
}

function canonicalFlag(raw: number, clientVersion: number): number {
  if (raw === 0x27 && clientVersion >= 780) return CANONICAL_FLAGS.HAS_BONES;
  if (clientVersion >= 1010) {
    if (raw === 0xfe) return CANONICAL_FLAGS.USABLE;
    if (raw === 16) return CANONICAL_FLAGS.NO_MOVE_ANIMATION;
    return raw > 16 ? raw - 1 : raw;
  }
  if (clientVersion >= 860) return raw;
  if (clientVersion >= 780) {
    if (raw === 8) return CANONICAL_FLAGS.CHARGEABLE;
    return raw > 8 ? raw - 1 : raw;
  }
  return raw === 23 ? CANONICAL_FLAGS.FLOOR_CHANGE : raw;
}

const BOOLEAN_PROPERTIES: Readonly<Record<number, string>> = {
  [CANONICAL_FLAGS.GROUND_BORDER]: "isGroundBorder",
  [CANONICAL_FLAGS.ON_BOTTOM]: "isOnBottom",
  [CANONICAL_FLAGS.ON_TOP]: "isOnTop",
  [CANONICAL_FLAGS.CONTAINER]: "isContainer",
  [CANONICAL_FLAGS.STACKABLE]: "isStackable",
  [CANONICAL_FLAGS.FORCE_USE]: "forceUse",
  [CANONICAL_FLAGS.MULTI_USE]: "isUseable",
  [CANONICAL_FLAGS.FLUID_CONTAINER]: "isFluidContainer",
  [CANONICAL_FLAGS.FLUID]: "isFluid",
  [CANONICAL_FLAGS.UNPASSABLE]: "isUnpassable",
  [CANONICAL_FLAGS.UNMOVEABLE]: "isUnmoveable",
  [CANONICAL_FLAGS.BLOCK_MISSILE]: "blocksMissiles",
  [CANONICAL_FLAGS.BLOCK_PATHFINDER]: "blocksPathfinder",
  [CANONICAL_FLAGS.PICKUPABLE]: "isPickupable",
  [CANONICAL_FLAGS.HANGABLE]: "isHangable",
  [CANONICAL_FLAGS.HOOK_SOUTH]: "isVertical",
  [CANONICAL_FLAGS.HOOK_EAST]: "isHorizontal",
  [CANONICAL_FLAGS.ROTATABLE]: "isRotatable",
  [CANONICAL_FLAGS.DONT_HIDE]: "dontHide",
  [CANONICAL_FLAGS.TRANSLUCENT]: "isTranslucent",
  [CANONICAL_FLAGS.LYING_OBJECT]: "isLyingObject",
  [CANONICAL_FLAGS.ANIMATE_ALWAYS]: "animateAlways",
  [CANONICAL_FLAGS.FULL_GROUND]: "fullGround",
  [CANONICAL_FLAGS.IGNORE_LOOK]: "ignoreLook",
  [CANONICAL_FLAGS.WRAPPABLE]: "wrappable",
  [CANONICAL_FLAGS.UNWRAPPABLE]: "unwrappable",
  [CANONICAL_FLAGS.TOP_EFFECT]: "topEffect",
  [CANONICAL_FLAGS.NPC_SALE_DATA]: "npcSaleData",
  [CANONICAL_FLAGS.CHANGER]: "changer",
  [CANONICAL_FLAGS.PODIUM]: "podium",
  [CANONICAL_FLAGS.USABLE]: "usable",
  [CANONICAL_FLAGS.FLOOR_CHANGE]: "floorChange",
  [CANONICAL_FLAGS.NO_MOVE_ANIMATION]: "noMoveAnimation",
  [CANONICAL_FLAGS.CHARGEABLE]: "chargeable",
  [CANONICAL_FLAGS.HAS_BONES]: "hasBones",
};

const NUMBER_PROPERTIES: Readonly<Record<string, number>> = {
  groundSpeed: CANONICAL_FLAGS.GROUND,
  maxTextLength: CANONICAL_FLAGS.WRITABLE,
  lightLevel: CANONICAL_FLAGS.HAS_LIGHT,
  lightColor: CANONICAL_FLAGS.HAS_LIGHT,
  offsetX: CANONICAL_FLAGS.HAS_OFFSET,
  offsetY: CANONICAL_FLAGS.HAS_OFFSET,
  elevation: CANONICAL_FLAGS.HAS_ELEVATION,
  minimapColor: CANONICAL_FLAGS.MINI_MAP,
  lensHelp: CANONICAL_FLAGS.LENS_HELP,
  clothSlot: CANONICAL_FLAGS.CLOTH,
  marketCategory: CANONICAL_FLAGS.MARKET_ITEM,
  marketTradeAs: CANONICAL_FLAGS.MARKET_ITEM,
  marketShowAs: CANONICAL_FLAGS.MARKET_ITEM,
  marketVocation: CANONICAL_FLAGS.MARKET_ITEM,
  marketLevel: CANONICAL_FLAGS.MARKET_ITEM,
  defaultAction: CANONICAL_FLAGS.DEFAULT_ACTION,
};

const FLAG_PROPERTY: Readonly<Record<number, string>> = {
  [CANONICAL_FLAGS.GROUND]: "isGround",
  [CANONICAL_FLAGS.WRITABLE]: "isWritable",
  [CANONICAL_FLAGS.WRITABLE_ONCE]: "isWritable",
  [CANONICAL_FLAGS.HAS_LIGHT]: "hasLight",
  [CANONICAL_FLAGS.HAS_OFFSET]: "hasOffset",
  [CANONICAL_FLAGS.HAS_ELEVATION]: "hasElevation",
  [CANONICAL_FLAGS.MINI_MAP]: "hasMinimapColor",
  [CANONICAL_FLAGS.CLOTH]: "hasCloth",
  [CANONICAL_FLAGS.MARKET_ITEM]: "hasMarket",
  [CANONICAL_FLAGS.DEFAULT_ACTION]: "hasAction",
};

const BOOLEAN_PROPERTY_NAMES = new Set([
  ...Object.values(BOOLEAN_PROPERTIES),
  "isGround",
  "isWritable",
  "isOnBottom",
  "isOnTop",
  "isContainer",
  "isStackable",
  "isUseable",
  "isFluidContainer",
  "isFluid",
  "isUnpassable",
  "isUnmoveable",
  "blocksMissiles",
  "blocksPathfinder",
  "isPickupable",
  "isHangable",
  "isVertical",
  "isHorizontal",
  "isRotatable",
  "hasLight",
  "hasOffset",
  "hasElevation",
  "hasMinimapColor",
  "hasCloth",
  "hasMarket",
  "hasAction",
  "writableOnce",
]);
const NUMERIC_PROPERTY_NAMES = new Set([
  ...Object.keys(NUMBER_PROPERTIES),
  "boneOffsetX0",
  "boneOffsetY0",
  "boneOffsetX1",
  "boneOffsetY1",
  "boneOffsetX2",
  "boneOffsetY2",
  "boneOffsetX3",
  "boneOffsetY3",
]);
const SIGNED_PROPERTY_NAMES = new Set([
  "offsetX",
  "offsetY",
  "boneOffsetX0",
  "boneOffsetY0",
  "boneOffsetX1",
  "boneOffsetY1",
  "boneOffsetX2",
  "boneOffsetY2",
  "boneOffsetX3",
  "boneOffsetY3",
]);

function readFlagPayload(
  cursor: DatCursor,
  flag: number,
  properties: DatProperties,
  context: { readonly rawFlag: number; readonly category: DatCategory; readonly id: number; readonly clientVersion: number; readonly offset: number },
): void {
  switch (flag) {
    case CANONICAL_FLAGS.GROUND:
      properties.groundSpeed = cursor.readU16("DAT ground speed");
      return;
    case CANONICAL_FLAGS.WRITABLE:
    case CANONICAL_FLAGS.WRITABLE_ONCE:
      properties.isWritable = true;
      properties.writableOnce = flag === CANONICAL_FLAGS.WRITABLE_ONCE;
      properties.maxTextLength = cursor.readU16("DAT maximum text length");
      return;
    case CANONICAL_FLAGS.HAS_ELEVATION:
      properties.elevation = cursor.readU16("DAT elevation");
      return;
    case CANONICAL_FLAGS.MINI_MAP:
      properties.minimapColor = cursor.readU16("DAT minimap color");
      return;
    case CANONICAL_FLAGS.LENS_HELP:
      properties.lensHelp = cursor.readU16("DAT lens help");
      return;
    case CANONICAL_FLAGS.CLOTH:
      properties.clothSlot = cursor.readU16("DAT cloth slot");
      return;
    case CANONICAL_FLAGS.DEFAULT_ACTION:
      properties.defaultAction = cursor.readU16("DAT default action");
      return;
    case CANONICAL_FLAGS.HAS_LIGHT:
      properties.lightLevel = cursor.readU16("DAT light level");
      properties.lightColor = cursor.readU16("DAT light color");
      return;
    case CANONICAL_FLAGS.HAS_OFFSET:
      properties.offsetX = (cursor.readU16("DAT offset X") << 16) >> 16;
      properties.offsetY = (cursor.readU16("DAT offset Y") << 16) >> 16;
      return;
    case CANONICAL_FLAGS.HAS_BONES:
      for (let direction = 0; direction < 4; direction += 1) {
        properties[`boneOffsetX${direction}`] = cursor.readU16("DAT bone offset X") << 16 >> 16;
        properties[`boneOffsetY${direction}`] = cursor.readU16("DAT bone offset Y") << 16 >> 16;
      }
      return;
    case CANONICAL_FLAGS.MARKET_ITEM: {
      properties.marketCategory = cursor.readU16("DAT market category");
      properties.marketTradeAs = cursor.readU16("DAT market trade-as ID");
      properties.marketShowAs = cursor.readU16("DAT market show-as ID");
      const nameLength = cursor.readU16("DAT market-name length");
      cursor.ensure(nameLength, "DAT market-name bytes");
      properties.marketName = cursor.input.toString("latin1", cursor.offset, cursor.offset + nameLength);
      cursor.skip(nameLength, "DAT market-name bytes");
      properties.marketVocation = cursor.readU16("DAT market vocation");
      properties.marketLevel = cursor.readU16("DAT market level");
      return;
    }
    case CANONICAL_FLAGS.GROUND_BORDER:
    case CANONICAL_FLAGS.ON_BOTTOM:
    case CANONICAL_FLAGS.ON_TOP:
    case CANONICAL_FLAGS.CONTAINER:
    case CANONICAL_FLAGS.STACKABLE:
    case CANONICAL_FLAGS.FORCE_USE:
    case CANONICAL_FLAGS.MULTI_USE:
    case CANONICAL_FLAGS.FLUID_CONTAINER:
    case CANONICAL_FLAGS.FLUID:
    case CANONICAL_FLAGS.UNPASSABLE:
    case CANONICAL_FLAGS.UNMOVEABLE:
    case CANONICAL_FLAGS.BLOCK_MISSILE:
    case CANONICAL_FLAGS.BLOCK_PATHFINDER:
    case CANONICAL_FLAGS.PICKUPABLE:
    case CANONICAL_FLAGS.HANGABLE:
    case CANONICAL_FLAGS.HOOK_SOUTH:
    case CANONICAL_FLAGS.HOOK_EAST:
    case CANONICAL_FLAGS.ROTATABLE:
    case CANONICAL_FLAGS.DONT_HIDE:
    case CANONICAL_FLAGS.TRANSLUCENT:
    case CANONICAL_FLAGS.LYING_OBJECT:
    case CANONICAL_FLAGS.ANIMATE_ALWAYS:
    case CANONICAL_FLAGS.FULL_GROUND:
    case CANONICAL_FLAGS.IGNORE_LOOK:
    case CANONICAL_FLAGS.WRAPPABLE:
    case CANONICAL_FLAGS.UNWRAPPABLE:
    case CANONICAL_FLAGS.TOP_EFFECT:
    case CANONICAL_FLAGS.NPC_SALE_DATA:
    case CANONICAL_FLAGS.CHANGER:
    case CANONICAL_FLAGS.PODIUM:
    case CANONICAL_FLAGS.USABLE:
    case CANONICAL_FLAGS.FLOOR_CHANGE:
    case CANONICAL_FLAGS.NO_MOVE_ANIMATION:
    case CANONICAL_FLAGS.CHARGEABLE:
      return;
    default:
      throw new DatFormatError(
        `Unsupported DAT flag ${context.rawFlag} (canonical ${flag}) in ${context.category} record ${context.id} at byte offset ${context.offset} for client version ${context.clientVersion}; verify the client version and OTFI layout. The record cannot be safely delimited.`,
      );
  }
}

const FLAG_ORDER = [
  CANONICAL_FLAGS.GROUND,
  CANONICAL_FLAGS.GROUND_BORDER,
  CANONICAL_FLAGS.ON_BOTTOM,
  CANONICAL_FLAGS.ON_TOP,
  CANONICAL_FLAGS.CONTAINER,
  CANONICAL_FLAGS.STACKABLE,
  CANONICAL_FLAGS.FORCE_USE,
  CANONICAL_FLAGS.MULTI_USE,
  CANONICAL_FLAGS.WRITABLE,
  CANONICAL_FLAGS.FLUID_CONTAINER,
  CANONICAL_FLAGS.FLUID,
  CANONICAL_FLAGS.UNPASSABLE,
  CANONICAL_FLAGS.UNMOVEABLE,
  CANONICAL_FLAGS.BLOCK_MISSILE,
  CANONICAL_FLAGS.BLOCK_PATHFINDER,
  CANONICAL_FLAGS.PICKUPABLE,
  CANONICAL_FLAGS.HANGABLE,
  CANONICAL_FLAGS.HOOK_SOUTH,
  CANONICAL_FLAGS.HOOK_EAST,
  CANONICAL_FLAGS.ROTATABLE,
  CANONICAL_FLAGS.HAS_LIGHT,
  CANONICAL_FLAGS.DONT_HIDE,
  CANONICAL_FLAGS.TRANSLUCENT,
  CANONICAL_FLAGS.HAS_OFFSET,
  CANONICAL_FLAGS.HAS_BONES,
  CANONICAL_FLAGS.HAS_BONES,
  CANONICAL_FLAGS.HAS_ELEVATION,
  CANONICAL_FLAGS.LYING_OBJECT,
  CANONICAL_FLAGS.ANIMATE_ALWAYS,
  CANONICAL_FLAGS.MINI_MAP,
  CANONICAL_FLAGS.LENS_HELP,
  CANONICAL_FLAGS.FULL_GROUND,
  CANONICAL_FLAGS.IGNORE_LOOK,
  CANONICAL_FLAGS.FLOOR_CHANGE,
  CANONICAL_FLAGS.CLOTH,
  CANONICAL_FLAGS.MARKET_ITEM,
  CANONICAL_FLAGS.DEFAULT_ACTION,
  CANONICAL_FLAGS.WRAPPABLE,
  CANONICAL_FLAGS.UNWRAPPABLE,
  CANONICAL_FLAGS.TOP_EFFECT,
  CANONICAL_FLAGS.NPC_SALE_DATA,
  CANONICAL_FLAGS.CHANGER,
  CANONICAL_FLAGS.PODIUM,
  CANONICAL_FLAGS.NO_MOVE_ANIMATION,
  CANONICAL_FLAGS.CHARGEABLE,
  CANONICAL_FLAGS.USABLE,
] as const;

function rawFlag(canonical: number, clientVersion: number): number {
  if (canonical === CANONICAL_FLAGS.HAS_BONES) return 0x27;
  if (clientVersion >= 1010) {
    if (canonical === CANONICAL_FLAGS.USABLE) return 0xfe;
    if (canonical === CANONICAL_FLAGS.NO_MOVE_ANIMATION) return 16;
    return canonical >= 16 && canonical < 252 ? canonical + 1 : canonical;
  }
  if (clientVersion >= 860) return canonical;
  if (clientVersion >= 780) {
    if (canonical === CANONICAL_FLAGS.CHARGEABLE) return 8;
    return canonical >= 8 && canonical < 252 ? canonical + 1 : canonical;
  }
  return canonical === CANONICAL_FLAGS.FLOOR_CHANGE ? 23 : canonical;
}

function writeU16(target: number[], value: number, property: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new DatFormatError(`${property} must be an unsigned 16-bit integer`);
  }
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function propertyNumber(properties: DatProperties, key: string): number {
  const value = properties[key] ?? 0;
  if (typeof value !== "number") throw new DatFormatError(`${key} must be numeric`);
  return value;
}

function activeFlagSet(properties: DatProperties): Set<number> {
  const active = new Set<number>();
  for (const [flagText, property] of Object.entries(BOOLEAN_PROPERTIES)) {
    if (properties[property] === true) active.add(Number(flagText));
  }
  if (properties.isGround === true) active.add(CANONICAL_FLAGS.GROUND);
  if (properties.isWritable === true) {
    active.add(CANONICAL_FLAGS.WRITABLE);
  }
  if (properties.isUseable === true) active.add(CANONICAL_FLAGS.MULTI_USE);
  if (properties.isOnBottom === true) active.add(CANONICAL_FLAGS.ON_BOTTOM);
  if (properties.isOnTop === true) active.add(CANONICAL_FLAGS.ON_TOP);
  if (properties.isContainer === true) active.add(CANONICAL_FLAGS.CONTAINER);
  if (properties.isStackable === true) active.add(CANONICAL_FLAGS.STACKABLE);
  if (properties.isFluidContainer === true) active.add(CANONICAL_FLAGS.FLUID_CONTAINER);
  if (properties.isFluid === true) active.add(CANONICAL_FLAGS.FLUID);
  if (properties.isUnpassable === true) active.add(CANONICAL_FLAGS.UNPASSABLE);
  if (properties.isUnmoveable === true) active.add(CANONICAL_FLAGS.UNMOVEABLE);
  if (properties.blocksMissiles === true) active.add(CANONICAL_FLAGS.BLOCK_MISSILE);
  if (properties.blocksPathfinder === true) active.add(CANONICAL_FLAGS.BLOCK_PATHFINDER);
  if (properties.isPickupable === true) active.add(CANONICAL_FLAGS.PICKUPABLE);
  if (properties.isHangable === true) active.add(CANONICAL_FLAGS.HANGABLE);
  if (properties.isVertical === true) active.add(CANONICAL_FLAGS.HOOK_SOUTH);
  if (properties.isHorizontal === true) active.add(CANONICAL_FLAGS.HOOK_EAST);
  if (properties.isRotatable === true) active.add(CANONICAL_FLAGS.ROTATABLE);
  if (properties.isLyingObject === true) active.add(CANONICAL_FLAGS.LYING_OBJECT);
  if (properties.animateAlways === true) active.add(CANONICAL_FLAGS.ANIMATE_ALWAYS);
  if (properties.fullGround === true) active.add(CANONICAL_FLAGS.FULL_GROUND);
  if (properties.ignoreLook === true) active.add(CANONICAL_FLAGS.IGNORE_LOOK);
  if (properties.floorChange === true) active.add(CANONICAL_FLAGS.FLOOR_CHANGE);
  if (properties.hasLight === true) active.add(CANONICAL_FLAGS.HAS_LIGHT);
  if (properties.hasOffset === true) active.add(CANONICAL_FLAGS.HAS_OFFSET);
  if (properties.hasElevation === true) active.add(CANONICAL_FLAGS.HAS_ELEVATION);
  if (properties.hasMinimapColor === true) active.add(CANONICAL_FLAGS.MINI_MAP);
  if (properties.hasCloth === true) active.add(CANONICAL_FLAGS.CLOTH);
  if (properties.hasMarket === true) active.add(CANONICAL_FLAGS.MARKET_ITEM);
  if (properties.hasAction === true) active.add(CANONICAL_FLAGS.DEFAULT_ACTION);
  if (typeof properties.lensHelp === "number") active.add(CANONICAL_FLAGS.LENS_HELP);

  return active;
}

const PRE_755_FLAGS = new Set<number>([
  CANONICAL_FLAGS.GROUND_BORDER,
  CANONICAL_FLAGS.HANGABLE,
  CANONICAL_FLAGS.HOOK_SOUTH,
  CANONICAL_FLAGS.HOOK_EAST,
]);
const PRE_780_FLAGS = new Set<number>([CANONICAL_FLAGS.DONT_HIDE, CANONICAL_FLAGS.IGNORE_LOOK]);
const WRAP_FLAGS = new Set<number>([
  CANONICAL_FLAGS.WRAPPABLE,
  CANONICAL_FLAGS.UNWRAPPABLE,
  CANONICAL_FLAGS.TOP_EFFECT,
]);

function isFlagSupported(flag: number, clientVersion: number): boolean {
  if (flag === CANONICAL_FLAGS.HAS_BONES && clientVersion < 780) return false;
  if (PRE_755_FLAGS.has(flag) && clientVersion < 755) return false;
  if (PRE_780_FLAGS.has(flag) && clientVersion < 780) return false;
  if (flag === CANONICAL_FLAGS.TRANSLUCENT && clientVersion < 860) return false;
  if (flag === CANONICAL_FLAGS.FLOOR_CHANGE && (clientVersion < 710 || clientVersion > 854)) return false;
  if (flag === CANONICAL_FLAGS.CLOTH && clientVersion < 900) return false;
  if (flag === CANONICAL_FLAGS.MARKET_ITEM && clientVersion < 940) return false;
  if (flag === CANONICAL_FLAGS.DEFAULT_ACTION && clientVersion < 1021) return false;
  if (WRAP_FLAGS.has(flag) && !((clientVersion >= 710 && clientVersion <= 792) || clientVersion >= 1092)) return false;
  if (flag === CANONICAL_FLAGS.CHARGEABLE && !(clientVersion >= 780 && clientVersion <= 854)) return false;
  if (flag === CANONICAL_FLAGS.NO_MOVE_ANIMATION && clientVersion < 1010) return false;
  if (flag === CANONICAL_FLAGS.USABLE && clientVersion < 1021) return false;
  if (flag === CANONICAL_FLAGS.CHARGEABLE && clientVersion >= 855) return false;
  return true;
}

function encodeFlags(properties: DatProperties, clientVersion: number): Buffer {
  const active = activeFlagSet(properties);
  const output: number[] = [];
  for (const flag of FLAG_ORDER) {
    if (!active.has(flag)) continue;
    if (!isFlagSupported(flag, clientVersion)) {
      throw new DatFormatError(`DAT flag ${flag} is not supported by client version ${clientVersion}`);
    }
    const isWritableOnce = flag === CANONICAL_FLAGS.WRITABLE &&
      properties.writableOnce === true;
    output.push(rawFlag(isWritableOnce ? CANONICAL_FLAGS.WRITABLE_ONCE : flag, clientVersion));
    switch (flag) {
      case CANONICAL_FLAGS.GROUND:
        writeU16(output, propertyNumber(properties, "groundSpeed"), "groundSpeed");
        break;
      case CANONICAL_FLAGS.WRITABLE:
        writeU16(output, propertyNumber(properties, "maxTextLength"), "maxTextLength");
        break;
      case CANONICAL_FLAGS.HAS_LIGHT:
        writeU16(output, propertyNumber(properties, "lightLevel"), "lightLevel");
        writeU16(output, propertyNumber(properties, "lightColor"), "lightColor");
        break;
      case CANONICAL_FLAGS.HAS_OFFSET:
        writeU16(output, propertyNumber(properties, "offsetX") & 0xffff, "offsetX");
        writeU16(output, propertyNumber(properties, "offsetY") & 0xffff, "offsetY");
        break;
      case CANONICAL_FLAGS.HAS_BONES:
        for (let direction = 0; direction < 4; direction += 1) {
          writeU16(output, propertyNumber(properties, `boneOffsetX${direction}`) & 0xffff, `boneOffsetX${direction}`);
          writeU16(output, propertyNumber(properties, `boneOffsetY${direction}`) & 0xffff, `boneOffsetY${direction}`);
        }
        break;
      case CANONICAL_FLAGS.HAS_ELEVATION:
        writeU16(output, propertyNumber(properties, "elevation"), "elevation");
        break;
      case CANONICAL_FLAGS.MINI_MAP:
        writeU16(output, propertyNumber(properties, "minimapColor"), "minimapColor");
        break;
      case CANONICAL_FLAGS.LENS_HELP:
        writeU16(output, propertyNumber(properties, "lensHelp"), "lensHelp");
        break;
      case CANONICAL_FLAGS.CLOTH:
        writeU16(output, propertyNumber(properties, "clothSlot"), "clothSlot");
        break;
      case CANONICAL_FLAGS.MARKET_ITEM: {
        writeU16(output, propertyNumber(properties, "marketCategory"), "marketCategory");
        writeU16(output, propertyNumber(properties, "marketTradeAs"), "marketTradeAs");
        writeU16(output, propertyNumber(properties, "marketShowAs"), "marketShowAs");
        const name = properties.marketName ?? "";
        if (typeof name !== "string" || [...name].some((character) => character.codePointAt(0)! > 255)) {
          throw new DatFormatError("marketName must contain only Latin-1 characters");
        }
        const bytes = Buffer.from(name, "latin1");
        writeU16(output, bytes.length, "marketName length");
        output.push(...bytes);
        writeU16(output, propertyNumber(properties, "marketVocation"), "marketVocation");
        writeU16(output, propertyNumber(properties, "marketLevel"), "marketLevel");
        break;
      }
      case CANONICAL_FLAGS.DEFAULT_ACTION:
        writeU16(output, propertyNumber(properties, "defaultAction"), "defaultAction");
        break;
    }
  }
  output.push(0xff);
  return Buffer.from(output);
}

function resolveLayout(options: DatParseOptions): {
  extended: boolean;
  frameDurations: boolean;
  frameGroups: boolean;
} {
  if (!Number.isInteger(options.clientVersion) || options.clientVersion < 1) {
    throw new DatFormatError("clientVersion must be a positive integer");
  }
  return options.otfi === undefined
    ? {
        extended: options.clientVersion >= 960,
        frameDurations: options.clientVersion >= 1050,
        frameGroups: options.clientVersion >= 1057,
      }
    : {
        extended: options.otfi.extended,
        frameDurations: options.otfi.frameDurations,
        frameGroups: options.otfi.frameGroups,
      };
}

function readRecord(
  cursor: DatCursor,
  category: DatCategory,
  id: number,
  options: DatParseOptions,
  layout: ReturnType<typeof resolveLayout>,
): MutableRecord {
  const recordStart = cursor.offset;
  const flags: number[] = [];
  const properties: DatProperties = {};
  while (true) {
    const flagOffset = cursor.offset;
    const raw = cursor.readU8("DAT flag");
    if (raw === 0xff) break;
    const flag = canonicalFlag(raw, options.clientVersion);
    readFlagPayload(cursor, flag, properties, {
      rawFlag: raw,
      category,
      id,
      clientVersion: options.clientVersion,
      offset: flagOffset,
    });
    const booleanProperty = BOOLEAN_PROPERTIES[flag];
    if (booleanProperty !== undefined) properties[booleanProperty] = true;
    const flagProperty = FLAG_PROPERTY[flag];
    if (flagProperty !== undefined) properties[flagProperty] = true;
    flags.push(flag);
    if (cursor.offset <= flagOffset) fail("DAT parser made no progress", flagOffset);
  }

  const groupDataStart = cursor.offset;
  let groupCount = 1;
  if (category === "outfits" && layout.frameGroups) {
    groupCount = cursor.readU8("DAT outfit frame-group count");
    if (groupCount === 0) fail("DAT outfit has zero frame groups", cursor.offset - 1);
  }

  const groups: MutableFrameGroup[] = [];
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const type = category === "outfits" && layout.frameGroups
      ? cursor.readU8("DAT frame-group type")
      : 0;
    const width = cursor.readU8("DAT sprite width");
    const height = cursor.readU8("DAT sprite height");
    if (width === 0 || height === 0) fail("DAT sprite dimensions must be non-zero", cursor.offset - 2);
    const exactSize = width > 1 || height > 1 ? cursor.readU8("DAT exact sprite size") : 32;
    const layers = cursor.readU8("DAT sprite layers");
    const patternX = cursor.readU8("DAT sprite pattern X");
    const patternY = cursor.readU8("DAT sprite pattern Y");
    const patternZ = cursor.readU8("DAT sprite pattern Z");
    const frames = cursor.readU8("DAT animation frame count");
    // Some exports (e.g. decrypted Object Builder sets) keep empty outfit groups with zero frames and no sprite IDs.
    if (layers === 0 || patternX === 0 || patternY === 0 || patternZ === 0) {
      fail("DAT sprite layout dimensions must be non-zero", cursor.offset - 5);
    }

    const animationStart = cursor.offset;
    if (frames > 1 && layout.frameDurations) {
      cursor.skip(6 + frames * 8, "DAT frame-duration data");
    }
    const animationData = Buffer.from(cursor.input.subarray(animationStart, cursor.offset));
    const spriteCount = width * height * layers * patternX * patternY * patternZ * frames;
    if (!Number.isSafeInteger(spriteCount) || spriteCount > MAX_SPRITES_PER_RECORD) {
      fail(`DAT sprite count exceeds limit ${MAX_SPRITES_PER_RECORD}`, cursor.offset);
    }
    const idSize = layout.extended ? 4 : 2;
    cursor.ensure(spriteCount * idSize, "DAT sprite IDs");
    const spriteIds: number[] = [];
    const spriteOffsets: number[] = [];
    for (let index = 0; index < spriteCount; index += 1) {
      spriteOffsets.push(cursor.offset - groupDataStart);
      spriteIds.push(layout.extended
        ? cursor.readU32("DAT extended sprite ID")
        : cursor.readU16("DAT sprite ID"));
    }
    groups.push({
      type,
      width,
      height,
      exactSize,
      layers,
      patternX,
      patternY,
      patternZ,
      frames,
      spriteIds,
      animationData,
      spriteOffsets,
    });
  }

  return {
    category,
    flagBytes: Buffer.from(cursor.input.subarray(recordStart, groupDataStart)),
    groupData: Buffer.from(cursor.input.subarray(groupDataStart, cursor.offset)),
    flags,
    properties,
    groups,
  };
}

function defaultRecord(category: DatCategory, layout: ReturnType<typeof resolveLayout>): MutableRecord {
  const prefix = Buffer.from([0xff]);
  const groupHeader = category === "outfits" && layout.frameGroups ? Buffer.from([1, 0]) : Buffer.alloc(0);
  const metadata = Buffer.from([1, 1, 1, 1, 1, 1, 1]);
  const idSize = layout.extended ? 4 : 2;
  const groupData = Buffer.concat([groupHeader, metadata, Buffer.alloc(idSize)]);
  const spriteOffset = groupHeader.length + metadata.length;
  return {
    category,
    flagBytes: prefix,
    groupData,
    flags: [],
    properties: {},
    groups: [{
      type: 0,
      width: 1,
      height: 1,
      exactSize: 32,
      layers: 1,
      patternX: 1,
      patternY: 1,
      patternZ: 1,
      frames: 1,
      spriteIds: [0],
      animationData: Buffer.alloc(0),
      spriteOffsets: [spriteOffset],
    }],
  };
}

function recordView(record: MutableRecord, id: number): DatRecordView {
  return {
    id,
    category: record.category,
    flags: [...activeFlagSet(record.properties)],
    properties: { ...record.properties },
    groups: record.groups.map((group) => ({
      type: group.type,
      width: group.width,
      height: group.height,
      exactSize: group.exactSize,
      layers: group.layers,
      patternX: group.patternX,
      patternY: group.patternY,
      patternZ: group.patternZ,
      frames: group.frames,
      spriteIds: [...group.spriteIds],
      animationData: Buffer.from(group.animationData),
    })),
  };
}

export class DatDocument {
  readonly #signature: number;
  readonly #layout: ReturnType<typeof resolveLayout>;
  readonly #options: DatParseOptions;
  readonly #records: Record<DatCategory, MutableRecord[]>;
  readonly #original: Buffer;
  #dirty = false;

  private   constructor(
    original: Buffer,
    signature: number,
    layout: ReturnType<typeof resolveLayout>,
    options: DatParseOptions,
    records: Record<DatCategory, MutableRecord[]>,
  ) {
    this.#original = original;
    this.#signature = signature;
    this.#layout = layout;
    this.#options = options;
    this.#records = records;
  }

  static parse(source: Buffer, options: DatParseOptions): DatDocument {
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 12) {
      throw new DatFormatError("maxFileBytes must be an integer of at least 12");
    }
    if (source.length > maxFileBytes) {
      throw new DatFormatError(`DAT file exceeds configured limit ${maxFileBytes}`);
    }
    if (source.length < 12) throw new DatFormatError("DAT header is truncated");
    const layout = resolveLayout(options);
    const cursor = new DatCursor(source);
    const signature = cursor.readU32("DAT signature");
    const maxIds = [
      cursor.readU16("DAT maximum item ID"),
      cursor.readU16("DAT maximum outfit ID"),
      cursor.readU16("DAT maximum effect ID"),
      cursor.readU16("DAT maximum missile ID"),
    ];
    const ranges: readonly [number, number][] = [
      [100, maxIds[0]!],
      [1, maxIds[1]!],
      [1, maxIds[2]!],
      [1, maxIds[3]!],
    ];
    const totalRecords = ranges.reduce(
      (total, [min, max]) => total + (max >= min ? max - min + 1 : 0),
      0,
    );
    if (totalRecords > MAX_TOTAL_RECORDS) {
      throw new DatFormatError(`DAT record count exceeds limit ${MAX_TOTAL_RECORDS}`);
    }
    const records = {
      items: [],
      outfits: [],
      effects: [],
      missiles: [],
    } as Record<DatCategory, MutableRecord[]>;
    CATEGORIES.forEach((category, index) => {
      const [minId, maxId] = ranges[index]!;
      for (let id = minId; id <= maxId; id += 1) {
        records[category].push(readRecord(cursor, category, id, options, layout));
      }
    });
    if (cursor.offset !== source.length) {
      fail("Unexpected trailing DAT data or client-version mismatch", cursor.offset);
    }
    return new DatDocument(Buffer.from(source), signature, layout, options, records);
  }

  static create(signature: number, options: DatParseOptions): DatDocument {
    if (!Number.isInteger(signature) || signature < 0 || signature > 0xffff_ffff) {
      throw new DatFormatError("DAT signature must be an unsigned 32-bit integer");
    }
    resolveLayout(options);
    const records = {
      items: [],
      outfits: [],
      effects: [],
      missiles: [],
    } as Record<DatCategory, MutableRecord[]>;
    const empty = Buffer.alloc(12);
    empty.writeUInt32LE(signature);
    empty.writeUInt16LE(99, 4);
    return new DatDocument(empty, signature, resolveLayout(options), options, records);
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get signature(): number {
    return this.#signature;
  }

  getRecordCount(category: DatCategory): number {
    return this.#records[category].length;
  }

  getRecord(category: DatCategory, id: number): DatRecordView | undefined {
    const index = category === "items" ? id - 100 : id - 1;
    const record = this.#records[category][index];
    return record === undefined ? undefined : recordView(record, id);
  }

  list(category: DatCategory, offset = 0, limit = 100): readonly DatRecordView[] {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 0) {
      throw new DatFormatError("DAT list offset and limit must be non-negative integers");
    }
    const firstId = category === "items" ? 100 : 1;
    return this.#records[category]
      .slice(offset, offset + limit)
      .map((record, index) => recordView(record, firstId + offset + index));
  }

  setSpriteId(category: DatCategory, id: number, groupIndex: number, slot: number, spriteId: number): void {
    if (!Number.isInteger(spriteId) || spriteId < 0 || spriteId > (this.#layout.extended ? 0xffff_ffff : 0xffff)) {
      throw new DatFormatError(`Sprite ID is out of range for ${this.#layout.extended ? "extended" : "legacy"} SPR mode`);
    }
    const index = category === "items" ? id - 100 : id - 1;
    const record = this.#records[category][index];
    if (record === undefined) throw new DatFormatError(`No ${category} record with ID ${id}`);
    const group = record.groups[groupIndex];
    if (group === undefined || !Number.isInteger(slot) || slot < 0 || slot >= group.spriteIds.length) {
      throw new DatFormatError("DAT sprite group or slot is out of range");
    }
    if (group.spriteIds[slot] === spriteId) return;
    group.spriteIds[slot] = spriteId;
    const offset = group.spriteOffsets[slot]!;
    if (this.#layout.extended) record.groupData.writeUInt32LE(spriteId, offset);
    else record.groupData.writeUInt16LE(spriteId, offset);
    this.#dirty = true;
  }

  /** Replaces the whole sprite layout of a record with a single frame group. */
  setFrameGroup(category: DatCategory, id: number, spec: DatGroupSpec): void {
    const index = category === "items" ? id - 100 : id - 1;
    const record = this.#records[category][index];
    if (record === undefined) throw new DatFormatError(`No ${category} record with ID ${id}`);
    const byteFields = [spec.width, spec.height, spec.exactSize, spec.layers, spec.patternX, spec.patternY, spec.patternZ, spec.frames];
    if (byteFields.some((value) => !Number.isInteger(value) || value < 0 || value > 255) ||
      [spec.width, spec.height, spec.layers, spec.patternX, spec.patternY, spec.patternZ, spec.frames].some((value) => value === 0)) {
      throw new DatFormatError("DAT group dimensions must be integers from 1 to 255");
    }
    const expected = spec.width * spec.height * spec.layers * spec.patternX * spec.patternY * spec.patternZ * spec.frames;
    if (expected > MAX_SPRITES_PER_RECORD || spec.spriteIds.length !== expected) {
      throw new DatFormatError(`DAT group needs exactly ${expected} sprite IDs (limit ${MAX_SPRITES_PER_RECORD})`);
    }
    const maxId = this.#layout.extended ? 0xffff_ffff : 0xffff;
    if (spec.spriteIds.some((value) => !Number.isInteger(value) || value < 0 || value > maxId)) {
      throw new DatFormatError("DAT group sprite ID is out of range");
    }
    const withGroups = category === "outfits" && this.#layout.frameGroups;
    const parts: Buffer[] = [];
    if (withGroups) parts.push(Buffer.from([1, 0]));
    parts.push(Buffer.from([spec.width, spec.height]));
    if (spec.width > 1 || spec.height > 1) parts.push(Buffer.from([spec.exactSize]));
    parts.push(Buffer.from([spec.layers, spec.patternX, spec.patternY, spec.patternZ, spec.frames]));
    let animationData: Buffer = Buffer.alloc(0);
    if (spec.frames > 1 && this.#layout.frameDurations) {
      animationData = Buffer.alloc(6 + spec.frames * 8);
      animationData.writeUInt8(spec.animation?.mode ?? 0, 0);
      animationData.writeInt32LE(spec.animation?.loopCount ?? 0, 1);
      animationData.writeInt8(spec.animation?.startFrame ?? 0, 5);
      for (let frame = 0; frame < spec.frames; frame += 1) {
        const [minimum, maximum] = spec.animation?.durations[frame] ?? [500, 500];
        animationData.writeUInt32LE(minimum, 6 + frame * 8);
        animationData.writeUInt32LE(maximum, 10 + frame * 8);
      }
      parts.push(animationData);
    }
    const header = Buffer.concat(parts);
    const idSize = this.#layout.extended ? 4 : 2;
    const ids = Buffer.alloc(spec.spriteIds.length * idSize);
    const offsets: number[] = [];
    spec.spriteIds.forEach((spriteId, slot) => {
      offsets.push(header.length + slot * idSize);
      if (idSize === 4) ids.writeUInt32LE(spriteId, slot * idSize);
      else ids.writeUInt16LE(spriteId, slot * idSize);
    });
    record.groupData = Buffer.concat([header, ids]);
    record.groups = [{
      type: 0,
      width: spec.width,
      height: spec.height,
      exactSize: spec.width > 1 || spec.height > 1 ? spec.exactSize : 32,
      layers: spec.layers,
      patternX: spec.patternX,
      patternY: spec.patternY,
      patternZ: spec.patternZ,
      frames: spec.frames,
      spriteIds: [...spec.spriteIds],
      animationData,
      spriteOffsets: offsets,
    }];
    this.#dirty = true;
  }

  setProperty(category: DatCategory, id: number, name: string, value: boolean | number | string): void {
    const index = category === "items" ? id - 100 : id - 1;
    const record = this.#records[category][index];
    if (record === undefined) throw new DatFormatError(`No ${category} record with ID ${id}`);

    if (BOOLEAN_PROPERTY_NAMES.has(name)) {
      if (typeof value !== "boolean") throw new DatFormatError(`${name} must be boolean`);
      if (name === "isGroundBorder" && this.#options.clientVersion < 755) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (["isHangable", "isHorizontal", "isVertical"].includes(name) && this.#options.clientVersion < 755) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (["dontHide", "ignoreLook"].includes(name) && this.#options.clientVersion < 780) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (name === "isTranslucent" && this.#options.clientVersion < 860) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (name === "floorChange" &&
        (this.#options.clientVersion < 710 || this.#options.clientVersion > 854)) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (name === "hasBones" && this.#options.clientVersion < 780) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (name === "hasCloth" && this.#options.clientVersion < 900) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (name === "hasMarket" && this.#options.clientVersion < 940) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (name === "hasAction" && this.#options.clientVersion < 1021) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (["wrappable", "unwrappable", "topEffect"].includes(name) &&
        !((this.#options.clientVersion >= 710 && this.#options.clientVersion <= 792) ||
          this.#options.clientVersion >= 1092)) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (name === "chargeable" &&
        !(this.#options.clientVersion >= 780 && this.#options.clientVersion <= 854)) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (name === "noMoveAnimation" && this.#options.clientVersion < 1010) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
      if (name === "usable" && this.#options.clientVersion < 1021) {
        throw new DatFormatError(`${name} is unsupported by this client version`);
      }
    } else if (NUMERIC_PROPERTY_NAMES.has(name)) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new DatFormatError(`${name} must be an integer`);
      }
      const minimum = SIGNED_PROPERTY_NAMES.has(name) ? -0x8000 : 0;
      const maximum = SIGNED_PROPERTY_NAMES.has(name) ? 0x7fff : 0xffff;
      if (value < minimum || value > maximum) {
        throw new DatFormatError(`${name} is outside its supported range ${minimum}..${maximum}`);
      }
    } else if (name === "marketName") {
      if (typeof value !== "string" || [...value].some((character) => character.codePointAt(0)! > 255)) {
        throw new DatFormatError("marketName must contain only Latin-1 characters");
      }
      if (this.#options.clientVersion < 940) {
        throw new DatFormatError("marketName is unsupported by this client version");
      }
    } else {
      throw new DatFormatError(`Unsupported DAT property "${name}"`);
    }

    if (record.properties[name] === value) return;
    const nextProperties = { ...record.properties, [name]: value };
    const nextFlags = [...activeFlagSet(nextProperties)];
    const nextBytes = encodeFlags(nextProperties, this.#options.clientVersion);
    record.properties = nextProperties;
    record.flags = nextFlags;
    record.flagBytes = nextBytes;
    this.#dirty = true;
  }

  createRecord(category: DatCategory, sourceId?: number): number {
    const records = this.#records[category];
    const categoryLimit = category === "items" ? 65_436 : 65_535;
    if (records.length >= categoryLimit) throw new DatFormatError(`${category} category is full`);
    let record: MutableRecord;
    if (sourceId === undefined) {
      record = defaultRecord(category, this.#layout);
    } else {
      const index = category === "items" ? sourceId - 100 : sourceId - 1;
      const source = records[index];
      if (source === undefined) throw new DatFormatError(`No ${category} record with ID ${sourceId}`);
      record = {
        category,
        flagBytes: Buffer.from(source.flagBytes),
        groupData: Buffer.from(source.groupData),
        flags: [...source.flags],
        properties: { ...source.properties },
        groups: source.groups.map((group) => ({
          ...group,
          spriteIds: [...group.spriteIds],
          animationData: Buffer.from(group.animationData),
          spriteOffsets: [...group.spriteOffsets],
        })),
      };
    }
    records.push(record);
    this.#dirty = true;
    return (category === "items" ? 100 : 1) + records.length - 1;
  }

  removeRecord(category: DatCategory, id: number): void {
    const index = category === "items" ? id - 100 : id - 1;
    if (!Number.isInteger(index) || index < 0 || index >= this.#records[category].length) {
      throw new DatFormatError(`No ${category} record with ID ${id}`);
    }
    this.#records[category].splice(index, 1);
    this.#dirty = true;
  }

  serialize(): Buffer {
    if (!this.#dirty && this.#original.length >= 10) return Buffer.from(this.#original);
    const maxima = [
      99 + this.#records.items.length,
      this.#records.outfits.length,
      this.#records.effects.length,
      this.#records.missiles.length,
    ];
    if (maxima.some((value) => value > 0xffff)) {
      throw new DatFormatError("DAT category maximum ID exceeds the 16-bit header limit");
    }
    const header = Buffer.alloc(12);
    header.writeUInt32LE(this.#signature, 0);
    maxima.forEach((value, index) => header.writeUInt16LE(value, 4 + index * 2));
    return Buffer.concat([
      header,
      ...CATEGORIES.flatMap((category) =>
        this.#records[category].map((record) => Buffer.concat([
          record.flagBytes,
          record.groupData,
        ]))),
    ]);
  }
}
