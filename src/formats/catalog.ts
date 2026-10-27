import { Buffer } from "node:buffer";
import { decompress } from "lzma";
import { AppearanceLibrary } from "./appearances.js";

/**
 * Modern Tibia client sprite library: `catalog-content.json` lists `sprites-<hash>.bmp.lzma`
 * sheets. Each sheet is a 384x384 32-bit BMP holding a grid of sprites in row-major order,
 * numbered from `firstspriteid` to `lastspriteid`. The sheet's LZMA stream is wrapped in a
 * CipSoft header: zero padding, five constant bytes, a 7-bit varint with the compressed size,
 * then the LZMA properties without the 8-byte uncompressed size field.
 */
const SHEET_SIZE = 384;
const BMP_HEADER_BYTES = 122;
const SHEET_BMP_BYTES = BMP_HEADER_BYTES + SHEET_SIZE * SHEET_SIZE * 4;
const CIP_CONSTANT_BYTES = 5;
const LZMA_PROPERTY_BYTES = 5;
const MAX_CATALOG_ENTRIES = 65_536;
const MAX_CACHED_SHEETS = 24;

/**
 * Sprite pixel size (width, height) per catalog `spritetype`. Types 0–3 are the classic layouts; newer clients
 * (e.g. 15.x) also use the extended layouts 4–35 — every width/height pair of 32, 64, 96, 128, 192 and 384 that
 * tiles a 384×384 sheet — for large outfits, mounts and effects. The order matches OTClient's `SpriteLayout`.
 */
const SPRITE_SIDES = [32, 64, 96, 128, 192, 384] as const;
const SPRITE_DIMENSIONS: readonly (readonly [number, number])[] = [
  [32, 32], [32, 64], [64, 32], [64, 64],
  ...SPRITE_SIDES.flatMap((width) => SPRITE_SIDES
    .filter((height) => !(width <= 64 && height <= 64))
    .map((height) => [width, height] as const)),
];

export class CatalogFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogFormatError";
  }
}

export interface CatalogSheetEntry {
  readonly file: string;
  readonly spriteType: number;
  readonly firstSpriteId: number;
  readonly lastSpriteId: number;
  readonly width: number;
  readonly height: number;
}

export interface CatalogSprite {
  readonly width: number;
  readonly height: number;
  readonly rgba: Buffer;
}

export interface CatalogSummary {
  readonly sheetCount: number;
  readonly loadedSheets: number;
  readonly spriteCount: number;
  readonly lastSpriteId: number;
  /** Merged, ascending inclusive ID ranges that have a sheet entry. */
  readonly ranges: readonly (readonly [number, number])[];
  readonly appearancesFile?: string;
  readonly appearances?: { readonly items: number; readonly outfits: number; readonly effects: number; readonly missiles: number };
}

export function parseCatalogContent(json: string): { sheets: CatalogSheetEntry[]; appearancesFile?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CatalogFormatError("catalog-content.json não é um JSON válido.");
  }
  if (!Array.isArray(parsed)) throw new CatalogFormatError("catalog-content.json deve conter uma lista.");
  if (parsed.length > MAX_CATALOG_ENTRIES * 2) throw new CatalogFormatError("catalog-content.json tem entradas demais.");

  const sheets: CatalogSheetEntry[] = [];
  let appearancesFile: string | undefined;
  for (const entry of parsed as Record<string, unknown>[]) {
    if (entry === null || typeof entry !== "object") continue;
    if (entry["type"] === "appearances" && typeof entry["file"] === "string") appearancesFile = entry["file"];
    if (entry["type"] !== "sprite") continue;
    const { file, spritetype: spriteType, firstspriteid: first, lastspriteid: last } = entry;
    if (typeof file !== "string" || !isSafeFileName(file)) throw new CatalogFormatError("Nome de arquivo de sprite inválido no catálogo.");
    if (typeof spriteType !== "number" || typeof first !== "number" || typeof last !== "number") {
      throw new CatalogFormatError(`Entrada de sprite malformada: ${file}`);
    }
    const dimensions = SPRITE_DIMENSIONS[spriteType];
    if (dimensions === undefined) throw new CatalogFormatError(`Tipo de sprite desconhecido (${spriteType}) em ${file}`);
    // Some official sheets declare one ID more than they hold; that last ID simply has no pixels.
    const capacity = (SHEET_SIZE / dimensions[0]) * (SHEET_SIZE / dimensions[1]) + 1;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || last - first + 1 > capacity) {
      throw new CatalogFormatError(`Intervalo de sprites inválido em ${file}`);
    }
    sheets.push({ file, spriteType, firstSpriteId: first, lastSpriteId: last, width: dimensions[0], height: dimensions[1] });
  }
  if (sheets.length === 0) throw new CatalogFormatError("O catálogo não lista nenhuma folha de sprites.");
  return appearancesFile === undefined ? { sheets } : { sheets, appearancesFile };
}

