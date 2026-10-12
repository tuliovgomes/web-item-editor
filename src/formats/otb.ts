import { Buffer } from "node:buffer";

const NODE_START = 0xfe;
const NODE_END = 0xff;
const NODE_ESCAPE = 0xfd;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_NODES = 1_000_000;
const DEFAULT_MAX_DEPTH = 64;

export class OtbFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtbFormatError";
  }
}

export interface OtbParseOptions {
  maxFileBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
}

export interface OtbItemView {
  readonly group: number;
  readonly flags: number;
  readonly serverId?: number;
  readonly clientId?: number;
  readonly name?: string;
  readonly description?: string;
  readonly speed?: number;
  readonly minimapColor?: number;
  readonly maxReadWriteLength?: number;
  readonly maxReadLength?: number;
  readonly lightLevel?: number;
  readonly lightColor?: number;
  readonly stackOrder?: number;
  readonly wareId?: number;
  readonly attributes: ReadonlyArray<{ readonly type: number; readonly payload: Buffer }>;
}

interface BinaryNode {
  data: Buffer;
  children: BinaryNode[];
}

interface Attribute {
  type: number;
  payload: Buffer;
}

type NumericField =
  | "serverId"
  | "clientId"
  | "speed"
  | "minimapColor"
  | "maxReadWriteLength"
  | "maxReadLength"
  | "lightLevel"
  | "lightColor"
  | "stackOrder"
  | "wareId";

type WritableField = NumericField | "group" | "flags" | "name" | "description";

const U16_FIELDS: Readonly<Record<Exclude<NumericField, "lightLevel" | "lightColor" | "stackOrder">, number>> = {
  serverId: 0x10,
  clientId: 0x11,
  speed: 0x14,
  minimapColor: 0x21,
  maxReadWriteLength: 0x22,
  maxReadLength: 0x23,
  wareId: 0x2d,
};

const STRING_FIELDS = {
  name: 0x12,
  description: 0x13,
} as const;

const KNOWN_U16_ATTRIBUTES = new Set([0x10, 0x11, 0x14, 0x21, 0x22, 0x23, 0x2d]);
const KNOWN_STRING_ATTRIBUTES = new Set([0x12, 0x13]);

function formatError(message: string, offset: number): OtbFormatError {
  return new OtbFormatError(`${message} at offset ${offset}`);
}

function readU16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readU32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function parseNodeData(
  input: Buffer,
  cursor: { offset: number; count: number },
  depth: number,
  maxDepth: number,
  maxNodes: number,
): BinaryNode {
  if (depth > maxDepth) {
    throw formatError(`Node nesting exceeds limit ${maxDepth}`, cursor.offset);
  }

  const data: number[] = [];
  const children: BinaryNode[] = [];

  while (cursor.offset < input.length) {
    const markerOffset = cursor.offset;
    const marker = input[cursor.offset++]!;

    if (marker === NODE_ESCAPE) {
      if (cursor.offset >= input.length) {
        throw formatError("Truncated escape sequence", markerOffset);
      }
      data.push(input[cursor.offset++]!);
      continue;
    }

    if (marker === NODE_END) {
      return { data: Buffer.from(data), children };
    }

    if (marker !== NODE_START) {
      data.push(marker);
      continue;
    }

    cursor.count += 1;
    if (cursor.count > maxNodes) {
      throw formatError(`Node count exceeds limit ${maxNodes}`, markerOffset);
    }
    children.push(parseNodeData(input, cursor, depth + 1, maxDepth, maxNodes));

    while (cursor.offset < input.length) {
      const childMarkerOffset = cursor.offset;
      const childMarker = input[cursor.offset++]!;
      if (childMarker === NODE_END) {
        return { data: Buffer.from(data), children };
      }
      if (childMarker !== NODE_START) {
        throw formatError("Invalid marker in child-node list", childMarkerOffset);
      }
      cursor.count += 1;
      if (cursor.count > maxNodes) {
        throw formatError(`Node count exceeds limit ${maxNodes}`, childMarkerOffset);
      }
      children.push(parseNodeData(input, cursor, depth + 1, maxDepth, maxNodes));
    }

    throw formatError("Unterminated child-node list", cursor.offset);
  }

  throw formatError("Unterminated node", cursor.offset);
}

function parseAttributes(data: Buffer, offset: number): Attribute[] {
  const attributes: Attribute[] = [];
  let position = offset;
  while (position < data.length) {
    if (data.length - position < 3) {
      throw formatError("Truncated OTB attribute header", position);
    }
    const type = data[position++]!;
    const length = readU16(data, position);
    position += 2;
    if (length > data.length - position) {
      throw formatError(`Attribute 0x${type.toString(16)} exceeds item node`, position);
    }
    const payload = Buffer.from(data.subarray(position, position + length));
    position += length;
    validateKnownAttribute(type, payload, position - length);
    attributes.push({ type, payload });
  }
  return attributes;
}

