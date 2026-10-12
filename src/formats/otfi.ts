import { Buffer } from "node:buffer";

export interface OtfiSettings {
  readonly extended: boolean;
  readonly transparency: boolean;
  readonly frameDurations: boolean;
  readonly frameGroups: boolean;
  readonly metadataFile: string;
  readonly spritesFile: string;
  readonly spriteSize: number;
  readonly attributeServer?: string;
  readonly metadataController?: string;
}

type OtfiKey = keyof OtfiSettings;

const SUPPORTED_SPRITE_SIZES = new Set([32, 64, 128, 256]);

export class OtfiFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtfiFormatError";
  }
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new OtfiFormatError(`Invalid boolean value: ${value}`);
}

function validateProjectFileName(value: string, settingName: string): void {
  if (value.length === 0 || value.includes("\0") || value.startsWith("/") || value.startsWith("\\")) {
    throw new OtfiFormatError(`${settingName} must be a non-empty relative path`);
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new OtfiFormatError(`${settingName} cannot escape the asset folder`);
  }
}

export class OtfiDocument {
  readonly #lines: string[];
  readonly #newline: string;
  readonly #trailingNewline: boolean;
  readonly #original: string;
  readonly #values = new Map<string, string>();
  #dirty = false;

  private constructor(source: string) {
    this.#original = source;
    this.#newline = source.includes("\r\n") ? "\r\n" : "\n";
    this.#trailingNewline = source.endsWith("\n") || source.endsWith("\r");
    this.#lines = source.split(/\r\n|\n|\r/);
    if (this.#trailingNewline) this.#lines.pop();

    const section = this.findDatSprSection();
    if (section === undefined) return;
    for (let index = section.start + 1; index < section.end; index += 1) {
      const line = this.#lines[index]!;
      if (!/^[ \t]/.test(line)) continue;
      const match = /^\s*([^:]+)\s*:\s*(.*)$/.exec(line);
      if (match !== null) this.#values.set(match[1]!.trim().toLowerCase(), match[2]!.trim());
    }
  }

  static parse(source: Buffer | string): OtfiDocument {
    let text: string;
    try {
      text = typeof source === "string"
        ? source
        : new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      throw new OtfiFormatError("OTFI must be valid UTF-8 text");
    }
    return new OtfiDocument(text);
  }

  static create(settings: Omit<OtfiSettings, "attributeServer" | "metadataController">): OtfiDocument {
    const spriteDataSize = settings.spriteSize * settings.spriteSize * (settings.transparency ? 4 : 3);
    const source = [
      "DatSpr",
      `  extended: ${settings.extended}`,
      `  transparency: ${settings.transparency}`,
      `  frame-durations: ${settings.frameDurations}`,
      `  frame-groups: ${settings.frameGroups}`,
      "  metadata-controller: default",
      "  attribute-server: tfs1.4",
      `  metadata-file: ${settings.metadataFile}`,
      `  sprites-file: ${settings.spritesFile}`,
      `  sprite-size: ${settings.spriteSize}`,
      `  sprite-data-size: ${spriteDataSize}`,
      "",
    ].join("\n");
    return OtfiDocument.parse(source);
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get settings(): OtfiSettings {
    const spriteSizeValue = this.#values.get("sprite-size");
    const spriteSize = spriteSizeValue === undefined ? 32 : Number(spriteSizeValue);
    if (!SUPPORTED_SPRITE_SIZES.has(spriteSize)) {
      throw new OtfiFormatError(`Unsupported OTFI sprite-size: ${spriteSizeValue}`);
    }
    const metadataFile = this.#values.get("metadata-file") || "Tibia.dat";
    const spritesFile = this.#values.get("sprites-file") || "Tibia.spr";
    validateProjectFileName(metadataFile, "metadata-file");
    validateProjectFileName(spritesFile, "sprites-file");
    const attributeServer = this.#values.get("attribute-server");
    const metadataController = this.#values.get("metadata-controller");
    return {
      extended: parseBoolean(this.#values.get("extended") ?? "false"),
      transparency: parseBoolean(this.#values.get("transparency") ?? "false"),
      frameDurations: parseBoolean(this.#values.get("frame-durations") ?? "false"),
      frameGroups: parseBoolean(this.#values.get("frame-groups") ?? "false"),
      metadataFile,
      spritesFile,
      spriteSize,
      ...(attributeServer === undefined ? {} : { attributeServer }),
      ...(metadataController === undefined ? {} : { metadataController }),
    };
  }

  set<K extends OtfiKey>(key: K, value: OtfiSettings[K]): void {
    const keyName = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const stringValue = String(value);
    if (this.#values.get(keyName) === stringValue) return;
    this.updateLine(keyName, stringValue);
    this.#values.set(keyName, stringValue);
    this.#dirty = true;
  }

  serialize(): Buffer {
    const text = this.#dirty
      ? `${this.#lines.join(this.#newline)}${this.#trailingNewline ? this.#newline : ""}`
      : this.#original;
    return Buffer.from(text, "utf8");
  }

  private findDatSprSection(): { start: number; end: number } | undefined {
    for (let index = 0; index < this.#lines.length; index += 1) {
      const line = this.#lines[index]!;
      if (/^[ \t]/.test(line) || line.trim().toLowerCase() !== "datspr") continue;
      let end = index + 1;
      for (; end < this.#lines.length; end += 1) {
        const next = this.#lines[end]!;
        if (next.trim().length > 0 && !/^[ \t]/.test(next)) break;
      }
      return { start: index, end };
    }
    return undefined;
  }

  private updateLine(key: string, value: string): void {
    const section = this.findDatSprSection();
    if (section === undefined) {
      if (this.#lines.length > 0 && this.#lines[this.#lines.length - 1] !== "") {
        this.#lines.push("");
      }
      this.#lines.push("DatSpr", `  ${key}: ${value}`);
      return;
    }

    let matchingLine = -1;
    for (let index = section.start + 1; index < section.end; index += 1) {
      const line = this.#lines[index]!;
      const match = /^\s*([^:]+)\s*:/.exec(line);
      if (match?.[1]?.trim().toLowerCase() === key) matchingLine = index;
    }
    if (matchingLine >= 0) {
      const line = this.#lines[matchingLine]!;
      const colon = line.indexOf(":");
      this.#lines[matchingLine] = `${line.slice(0, colon + 1)} ${value}`;
    } else {
      this.#lines.splice(section.end, 0, `  ${key}: ${value}`);
    }
  }
}

export type { OtfiKey };
