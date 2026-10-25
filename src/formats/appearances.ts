import { Buffer } from "node:buffer";

/**
 * Modern Tibia `appearances-<hash>.dat`: a plain (uncompressed) protobuf `Appearances` message.
 * The schema below follows `appearances.proto` as compiled into the OTClient binary shipped with
 * the client. Only the fields the editor shows are decoded; unknown fields are skipped.
 */
const MAX_APPEARANCES = 262_144;
const MAX_SPRITE_IDS = 1_048_576;
const MAX_PHASES = 4096;

export type AppearanceCategory = "items" | "outfits" | "effects" | "missiles";

export class AppearancesFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppearancesFormatError";
  }
}

export interface AppearanceAnimation {
  readonly defaultStartPhase: number;
  readonly synchronized: boolean;
  readonly randomStartPhase: boolean;
  readonly loopType: number;
  readonly loopCount: number;
  readonly phases: readonly (readonly [number, number])[];
}

export interface AppearanceGroup {
  readonly fixedFrameGroup: number;
  readonly patternX: number;
  readonly patternY: number;
  readonly patternZ: number;
  readonly layers: number;
  readonly frames: number;
  readonly spriteIds: readonly number[];
  readonly animation?: AppearanceAnimation;
}

export type FlagValue = boolean | number | string | { readonly [key: string]: FlagValue | FlagValue[] };

export interface Appearance {
  readonly id: number;
  readonly category: AppearanceCategory;
  readonly name?: string;
  readonly description?: string;
  readonly groups: readonly AppearanceGroup[];
  readonly flags: Readonly<Record<string, FlagValue | FlagValue[]>>;
}

type FlagSpec = readonly [name: string, fields?: readonly string[], repeated?: boolean];

// AppearanceFlags field number -> [name, sub-message field names (by field number - 1)].
const FLAG_SPECS: Readonly<Record<number, FlagSpec>> = {
  1: ["bank", ["waypoints"]],
  2: ["clip"], 3: ["bottom"], 4: ["top"], 5: ["container"], 6: ["cumulative"], 7: ["usable"],
  8: ["forceuse"], 9: ["multiuse"],
  10: ["write", ["maxTextLength"]],
  11: ["writeOnce", ["maxTextLengthOnce"]],
  12: ["liquidpool"], 13: ["unpass"], 14: ["unmove"], 15: ["unsight"], 16: ["avoid"],
  17: ["noMovementAnimation"], 18: ["take"], 19: ["liquidcontainer"], 20: ["hang"],
  21: ["hook", ["south", "east"]],
  22: ["rotate"],
  23: ["light", ["brightness", "color"]],
  24: ["dontHide"], 25: ["translucent"],
  26: ["shift", ["x", "y"]],
  27: ["height", ["elevation"]],
  28: ["lyingObject"], 29: ["animateAlways"],
  30: ["automap", ["color"]],
  31: ["lenshelp", ["id"]],
  32: ["fullbank"], 33: ["ignoreLook"],
  34: ["clothes", ["slot"]],
  35: ["defaultAction", ["action"]],
  36: ["market", ["category", "tradeAsObjectId", "showAsObjectId", "name", "restrictToProfession", "minimumLevel"]],
  37: ["wrap"], 38: ["unwrap"], 39: ["topeffect"],
  40: ["npcSaleData", ["name", "location", "salePrice", "buyPrice", "currencyObjectTypeId", "currencyQuestFlagDisplayName"], true],
  41: ["changedToExpire", ["formerObjectTypeId"]],
  42: ["corpse"], 43: ["playerCorpse"],
  44: ["cyclopediaItem", ["cyclopediaType"]],
  45: ["ammo"], 46: ["showOffSocket"], 47: ["reportable"],
  48: ["upgradeClassification", ["upgradeClassification"]],
  49: ["reverseAddonsEast"], 50: ["reverseAddonsWest"], 51: ["reverseAddonsSouth"], 52: ["reverseAddonsNorth"],
  53: ["wearout"], 54: ["clockexpire"], 55: ["expire"], 56: ["expirestop"], 57: ["decoKit"],
  58: ["skillwheelGem"],
  59: ["dualWielding"],
  60: ["imbueable"],
  61: ["proficiency"],
  62: ["restrictToVocation"],
  63: ["minimumLevel"],
  64: ["weaponType"],
  70: ["hookSouth"], 71: ["hookEast"],
  72: ["transparencyLevel", ["level"]],
};