function validateKnownAttribute(type: number, payload: Buffer, offset: number): void {
  if (KNOWN_U16_ATTRIBUTES.has(type) && payload.length !== 2) {
    throw formatError(`OTB attribute 0x${type.toString(16)} must contain two bytes`, offset);
  }
  if (KNOWN_STRING_ATTRIBUTES.has(type)) {
    if (payload.length < 2) {
      throw formatError(`OTB string attribute 0x${type.toString(16)} is truncated`, offset);
    }
    const stringLength = readU16(payload, 0);
    if (stringLength > payload.length - 2) {
      throw formatError(`OTB string attribute 0x${type.toString(16)} exceeds its payload`, offset);
    }
  }
  if (type === 0x2a && payload.length !== 4) {
    throw formatError("OTB light attribute must contain four bytes", offset);
  }
  if (type === 0x2b && payload.length !== 1) {
    throw formatError("OTB stack-order attribute must contain one byte", offset);
  }
}

function lastAttribute(attributes: readonly Attribute[], type: number): Attribute | undefined {
  for (let index = attributes.length - 1; index >= 0; index -= 1) {
    const attribute = attributes[index];
    if (attribute?.type === type) {
      return attribute;
    }
  }
  return undefined;
}

function readAttributeU16(attributes: readonly Attribute[], type: number): number | undefined {
  const attribute = lastAttribute(attributes, type);
  return attribute === undefined ? undefined : readU16(attribute.payload, 0);
}

function readAttributeString(attributes: readonly Attribute[], type: number): string | undefined {
  const attribute = lastAttribute(attributes, type);
  if (attribute === undefined) {
    return undefined;
  }
  const length = readU16(attribute.payload, 0);
  return attribute.payload.toString("latin1", 2, 2 + length);
}

function escapeNodeData(data: Buffer): Buffer {
  const escaped: number[] = [];
  for (const byte of data) {
    if (byte === NODE_START || byte === NODE_END || byte === NODE_ESCAPE) {
      escaped.push(NODE_ESCAPE);
    }
    escaped.push(byte);
  }
  return Buffer.from(escaped);
}

function serializeNode(node: BinaryNode): Buffer {
  const parts = [Buffer.from([NODE_START]), escapeNodeData(node.data)];
  if (node.children.length > 0) {
    for (const child of node.children) {
      parts.push(serializeNode(child));
    }
  }
  parts.push(Buffer.from([NODE_END]));
  return Buffer.concat(parts);
}

function encodeLatin1(value: string, field: string): Buffer {
  for (const character of value) {
    if (character.codePointAt(0)! > 0xff) {
      throw new OtbFormatError(`${field} must be representable in Latin-1`);
    }
  }
  const text = Buffer.from(value, "latin1");
  if (text.length > 0xffff) {
    throw new OtbFormatError(`${field} exceeds the OTB 16-bit string limit`);
  }
  const payload = Buffer.allocUnsafe(2 + text.length);
  payload.writeUInt16LE(text.length, 0);
  text.copy(payload, 2);
  return payload;
}

function encodeU16(value: number, field: string): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new OtbFormatError(`${field} must be an integer from 0 to 65535`);
  }
  const payload = Buffer.allocUnsafe(2);
  payload.writeUInt16LE(value);
  return payload;
}

function encodeU32(value: number, field: string): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new OtbFormatError(`${field} must be an unsigned 32-bit integer`);
  }
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt32LE(value);
  return payload;
}

function encodeSignedByte(value: number, field: string): Buffer {
  if (!Number.isInteger(value) || value < -128 || value > 127) {
    throw new OtbFormatError(`${field} must be an integer from -128 to 127`);
  }
  const payload = Buffer.allocUnsafe(1);
  payload.writeInt8(value);
  return payload;
}

function parseRootVersion(data: Buffer): { major?: number; minor?: number; build?: number } {
  if (data.length < 6 || data[5] !== 0x01) {
    return {};
  }
  if (data.length < 8) {
    throw formatError("Truncated OTB root version attribute", data.length);
  }
  const length = readU16(data, 6);
  if (length < 12 || length > data.length - 8) {
    throw formatError("Invalid OTB root version payload length", 6);
  }
  return {
    major: readU32(data, 8),
    minor: readU32(data, 12),
    build: readU32(data, 16),
  };
}

class OtbItemRecord {
  readonly node: BinaryNode;
  readonly prefix: Buffer;
  readonly attributes: Attribute[];
  group: number;
  flags: number;

