import { Buffer } from "node:buffer";

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024 - 1;
const MAX_SPRITE_COUNT = 5_000_000;

export interface SprOptions {
  readonly extended: boolean;
  readonly transparency: boolean;
  readonly spriteSize: number;
  readonly maxFileBytes?: number;
}

export interface SprInfo {
  readonly signature: number;
  readonly spriteCount: number;
  readonly extended: boolean;
  readonly transparency: boolean;
  readonly spriteSize: number;
}

interface SpriteRecord {
  readonly offset: number;
  rgba?: Buffer;
  removed?: boolean;
}

export class SprFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SprFormatError";
  }
}

function checkSpriteSize(size: number): void {
  if (![32, 64, 128, 256].includes(size)) {
    throw new SprFormatError(`Unsupported sprite size ${size}; expected 32, 64, 128 or 256`);
  }
}

function decodeBlock(source: Buffer, offset: number, options: SprOptions): Buffer {
  if (offset < 0 || offset > source.length - 5) {
    throw new SprFormatError(`SPR sprite block header is outside the file at offset ${offset}`);
  }

  const payloadSize = source.readUInt16LE(offset + 3);
  const payloadStart = offset + 5;
  const payloadEnd = payloadStart + payloadSize;
  if (payloadEnd > source.length) {
    throw new SprFormatError(`Truncated SPR sprite payload at offset ${offset}`);
  }

  const totalPixels = options.spriteSize * options.spriteSize;
  const rgba = Buffer.alloc(totalPixels * 4);
  let position = payloadStart;
  let pixel = 0;
  while (position < payloadEnd) {
    if (payloadEnd - position < 4) {
      throw new SprFormatError(`Truncated SPR run header at offset ${position}`);
    }
    const transparentCount = source.readUInt16LE(position);
    const coloredCount = source.readUInt16LE(position + 2);
    position += 4;
    if (transparentCount + coloredCount === 0) {
      throw new SprFormatError(`SPR run does not advance at offset ${position - 4}`);
    }
    if (transparentCount + coloredCount > totalPixels - pixel) {
      throw new SprFormatError(`SPR run exceeds ${totalPixels} pixels at offset ${position - 4}`);
    }
    pixel += transparentCount;
    const bytesPerPixel = options.transparency ? 4 : 3;
    const colorBytes = coloredCount * bytesPerPixel;
    if (colorBytes > payloadEnd - position) {
      throw new SprFormatError(`Truncated SPR colored-pixel data at offset ${position}`);
    }
    for (let color = 0; color < coloredCount; color += 1) {
      const target = pixel * 4;
      rgba[target] = source[position++]!;
      rgba[target + 1] = source[position++]!;
      rgba[target + 2] = source[position++]!;
      rgba[target + 3] = options.transparency ? source[position++]! : 255;
      pixel += 1;
    }
  }
  return rgba;
}

function validateBlock(source: Buffer, offset: number, options: SprOptions): void {
  if (offset < 0 || offset > source.length - 5) {
    throw new SprFormatError(`SPR sprite block header is outside the file at offset ${offset}`);
  }
  const payloadSize = source.readUInt16LE(offset + 3);
  const payloadStart = offset + 5;
  const payloadEnd = payloadStart + payloadSize;
  if (payloadEnd > source.length) throw new SprFormatError(`Truncated SPR sprite payload at offset ${offset}`);
  const totalPixels = options.spriteSize * options.spriteSize;
  const bytesPerPixel = options.transparency ? 4 : 3;
  let position = payloadStart;
  let pixel = 0;
  while (position < payloadEnd) {
    if (payloadEnd - position < 4) throw new SprFormatError(`Truncated SPR run header at offset ${position}`);
    const transparentCount = source.readUInt16LE(position);
    const coloredCount = source.readUInt16LE(position + 2);
    position += 4;
    if (transparentCount + coloredCount === 0) {
      throw new SprFormatError(`SPR run does not advance at offset ${position - 4}`);
    }
    if (transparentCount + coloredCount > totalPixels - pixel) {
      throw new SprFormatError(`SPR run exceeds ${totalPixels} pixels at offset ${position - 4}`);
    }
    pixel += transparentCount + coloredCount;
    const colorBytes = coloredCount * bytesPerPixel;
    if (colorBytes > payloadEnd - position) {
      throw new SprFormatError(`Truncated SPR colored-pixel data at offset ${position}`);
    }
    position += colorBytes;
  }
}

