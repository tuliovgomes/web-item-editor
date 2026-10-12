import { Buffer } from "node:buffer";
import { DatDocument, type DatCategory, type DatParseOptions, type DatRecordView } from "../formats/dat.js";
import { decodeObd, encodeObd, type ObdEncodeResult } from "../formats/obd.js";
import { OtfiDocument, type OtfiSettings } from "../formats/otfi.js";
import { SprDocument, type SprInfo, type SprOptions } from "../formats/spr.js";

export interface ProjectFiles {
  readonly dat: Buffer;
  readonly spr: Buffer;
  readonly otfi?: Buffer;
}

export interface ProjectOptions {
  readonly clientVersion: number;
}

export interface CompiledProjectFile {
  readonly name: string;
  readonly data: Buffer;
}

export interface ProjectSummary {
  readonly datSignature: number;
  readonly clientVersion: number;
  readonly settings: OtfiSettings;
  readonly counts: Readonly<Record<DatCategory, number>>;
  readonly sprites: SprInfo;
  readonly dirty: boolean;
  readonly warnings: readonly string[];
}

function defaultsForVersion(version: number): Omit<OtfiSettings, "metadataFile" | "spritesFile"> & {
  metadataFile: string;
  spritesFile: string;
} {
  return {
    extended: version >= 960,
    transparency: false,
    frameDurations: version >= 1050,
    frameGroups: version >= 1057,
    metadataFile: "Tibia.dat",
    spritesFile: "Tibia.spr",
    spriteSize: 32,
  };
}

function inferClientVersion(settings: OtfiSettings): number {
  if (settings.frameGroups) return 1057;
  if (settings.frameDurations) return 1050;
  if (settings.extended) return 960;
  return 772;
}

function parseOptions(clientVersion: number, settings: OtfiSettings): DatParseOptions {
  return {
    clientVersion,
    otfi: {
      extended: settings.extended,
      frameDurations: settings.frameDurations,
      frameGroups: settings.frameGroups,
    },
  };
}

function sprOptions(settings: OtfiSettings): SprOptions {
  return {
    extended: settings.extended,
    transparency: settings.transparency,
    spriteSize: settings.spriteSize,
  };
}

function validateSpriteReferences(dat: DatDocument, spriteCount: number): void {
  for (const category of ["items", "outfits", "effects", "missiles"] as const) {
    for (const record of dat.list(category, 0, dat.getRecordCount(category))) {
      for (const group of record.groups) {
        for (const spriteId of group.spriteIds) {
          if (spriteId > spriteCount) {
            throw new Error(`${category} ${record.id} references missing sprite ${spriteId}`);
          }
        }
      }
    }
  }
}

export class AssetProject {
  readonly #clientVersion: number;
  readonly #dat: DatDocument;
  readonly #spr: SprDocument;
  readonly #otfi: OtfiDocument;
  readonly #warnings: readonly string[];

  private constructor(
    clientVersion: number,
    dat: DatDocument,
    spr: SprDocument,
    otfi: OtfiDocument,
    warnings: readonly string[] = [],
  ) {
    this.#warnings = warnings;
    this.#clientVersion = clientVersion;
    this.#dat = dat;
    this.#spr = spr;
    this.#otfi = otfi;
  }