  constructor(node: BinaryNode) {
    if (node.data.length < 5) {
      throw formatError("OTB item node is shorter than its group and flags", 0);
    }
    this.node = node;
    this.prefix = Buffer.from(node.data.subarray(0, 5));
    this.group = this.prefix[0]!;
    this.flags = readU32(this.prefix, 1);
    this.attributes = parseAttributes(node.data, 5);
  }

  view(): OtbItemView {
    const light = lastAttribute(this.attributes, 0x2a)?.payload;
    const stackOrder = lastAttribute(this.attributes, 0x2b)?.payload;
    const base = {
      group: this.group,
      flags: this.flags,
      attributes: this.attributes.map(({ type, payload }) => ({ type, payload: Buffer.from(payload) })),
    };
    return {
      ...base,
      ...(readAttributeU16(this.attributes, 0x10) === undefined ? {} : { serverId: readAttributeU16(this.attributes, 0x10)! }),
      ...(readAttributeU16(this.attributes, 0x11) === undefined ? {} : { clientId: readAttributeU16(this.attributes, 0x11)! }),
      ...(readAttributeString(this.attributes, 0x12) === undefined ? {} : { name: readAttributeString(this.attributes, 0x12)! }),
      ...(readAttributeString(this.attributes, 0x13) === undefined ? {} : { description: readAttributeString(this.attributes, 0x13)! }),
      ...(readAttributeU16(this.attributes, 0x14) === undefined ? {} : { speed: readAttributeU16(this.attributes, 0x14)! }),
      ...(readAttributeU16(this.attributes, 0x21) === undefined ? {} : { minimapColor: readAttributeU16(this.attributes, 0x21)! }),
      ...(readAttributeU16(this.attributes, 0x22) === undefined ? {} : { maxReadWriteLength: readAttributeU16(this.attributes, 0x22)! }),
      ...(readAttributeU16(this.attributes, 0x23) === undefined ? {} : { maxReadLength: readAttributeU16(this.attributes, 0x23)! }),
      ...(light === undefined ? {} : { lightLevel: readU16(light, 0), lightColor: readU16(light, 2) }),
      ...(stackOrder === undefined ? {} : { stackOrder: stackOrder.readInt8(0) }),
      ...(readAttributeU16(this.attributes, 0x2d) === undefined ? {} : { wareId: readAttributeU16(this.attributes, 0x2d)! }),
    };
  }

  setField(field: WritableField, value: string | number): boolean {
    if (field === "group") {
      const numeric = asNumber(value, field);
      if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xff) {
        throw new OtbFormatError("group must be an integer from 0 to 255");
      }
      if (numeric === this.group) return false;
      this.group = numeric;
      this.prefix[0] = numeric;
      return true;
    }
    if (field === "flags") {
      const numeric = asNumber(value, field);
      const encoded = encodeU32(numeric, field);
      if (numeric === this.flags) return false;
      this.flags = numeric;
      encoded.copy(this.prefix, 1);
      return true;
    }
    if (field === "name" || field === "description") {
      if (typeof value !== "string") {
        throw new OtbFormatError(`${field} must be a string`);
      }
      const type = STRING_FIELDS[field];
      if (readAttributeString(this.attributes, type) === value) return false;
      this.setAttribute(type, encodeLatin1(value, field));
      return true;
    }

    if (field === "lightLevel" || field === "lightColor") {
      const numeric = asNumber(value, field);
      const encodedValue = encodeU16(numeric, field);
      const current = lastAttribute(this.attributes, 0x2a);
      const light = current === undefined ? Buffer.alloc(4) : Buffer.from(current.payload);
      const offset = field === "lightLevel" ? 0 : 2;
      if (light.readUInt16LE(offset) === numeric) return false;
      encodedValue.copy(light, offset);
      this.setAttribute(0x2a, light);
      return true;
    }
    if (field === "stackOrder") {
      const numeric = asNumber(value, field);
      const encoded = encodeSignedByte(numeric, field);
      if (lastAttribute(this.attributes, 0x2b)?.payload.equals(encoded)) return false;
      this.setAttribute(0x2b, encoded);
      return true;
    }