function encodeBlock(rgba: Buffer, options: SprOptions, spriteId: number): Buffer | undefined {
  const pixelCount = options.spriteSize * options.spriteSize;
  const payload: number[] = [];
  if (!rgba.some((_, index) => index % 4 === 3 && rgba[index] !== 0)) return undefined;
  let pixel = 0;
  while (pixel < pixelCount) {
    const transparentStart = pixel;
    while (
      pixel < pixelCount &&
      pixel - transparentStart < 0xffff &&
      rgba[pixel * 4 + 3] === 0
    ) pixel += 1;
    const transparentCount = pixel - transparentStart;
    const coloredStart = pixel;
    while (
      pixel < pixelCount &&
      pixel - coloredStart < 0xffff &&
      rgba[pixel * 4 + 3] !== 0
    ) pixel += 1;
    const coloredCount = pixel - coloredStart;
    payload.push(transparentCount & 0xff, transparentCount >>> 8, coloredCount & 0xff, coloredCount >>> 8);
    for (let index = coloredStart; index < pixel; index += 1) {
      const offset = index * 4;
      payload.push(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!);
      if (options.transparency) payload.push(rgba[offset + 3]!);
    }
  }
  if (payload.length > 0xffff) {
    throw new SprFormatError(`Encoded sprite ${spriteId} exceeds the SPR 16-bit payload limit`);
  }
  const block = Buffer.alloc(5 + payload.length);
  block.set([0xff, 0, 0xff], 0);
  block.writeUInt16LE(payload.length, 3);
  Buffer.from(payload).copy(block, 5);
  return block;
}

export class SprDocument {
  readonly #source: Buffer;
  readonly #options: SprOptions;
  readonly #signature: number;
  readonly #records: SpriteRecord[];
  #dirty = false;

  private constructor(source: Buffer, signature: number, options: SprOptions, offsets: readonly number[]) {
    this.#source = source;
    this.#signature = signature;
    this.#options = options;
    this.#records = offsets.map((offset) => ({ offset }));
  }