  static open(files: ProjectFiles, options: ProjectOptions): AssetProject {
    if (!Number.isInteger(options.clientVersion) || options.clientVersion < 0) {
      throw new Error("clientVersion must be zero (auto-detect) or a positive integer");
    }
    const requestedVersion = options.clientVersion;
    if (files.otfi === undefined && requestedVersion === 0) {
      return AssetProject.openWithoutOtfi(files);
    }
    const otfi = files.otfi === undefined
      ? OtfiDocument.create(defaultsForVersion(requestedVersion || 772))
      : OtfiDocument.parse(files.otfi);
    const settings = otfi.settings;
    const clientVersion = requestedVersion || inferClientVersion(settings);
    const datOptions = parseOptions(clientVersion, settings);
    const dat = DatDocument.parse(files.dat, datOptions);
    const warnings: string[] = [];
    let spr: SprDocument;
    try {
      spr = SprDocument.parse(files.spr, sprOptions(settings));
    } catch (error) {
      // Some tools write an OTFI whose `transparency` flag disagrees with the pixel data actually stored.
      if (files.otfi === undefined) throw error;
      const flipped = !settings.transparency;
      try {
        spr = SprDocument.parse(files.spr, sprOptions({ ...settings, transparency: flipped }));
      } catch {
        throw error;
      }
      otfi.set("transparency", flipped);
      warnings.push(
        `O OTFI declara transparency: ${String(settings.transparency)}, mas os pixels do SPR estão em ${flipped ? "RGBA (4 bytes)" : "RGB (3 bytes)"}. O editor usou o formato real e o OTFI compilado será corrigido para transparency: ${String(flipped)}.`,
      );
    }
    validateSpriteReferences(dat, spr.info.spriteCount);
    return new AssetProject(clientVersion, dat, spr, otfi, warnings);
  }