const FLAG_NUMBER_FIELDS = new Set([62, 63, 64]);

interface Span {
  readonly start: number;
  readonly end: number;
}

class Reader {
  pos: number;

  constructor(readonly buffer: Buffer, start: number, readonly end: number) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let multiplier = 1;
    for (let index = 0; index < 10; index += 1) {
      if (this.pos >= this.end) throw new AppearancesFormatError("Varint truncado em appearances.dat.");
      const byte = this.buffer[this.pos]!;
      this.pos += 1;
      if (index === 9) {
        // 10-byte varints encode negative int32/int64 values (e.g. loop_type = -1).
        return byte === 1 && result >= 2 ** 63 - 1 ? -1 : result;
      }
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return result;
      multiplier *= 128;
    }
    return result;
  }

  /** Reads one field header and its value: a number for varints, a span for length-delimited data. */
  field(): { number: number; value: number | Span | undefined } {
    const key = this.varint();
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) return { number, value: this.varint() };
    if (wire === 2) {
      const length = this.varint();
      if (this.pos + length > this.end) throw new AppearancesFormatError("Campo truncado em appearances.dat.");
      const span = { start: this.pos, end: this.pos + length };
      this.pos += length;
      return { number, value: span };
    }
    const skip = wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (skip < 0 || this.pos + skip > this.end) throw new AppearancesFormatError(`Tipo de campo protobuf inválido (${wire}).`);
    this.pos += skip;
    return { number, value: undefined };
  }

  sub(span: Span): Reader {
    return new Reader(this.buffer, span.start, span.end);
  }

  text(span: Span): string {
    return this.buffer.toString("utf8", span.start, span.end);
  }
}

function isSpan(value: number | Span | undefined): value is Span {
  return typeof value === "object";
}

function parseMessageFields(reader: Reader, span: Span, names: readonly string[]): Record<string, FlagValue> {
  const result: Record<string, FlagValue> = {};
  const sub = reader.sub(span);
  while (!sub.done) {
    const { number, value } = sub.field();
    const name = names[number - 1];
    if (name === undefined || value === undefined) continue;
    result[name] = isSpan(value) ? sub.text(value) : value;
  }
  return result;
}

function parseFlags(reader: Reader, span: Span): Appearance["flags"] {
  const flags: Record<string, FlagValue | FlagValue[]> = {};
  const sub = reader.sub(span);
  while (!sub.done) {
    const { number, value } = sub.field();
    const spec = FLAG_SPECS[number];
    if (spec === undefined || value === undefined) continue;
    const [name, fields, repeated] = spec;
    let decoded: FlagValue;
    if (fields !== undefined && isSpan(value)) decoded = parseMessageFields(sub, value, fields);
    else if (FLAG_NUMBER_FIELDS.has(number) && typeof value === "number") {
      const previous = flags[name];
      flags[name] = Array.isArray(previous) ? [...previous, value] : name === "restrictToVocation" ? [value] : value;
      continue;
    } else decoded = typeof value === "number" ? value !== 0 : true;
    if (repeated === true) {
      const previous = flags[name];
      flags[name] = [...(Array.isArray(previous) ? previous : []), decoded];
    } else flags[name] = decoded;
  }
  return flags;
}

function parseAnimation(reader: Reader, span: Span): AppearanceAnimation {
  const sub = reader.sub(span);
  let defaultStartPhase = 0;
  let synchronized = false;
  let randomStartPhase = false;
  let loopType = 0;
  let loopCount = 0;
  const phases: [number, number][] = [];
  while (!sub.done) {
    const { number, value } = sub.field();
    if (number === 1 && typeof value === "number") defaultStartPhase = value;
    else if (number === 2 && typeof value === "number") synchronized = value !== 0;
    else if (number === 3 && typeof value === "number") randomStartPhase = value !== 0;
    else if (number === 4 && typeof value === "number") loopType = value;
    else if (number === 5 && typeof value === "number") loopCount = value;
    else if (number === 6 && isSpan(value)) {
      if (phases.length >= MAX_PHASES) throw new AppearancesFormatError("Animação com fases demais.");
      const phase = parseMessageFields(sub, value, ["min", "max"]);
      phases.push([Number(phase["min"] ?? 0), Number(phase["max"] ?? 0)]);
    }
  }
  return { defaultStartPhase, synchronized, randomStartPhase, loopType, loopCount, phases };
}