function isSafeFileName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.startsWith(".");
}

/** Decodes one `.bmp.lzma` sheet into top-down RGBA pixels. */
export function decodeSheet(file: Buffer): { width: number; height: number; rgba: Buffer } {
  let offset = 0;
  while (offset < file.length && file[offset] === 0) offset += 1;
  offset += CIP_CONSTANT_BYTES;
  while (offset < file.length && (file[offset]! & 0x80) !== 0) offset += 1;
  offset += 1;
  if (offset + LZMA_PROPERTY_BYTES + 8 >= file.length) throw new CatalogFormatError("Folha de sprites truncada.");

  // The sheet carries no uncompressed size, so rebuild a standard LZMA-alone header around it.
  const stream = Buffer.alloc(13 + file.length - offset - LZMA_PROPERTY_BYTES - 8);
  file.copy(stream, 0, offset, offset + LZMA_PROPERTY_BYTES);
  stream.writeBigUInt64LE(BigInt(SHEET_BMP_BYTES), LZMA_PROPERTY_BYTES);
  file.copy(stream, 13, offset + LZMA_PROPERTY_BYTES + 8);

  let output: number[] | string;
  try {
    output = decompress(Int8Array.from(stream));
  } catch (error) {
    throw new CatalogFormatError(`Falha ao descomprimir a folha: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof output === "string") throw new CatalogFormatError("A folha descomprimida não é binária.");
  const bmp = Buffer.from(Uint8Array.from(output, (value) => value & 0xff));
  return decodeBmp(bmp);
}

function decodeBmp(bmp: Buffer): { width: number; height: number; rgba: Buffer } {
  if (bmp.length < BMP_HEADER_BYTES || bmp.readUInt16LE(0) !== 0x4d42) throw new CatalogFormatError("Folha não contém um BMP válido.");
  const pixelOffset = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18);
  const signedHeight = bmp.readInt32LE(22);
  const bitCount = bmp.readUInt16LE(28);
  const compression = bmp.readUInt32LE(30);
  const height = Math.abs(signedHeight);
  if (bitCount !== 32 || (compression !== 0 && compression !== 3)) throw new CatalogFormatError("Somente BMP de 32 bits é suportado.");
  if (width <= 0 || width > 4096 || height <= 0 || height > 4096) throw new CatalogFormatError("Dimensões de BMP inválidas.");
  if (pixelOffset + width * height * 4 > bmp.length) throw new CatalogFormatError("BMP truncado.");

  const masks = compression === 3
    ? [bmp.readUInt32LE(54), bmp.readUInt32LE(58), bmp.readUInt32LE(62), bmp.readUInt32LE(66)]
    : [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000];
  const shifts = masks.map((mask) => (mask === 0 ? 0 : Math.clz32(mask & -mask) ^ 31));
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const source = pixelOffset + (signedHeight > 0 ? height - 1 - row : row) * width * 4;
    for (let column = 0; column < width; column += 1) {
      const pixel = bmp.readUInt32LE(source + column * 4);
      const target = (row * width + column) * 4;
      rgba[target] = (pixel & masks[0]!) >>> shifts[0]!;
      rgba[target + 1] = (pixel & masks[1]!) >>> shifts[1]!;
      rgba[target + 2] = (pixel & masks[2]!) >>> shifts[2]!;
      rgba[target + 3] = masks[3] === 0 ? 255 : (pixel & masks[3]!) >>> shifts[3]!;
      // Magenta is the sheets' transparency key (as in the client and OTClient), whatever its alpha says.
      if (rgba[target] === 0xff && rgba[target + 1] === 0 && rgba[target + 2] === 0xff) rgba.fill(0, target, target + 4);
    }
  }
  return { width, height, rgba };
}

/** Read-only view over a catalog's sprite sheets. Sheets are held compressed and decoded on demand. */
export class SpriteCatalog {
  private readonly sheets: readonly CatalogSheetEntry[];
  private readonly files = new Map<string, Buffer>();
  private readonly decoded = new Map<string, { width: number; height: number; rgba: Buffer }>();
  private readonly byFile = new Map<string, CatalogSheetEntry>();
  readonly appearancesFile: string | undefined;
  appearances: AppearanceLibrary | undefined;

  constructor(catalogJson: string) {
    const parsed = parseCatalogContent(catalogJson);
    this.sheets = [...parsed.sheets].sort((a, b) => a.firstSpriteId - b.firstSpriteId);
    this.appearancesFile = parsed.appearancesFile;
    for (const sheet of this.sheets) this.byFile.set(sheet.file, sheet);
  }

  /** File names the catalog expects to be uploaded. */
  get requiredFiles(): string[] {
    return this.sheets.map((sheet) => sheet.file);
  }

  addSheet(name: string, data: Buffer): boolean {
    if (!this.byFile.has(name)) return false;
    this.files.set(name, data);
    this.decoded.delete(name);
    return true;
  }

  get summary(): CatalogSummary {
    const lastSpriteId = this.sheets.reduce((max, sheet) => Math.max(max, sheet.lastSpriteId), 0);
    const spriteCount = this.sheets.reduce((sum, sheet) => sum + sheet.lastSpriteId - sheet.firstSpriteId + 1, 0);
    const ranges: [number, number][] = [];
    for (const sheet of this.sheets) {
      const previous = ranges.at(-1);
      if (previous !== undefined && sheet.firstSpriteId <= previous[1] + 1) previous[1] = Math.max(previous[1], sheet.lastSpriteId);
      else ranges.push([sheet.firstSpriteId, sheet.lastSpriteId]);
    }
    return {
      sheetCount: this.sheets.length,
      ranges,
      loadedSheets: this.files.size,
      spriteCount,
      lastSpriteId,
      ...(this.appearancesFile === undefined ? {} : { appearancesFile: this.appearancesFile }),
      ...(this.appearances === undefined ? {} : { appearances: this.appearances.counts }),
    };
  }

  private findSheet(id: number): CatalogSheetEntry | undefined {
    let low = 0;
    let high = this.sheets.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const sheet = this.sheets[middle]!;
      if (id < sheet.firstSpriteId) high = middle - 1;
      else if (id > sheet.lastSpriteId) low = middle + 1;
      else return sheet;
    }
    return undefined;
  }

  loadAppearances(data: Buffer): void {
    this.appearances = AppearanceLibrary.parse(data);
  }

  /** Pixel size of a sprite according to its sheet entry, without decoding the sheet. */
  getSpriteSize(id: number): { width: number; height: number } | undefined {
    const sheet = this.findSheet(id);
    return sheet === undefined ? undefined : { width: sheet.width, height: sheet.height };
  }

  /** Returns the sprite's RGBA pixels, or undefined when no loaded sheet contains the ID. */
  getSprite(id: number): CatalogSprite | undefined {
    const sheet = this.findSheet(id);
    const file = sheet === undefined ? undefined : this.files.get(sheet.file);
    if (sheet === undefined || file === undefined) return undefined;

    let image = this.decoded.get(sheet.file);
    if (image === undefined) {
      image = decodeSheet(file);
      if (this.decoded.size >= MAX_CACHED_SHEETS) this.decoded.delete(this.decoded.keys().next().value!);
      this.decoded.set(sheet.file, image);
    }

    const columns = Math.floor(image.width / sheet.width);
    const index = id - sheet.firstSpriteId;
    const left = (index % columns) * sheet.width;
    const top = Math.floor(index / columns) * sheet.height;
    if (top + sheet.height > image.height) return undefined;
    const rgba = Buffer.allocUnsafe(sheet.width * sheet.height * 4);
    for (let row = 0; row < sheet.height; row += 1) {
      const start = ((top + row) * image.width + left) * 4;
      image.rgba.copy(rgba, row * sheet.width * 4, start, start + sheet.width * 4);
    }
    return { width: sheet.width, height: sheet.height, rgba };
  }
}