  /** Probes SPR layout and DAT version candidates when no OTFI describes the client. */
  private static openWithoutOtfi(files: ProjectFiles): AssetProject {
    const layout = SprDocument.detectLayout(files.spr);
    if (layout === undefined) {
      throw new Error("Could not detect the SPR layout (tried 16/32-bit counts with RGB and RGBA pixels); provide an OTFI or a client version");
    }
    const failures: string[] = [];
    for (const version of [1100, 1057, 1050, 1010, 960, 860, 780, 772]) {
      if (version >= 960 !== layout.extended) continue;
      const settings = { ...defaultsForVersion(version), transparency: layout.transparency };
      try {
        const otfi = OtfiDocument.create(settings);
        const dat = DatDocument.parse(files.dat, parseOptions(version, otfi.settings));
        const spr = SprDocument.parse(files.spr, sprOptions(otfi.settings));
        validateSpriteReferences(dat, spr.info.spriteCount);
        return new AssetProject(version, dat, spr, otfi);
      } catch (error) {
        failures.push(`${version}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`No supported DAT layout matched (SPR extended=${layout.extended}, transparency=${layout.transparency}). ${failures.join("; ")}`);
  }

  static create(signature: number, options: ProjectOptions): AssetProject {
    if (!Number.isInteger(options.clientVersion) || options.clientVersion < 1) {
      throw new Error("clientVersion must be a positive integer");
    }
    const settings = defaultsForVersion(options.clientVersion);
    const otfi = OtfiDocument.create(settings);
    const normalizedSettings = otfi.settings;
    const dat = DatDocument.create(signature, parseOptions(options.clientVersion, normalizedSettings));
    const spr = SprDocument.create(signature, sprOptions(normalizedSettings));
    return new AssetProject(options.clientVersion, dat, spr, otfi);
  }

  get summary(): ProjectSummary {
    return {
      datSignature: this.#dat.signature,
      clientVersion: this.#clientVersion,
      settings: this.#otfi.settings,
      counts: {
        items: this.#dat.getRecordCount("items"),
        outfits: this.#dat.getRecordCount("outfits"),
        effects: this.#dat.getRecordCount("effects"),
        missiles: this.#dat.getRecordCount("missiles"),
      },
      sprites: this.#spr.info,
      dirty: this.#dat.dirty || this.#spr.dirty || this.#otfi.dirty,
      warnings: this.#warnings,
    };
  }

  list(category: DatCategory, offset = 0, limit = 100): readonly DatRecordView[] {
    return this.#dat.list(category, offset, limit);
  }

  setProperty(category: DatCategory, id: number, name: string, value: boolean | number | string): void {
    this.#dat.setProperty(category, id, name, value);
  }

  setSpriteId(category: DatCategory, id: number, groupIndex: number, slot: number, spriteId: number): void {
    if (spriteId > this.#spr.info.spriteCount) {
      throw new Error(`Sprite ID ${spriteId} does not exist in the project's SPR`);
    }
    this.#dat.setSpriteId(category, id, groupIndex, slot, spriteId);
  }

  createRecord(category: DatCategory, sourceId?: number): number {
    return this.#dat.createRecord(category, sourceId);
  }

  removeRecord(category: DatCategory, id: number): void {
    this.#dat.removeRecord(category, id);
  }

  getSprite(spriteId: number): Buffer | undefined {
    return this.#spr.getSprite(spriteId);
  }

  replaceSprite(spriteId: number, rgba: Buffer): void {
    this.#spr.replaceSprite(spriteId, rgba);
  }

  addSprite(rgba: Buffer): number {
    return this.#spr.addSprite(rgba);
  }

  exportObd(category: DatCategory, id: number): ObdEncodeResult {
    const record = this.#dat.getRecord(category, id);
    if (record === undefined) throw new Error(`No ${category} record with ID ${id}`);
    return encodeObd({
      record,
      clientVersion: this.#clientVersion,
      spriteSize: this.#spr.info.spriteSize,
      getSprite: (spriteId) => this.#spr.getSprite(spriteId),
    });
  }

  /** Appends the OBD object as a new record; existing records and sprites are never overwritten. */
  importObd(file: Buffer): { category: DatCategory; id: number; addedSprites: number; warnings: string[] } {
    const thing = decodeObd(file);
    if (this.#spr.info.spriteSize !== 32) {
      throw new Error(`OBD sprites are 32×32 but this project uses ${this.#spr.info.spriteSize}`);
    }
    const warnings: string[] = [];
    const category = thing.category;
    const id = this.#dat.createRecord(category);
    let addedSprites = 0;
    try {
      this.#dat.setFrameGroup(category, id, { ...thing.group, spriteIds: thing.group.spriteIds.map(() => 0) });
      const mapped = new Map<number, number>();
      for (const [originalId, rgba] of thing.sprites) {
        let blank = true;
        for (let offset = 3; offset < rgba.length; offset += 4) {
          if (rgba[offset] !== 0) { blank = false; break; }
        }
        if (originalId === 0 || blank) {
          mapped.set(originalId, 0);
        } else {
          mapped.set(originalId, this.#spr.addSprite(rgba));
          addedSprites += 1;
        }
      }
      this.#dat.setFrameGroup(category, id, {
        ...thing.group,
        spriteIds: thing.group.spriteIds.map((original) => mapped.get(original) ?? 0),
      });
    } catch (error) {
      this.#dat.removeRecord(category, id);
      throw error;
    }
    for (const [name, value] of Object.entries(thing.properties)) {
      try {
        this.#dat.setProperty(category, id, name, value);
      } catch (error) {
        warnings.push(`Propriedade ${name} não aplicada: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (thing.clientVersion !== this.#clientVersion) {
      warnings.push(`O OBD foi criado para o cliente ${thing.clientVersion}; o projeto usa ${this.#clientVersion}.`);
    }
    return { category, id, addedSprites, warnings };
  }

  compile(): readonly CompiledProjectFile[] {
    const datBytes = this.#dat.serialize();
    const sprBytes = this.#spr.serialize();
    const otfiBytes = this.#otfi.serialize();
    const settings = this.#otfi.settings;
    const datOptions = parseOptions(this.#clientVersion, settings);
    const datCheck = this.#dat.dirty || this.#otfi.dirty
      ? DatDocument.parse(datBytes, datOptions)
      : this.#dat;
    const sprCheck = this.#spr.dirty || this.#otfi.dirty
      ? SprDocument.parse(sprBytes, sprOptions(settings))
      : this.#spr;
    validateSpriteReferences(datCheck, sprCheck.info.spriteCount);

    return [
      { name: settings.metadataFile, data: datBytes },
      { name: settings.spritesFile, data: sprBytes },
      { name: "project.otfi", data: otfiBytes },
    ];
  }
}