function parseFrameGroup(reader: Reader, span: Span): AppearanceGroup | undefined {
  const sub = reader.sub(span);
  let fixedFrameGroup = 0;
  let info: Span | undefined;
  while (!sub.done) {
    const { number, value } = sub.field();
    if (number === 1 && typeof value === "number") fixedFrameGroup = value;
    else if (number === 3 && isSpan(value)) info = value;
  }
  if (info === undefined) return undefined;

  const infoReader = reader.sub(info);
  let patternX = 1;
  let patternY = 1;
  let patternZ = 1;
  let layers = 1;
  const spriteIds: number[] = [];
  let animation: AppearanceAnimation | undefined;
  while (!infoReader.done) {
    const { number, value } = infoReader.field();
    if (number === 1 && typeof value === "number") patternX = Math.max(1, value);
    else if (number === 2 && typeof value === "number") patternY = Math.max(1, value);
    else if (number === 3 && typeof value === "number") patternZ = Math.max(1, value);
    else if (number === 4 && typeof value === "number") layers = Math.max(1, value);
    else if (number === 5) {
      if (typeof value === "number") spriteIds.push(value);
      else if (isSpan(value)) {
        const packed = infoReader.sub(value);
        while (!packed.done) spriteIds.push(packed.varint());
      }
      if (spriteIds.length > MAX_SPRITE_IDS) throw new AppearancesFormatError("Objeto com sprites demais.");
    } else if (number === 6 && isSpan(value)) animation = parseAnimation(infoReader, value);
  }
  const perFrame = patternX * patternY * patternZ * layers;
  const frames = Math.max(1, animation?.phases.length || Math.floor(spriteIds.length / perFrame) || 1);
  return {
    fixedFrameGroup,
    patternX,
    patternY,
    patternZ,
    layers,
    frames,
    spriteIds,
    ...(animation === undefined ? {} : { animation }),
  };
}

function parseAppearance(reader: Reader, span: Span, category: AppearanceCategory): Appearance {
  const sub = reader.sub(span);
  let id = 0;
  let name: string | undefined;
  let description: string | undefined;
  let flags: Appearance["flags"] = {};
  const groups: AppearanceGroup[] = [];
  while (!sub.done) {
    const { number, value } = sub.field();
    if (number === 1 && typeof value === "number") id = value;
    else if (number === 2 && isSpan(value)) {
      const group = parseFrameGroup(sub, value);
      if (group !== undefined) groups.push(group);
    } else if (number === 3 && isSpan(value)) flags = parseFlags(sub, value);
    else if (number === 4 && isSpan(value)) name = sub.text(value);
    else if (number === 5 && isSpan(value)) description = sub.text(value);
  }
  return {
    id,
    category,
    groups,
    flags,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
}

const CATEGORY_FIELDS: Readonly<Record<number, AppearanceCategory>> = {
  1: "items",
  2: "outfits",
  3: "effects",
  4: "missiles",
};

export class AppearanceLibrary {
  private constructor(private readonly byCategory: Readonly<Record<AppearanceCategory, Appearance[]>>) {}

  static parse(buffer: Buffer): AppearanceLibrary {
    const byCategory: Record<AppearanceCategory, Appearance[]> = { items: [], outfits: [], effects: [], missiles: [] };
    const reader = new Reader(buffer, 0, buffer.length);
    let total = 0;
    while (!reader.done) {
      const { number, value } = reader.field();
      const category = CATEGORY_FIELDS[number];
      if (category === undefined || !isSpan(value)) continue;
      total += 1;
      if (total > MAX_APPEARANCES) throw new AppearancesFormatError("appearances.dat tem registros demais.");
      byCategory[category].push(parseAppearance(reader, value, category));
    }
    if (total === 0) throw new AppearancesFormatError("appearances.dat não contém nenhum objeto.");
    return new AppearanceLibrary(byCategory);
  }

  get counts(): Record<AppearanceCategory, number> {
    return {
      items: this.byCategory.items.length,
      outfits: this.byCategory.outfits.length,
      effects: this.byCategory.effects.length,
      missiles: this.byCategory.missiles.length,
    };
  }

  list(category: AppearanceCategory, search?: string): Appearance[] {
    const all = this.byCategory[category];
    if (search === undefined || search === "") return all;
    const needle = search.toLowerCase();
    return all.filter((entry) => String(entry.id).includes(needle) || (entry.name?.toLowerCase().includes(needle) ?? false));
  }

  get(category: AppearanceCategory, id: number): Appearance | undefined {
    return this.byCategory[category].find((entry) => entry.id === id);
  }
}