  static parse(source: Buffer, options: SprOptions, expectedSignature?: number): SprDocument {
    checkSpriteSize(options.spriteSize);
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 6) {
      throw new SprFormatError("maxFileBytes must be an integer of at least 6");
    }
    if (source.length > maxFileBytes) throw new SprFormatError(`SPR exceeds configured file limit ${maxFileBytes}`);
    const countSize = options.extended ? 4 : 2;
    if (source.length < 4 + countSize) throw new SprFormatError("SPR header is truncated");
    const signature = source.readUInt32LE(0);
    if (expectedSignature !== undefined && expectedSignature !== 0 && signature !== expectedSignature) {
      throw new SprFormatError(`SPR signature mismatch: expected ${expectedSignature}, found ${signature}`);
    }
    const count = options.extended ? source.readUInt32LE(4) : source.readUInt16LE(4);
    if (count > MAX_SPRITE_COUNT) throw new SprFormatError(`SPR sprite count exceeds limit ${MAX_SPRITE_COUNT}`);
    const tableStart = 4 + countSize;
    const tableSize = count * 4;
    if (tableSize > source.length - tableStart) throw new SprFormatError("SPR offset table exceeds file size");
    const tableEnd = tableStart + tableSize;
    const offsets: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = source.readUInt32LE(tableStart + index * 4);
      if (offset !== 0) {
        if (offset < tableEnd || offset > source.length - 5) {
          throw new SprFormatError(`SPR sprite ${index + 1} offset is outside its data region`);
        }
        validateBlock(source, offset, options);
      }
      offsets.push(offset);
    }
    return new SprDocument(Buffer.from(source), signature, options, offsets);
  }

  /**
   * Infers the count-header width and pixel format for SPR files without OTFI by
   * validating a bounded sample of sprite blocks under each candidate layout.
   */
  static detectLayout(
    source: Buffer,
    spriteSize = 32,
    sampleSize = 512,
  ): { extended: boolean; transparency: boolean } | undefined {
    checkSpriteSize(spriteSize);
    for (const extended of [true, false]) {
      const countSize = extended ? 4 : 2;
      if (source.length < 4 + countSize) continue;
      const count = extended ? source.readUInt32LE(4) : source.readUInt16LE(4);
      const tableStart = 4 + countSize;
      if (count === 0 || count > MAX_SPRITE_COUNT || count * 4 > source.length - tableStart) continue;
      const tableEnd = tableStart + count * 4;
      const sample: number[] = [];
      const stride = Math.max(1, Math.floor(count / sampleSize));
      for (let index = 0; index < count && sample.length < sampleSize; index += stride) {
        const offset = source.readUInt32LE(tableStart + index * 4);
        if (offset !== 0) sample.push(offset);
      }
      if (sample.length === 0) continue;
      for (const transparency of [true, false]) {
        const candidate: SprOptions = { extended, transparency, spriteSize };
        try {
          for (const offset of sample) {
            if (offset < tableEnd) throw new SprFormatError("offset inside table");
            validateBlock(source, offset, candidate);
          }
          return { extended, transparency };
        } catch {
          // try the next layout
        }
      }
    }
    return undefined;
  }

  static create(signature: number, options: SprOptions): SprDocument {
    checkSpriteSize(options.spriteSize);
    if (!Number.isInteger(signature) || signature < 0 || signature > 0xffff_ffff) {
      throw new SprFormatError("SPR signature must be an unsigned 32-bit integer");
    }
    const header = Buffer.alloc(4 + (options.extended ? 4 : 2));
    header.writeUInt32LE(signature);
    return new SprDocument(header, signature, options, []);
  }

  get info(): SprInfo {
    return {
      signature: this.#signature,
      spriteCount: this.#records.length,
      extended: this.#options.extended,
      transparency: this.#options.transparency,
      spriteSize: this.#options.spriteSize,
    };
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  getSprite(spriteId: number): Buffer | undefined {
    const record = this.#records[spriteId - 1];
    if (record === undefined) return undefined;
    if (record.removed === true || record.offset === 0 && record.rgba === undefined) {
      return Buffer.alloc(this.#options.spriteSize * this.#options.spriteSize * 4);
    }
    return record.rgba === undefined
      ? decodeBlock(this.#source, record.offset, this.#options)
      : Buffer.from(record.rgba);
  }

  replaceSprite(spriteId: number, rgba: Buffer): void {
    const record = this.#records[spriteId - 1];
    const expectedLength = this.#options.spriteSize * this.#options.spriteSize * 4;
    if (record === undefined) throw new SprFormatError(`No SPR sprite with ID ${spriteId}`);
    if (rgba.length !== expectedLength) {
      throw new SprFormatError(`Sprite image must contain exactly ${expectedLength} RGBA bytes`);
    }
    record.rgba = Buffer.from(rgba);
    delete record.removed;
    this.#dirty = true;
  }

  addSprite(rgba: Buffer): number {
    const expectedLength = this.#options.spriteSize * this.#options.spriteSize * 4;
    if (rgba.length !== expectedLength) {
      throw new SprFormatError(`Sprite image must contain exactly ${expectedLength} RGBA bytes`);
    }
    if (!this.#options.extended && this.#records.length >= 0xffff) {
      throw new SprFormatError("Legacy SPR supports at most 65535 sprites");
    }
    this.#records.push({ offset: 0, rgba: Buffer.from(rgba) });
    this.#dirty = true;
    return this.#records.length;
  }

  /** Drops the sprites appended after the first `count` (undoes `addSprite` calls of a failed operation). */
  truncate(count: number): void {
    if (!Number.isInteger(count) || count < 0) throw new SprFormatError("Sprite count must be a non-negative integer");
    if (count >= this.#records.length) return;
    this.#records.length = count;
    this.#dirty = true;
  }

  removeSprite(spriteId: number): void {
    const record = this.#records[spriteId - 1];
    if (record === undefined) throw new SprFormatError(`No SPR sprite with ID ${spriteId}`);
    delete record.rgba;
    record.removed = true;
    this.#dirty = true;
  }

  serialize(): Buffer {
    if (!this.#dirty && this.#source.length >= 4) return Buffer.from(this.#source);
    if (!this.#options.extended && this.#records.length > 0xffff) {
      throw new SprFormatError("Legacy SPR supports at most 65535 sprites");
    }
    const countBytes = this.#options.extended ? 4 : 2;
    const headerSize = 4 + countBytes;
    const tableSize = this.#records.length * 4;
    const blocks: (Buffer | undefined)[] = [];
    const offsets: number[] = [];
    let position = headerSize + tableSize;
    this.#records.forEach((record, index) => {
      let block: Buffer | undefined;
      if (record.removed === true || record.offset === 0 && record.rgba === undefined) {
        block = undefined;
      } else if (record.rgba !== undefined) {
        block = encodeBlock(record.rgba, this.#options, index + 1);
      } else {
        const offset = record.offset;
        const payloadSize = this.#source.readUInt16LE(offset + 3);
        block = Buffer.from(this.#source.subarray(offset, offset + 5 + payloadSize));
      }
      if (block === undefined) {
        offsets.push(0);
      } else {
        if (position > 0xffff_ffff) throw new SprFormatError("SPR exceeds the 4 GiB offset limit");
        offsets.push(position);
        position += block.length;
      }
      blocks.push(block);
    });

    const output = Buffer.alloc(position);
    output.writeUInt32LE(this.#signature, 0);
    if (this.#options.extended) output.writeUInt32LE(this.#records.length, 4);
    else output.writeUInt16LE(this.#records.length, 4);
    let blockPosition = headerSize + tableSize;
    this.#records.forEach((_, index) => {
      const offsetPosition = headerSize + index * 4;
      output.writeUInt32LE(offsets[index]!, offsetPosition);
      const block = blocks[index];
      if (block !== undefined) {
        block.copy(output, blockPosition);
        blockPosition += block.length;
      }
    });
    return output;
  }
}