    const numeric = asNumber(value, field);
    const type = U16_FIELDS[field];
    const encoded = encodeU16(numeric, field);
    if (readAttributeU16(this.attributes, type) === numeric) return false;
    this.setAttribute(type, encoded);
    return true;
  }

  toNode(): BinaryNode {
    const attributeParts: Buffer[] = [];
    for (const { type, payload } of this.attributes) {
      if (payload.length > 0xffff) {
        throw new OtbFormatError(`Attribute 0x${type.toString(16)} exceeds the OTB length limit`);
      }
      const header = Buffer.allocUnsafe(3);
      header[0] = type;
      header.writeUInt16LE(payload.length, 1);
      attributeParts.push(header, payload);
    }
    this.prefix[0] = this.group;
    this.prefix.writeUInt32LE(this.flags, 1);
    return {
      data: Buffer.concat([this.prefix, ...attributeParts]),
      children: this.node.children,
    };
  }

  private setAttribute(type: number, payload: Buffer): void {
    const existing = lastAttribute(this.attributes, type);
    if (existing === undefined) {
      this.attributes.push({ type, payload });
    } else {
      existing.payload = payload;
    }
  }
}

function asNumber(value: string | number, field: string): number {
  if (typeof value === "number") return value;
  if (!/^-?(0|[1-9]\d*)$/.test(value)) {
    throw new OtbFormatError(`${field} must be an integer`);
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new OtbFormatError(`${field} is outside the safe integer range`);
  }
  return numeric;
}

export class OtbDocument {
  readonly #identifier: Buffer;
  readonly majorVersion: number | undefined;
  readonly minorVersion: number | undefined;
  readonly buildNumber: number | undefined;
  readonly #root: BinaryNode;
  readonly #items: OtbItemRecord[];
  #original: Buffer | undefined;
  #dirty = false;

  private constructor(identifier: Buffer, root: BinaryNode, original: Buffer, items: OtbItemRecord[]) {
    this.#identifier = Buffer.from(identifier);
    this.#root = root;
    this.#original = original;
    this.#items = items;
    const version = parseRootVersion(root.data);
    this.majorVersion = version.major;
    this.minorVersion = version.minor;
    this.buildNumber = version.build;
  }

  static parse(source: Buffer | Uint8Array, options: OtbParseOptions = {}): OtbDocument {
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 9) {
      throw new OtbFormatError("maxFileBytes must be an integer of at least 9");
    }
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
      throw new OtbFormatError("maxNodes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
      throw new OtbFormatError("maxDepth must be a non-negative safe integer");
    }

    const original = Buffer.from(source);
    if (original.length > maxFileBytes) {
      throw new OtbFormatError(`OTB exceeds the configured ${maxFileBytes}-byte file limit`);
    }
    if (original.length < 9) {
      throw new OtbFormatError("File is too small to be a valid OTB file");
    }
    const identifier = original.subarray(0, 4);
    if (identifier.toString("latin1") !== "OTBI" && !identifier.equals(Buffer.alloc(4))) {
      throw formatError("Invalid OTB file identifier", 0);
    }
    if (original[4] !== NODE_START) {
      throw formatError("Missing root-node marker", 4);
    }

    const cursor = { offset: 5, count: 1 };
    const root = parseNodeData(original, cursor, 0, maxDepth, maxNodes);
    if (cursor.offset !== original.length) {
      throw formatError("Unexpected bytes after root node", cursor.offset);
    }
    if (root.data.length < 5) {
      throw formatError("OTB root node is shorter than its header", 5);
    }
    parseRootVersion(root.data);

    const items = root.children.map((node) => new OtbItemRecord(node));
    return new OtbDocument(identifier, root, original, items);
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get identifier(): Buffer {
    return Buffer.from(this.#identifier);
  }

  get itemCount(): number {
    return this.#items.length;
  }

  get items(): ReadonlyArray<OtbItemView> {
    return this.#items.map((item) => item.view());
  }

  setItemField(serverId: number, field: WritableField, value: string | number): void {
    if (!Number.isInteger(serverId) || serverId < 0 || serverId > 0xffff) {
      throw new OtbFormatError("serverId lookup must be an integer from 0 to 65535");
    }
    const matches = this.#items.filter((item) => item.view().serverId === serverId);
    if (matches.length === 0) {
      throw new OtbFormatError(`No OTB item has server ID ${serverId}`);
    }
    if (matches.length > 1) {
      throw new OtbFormatError(`Server ID ${serverId} is duplicated; refusing ambiguous edit`);
    }
    if (field === "serverId") {
      const nextId = asNumber(value, field);
      if (this.#items.some((item) => item !== matches[0] && item.view().serverId === nextId)) {
        throw new OtbFormatError(`Server ID ${nextId} already exists; refusing duplicate ID`);
      }
    }
    if (matches[0]!.setField(field, value)) {
      this.#dirty = true;
      this.#original = undefined;
    }
  }

  serialize(): Buffer {
    if (this.#original !== undefined) {
      return Buffer.from(this.#original);
    }
    const root: BinaryNode = {
      data: this.#root.data,
      children: this.#items.map((item) => item.toNode()),
    };
    return Buffer.concat([this.#identifier, serializeNode(root)]);
  }
}

export type { WritableField };
