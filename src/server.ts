import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AssetProject } from "./project/project.js";
import { buildModernObdPayload } from "./formats/obd.js";
import { AbortedError, ObdWorkerPool } from "./project/obd-pool.js";
import type { Appearance, AppearanceCategory } from "./formats/appearances.js";
import { SpriteCatalog } from "./formats/catalog.js";
import type { DatCategory } from "./formats/dat.js";
import type { CompiledProjectFile } from "./project/project.js";
import { createDevReload } from "./dev-reload.js";

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024 - 1;
// Staged uploads are kept per upload session (one per "open" in a browser tab), so two tabs opening at the same
// time — e.g. both reopening after a server restart — never mix each other's DAT and SPR. Abandoned sessions are
// evicted, oldest first, because a staged SPR can be gigabytes.
const MAX_UPLOAD_SESSIONS = 4;
const CATEGORIES = new Set<DatCategory>(["items", "outfits", "effects", "missiles"]);
type UploadKind = "dat" | "spr" | "otfi";
type DownloadFormat = "dat" | "spr" | "otfi";

interface StagedUploads {
  dat?: Buffer;
  spr?: Buffer;
  otfi?: Buffer;
}

interface CompiledFiles {
  readonly dat: CompiledProjectFile;
  readonly spr: CompiledProjectFile;
  readonly otfi: CompiledProjectFile;
  readonly revision: number;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

const MAX_OBD_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SPRITES_PER_REQUEST = 1024;
const MAX_CATALOG_JSON_BYTES = 64 * 1024 * 1024;
const MAX_APPEARANCES_BYTES = 256 * 1024 * 1024;
const MAX_CATALOG_SHEET_BYTES = 16 * 1024 * 1024;
const MAX_SPRITE_BATCH_BYTES = 96 * 1024 * 1024;

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  const expectedLength = contentLength === undefined ? undefined : Number(contentLength);
  if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength < 0)) {
    throw new Error("Invalid Content-Length header");
  }
  if (expectedLength !== undefined && expectedLength > limit) {
    throw new RequestBodyTooLargeError(limit);
  }

  if (expectedLength !== undefined) {
    const body = Buffer.allocUnsafe(expectedLength);
    let total = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > expectedLength - total) {
        throw new Error("Request body exceeds the declared Content-Length");
      }
      bytes.copy(body, total);
      total += bytes.length;
    }
    if (total !== expectedLength) throw new Error("Request body is shorter than the declared Content-Length");
    return body;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) throw new RequestBodyTooLargeError(limit);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

class RequestBodyTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(limit: number) {
    super(`Arquivo maior que o limite de ${formatBytes(limit)} por arquivo.`);
    this.name = "RequestBodyTooLargeError";
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(0)} GiB`;
}

async function readJson<T>(request: IncomingMessage, limit = 64 * 1024): Promise<T> {
  const bytes = await readBody(request, limit);
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function numberParam(url: URL, key: string, fallback?: number): number {
  const value = url.searchParams.get(key);
  if (value === null && fallback !== undefined) return fallback;
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${key} exceeds the safe integer range`);
  return number;
}

function jsonNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

function categoryFrom(value: string | null): DatCategory {
  if (value === null || !CATEGORIES.has(value as DatCategory)) {
    throw new Error("Unknown DAT category");
  }
  return value as DatCategory;
}

function safeDownloadName(name: string): string {
  const leaf = name.replaceAll("\\", "/").split("/").at(-1) ?? "asset.bin";
  return leaf.replace(/[\r\n"]/g, "_") || "asset.bin";
}

function mimeFor(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

/** Public paths served from disk: the editor's own files plus the vendored SweetAlert2 build. */
const STATIC_FILES = new Map<string, string>([
  ["/", "web/index.html"],
  ["/app.css", "web/app.css"],
  ["/app.js", "web/app.js"],
  ["/sprite-io.js", "web/sprite-io.js"],
  ["/folder-sync.js", "web/folder-sync.js"],
  ["/dialogs.js", "web/dialogs.js"],
  ["/vendor/sweetalert2.min.js", "node_modules/sweetalert2/dist/sweetalert2.min.js"],
  ["/vendor/sweetalert2.min.css", "node_modules/sweetalert2/dist/sweetalert2.min.css"],
]);

async function serveStatic(response: ServerResponse, file: string): Promise<void> {
  const path = resolve(process.cwd(), file);
  const content = await readFile(path);
  response.writeHead(200, {
    "content-type": mimeFor(file),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  response.end(content);
}

function categoryRecord(record: ReturnType<AssetProject["list"]>[number]) {
  return {
    id: record.id,
    category: record.category,
    flags: record.flags,
    properties: record.properties,
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
      spriteIds: group.spriteIds,
      animation: legacyAnimation(group),
    })),
  };
}

/** Frame durations of a DAT group (stored after the frame count since 10.50), in the shape of modern phases. */
function legacyAnimation(group: ReturnType<AssetProject["list"]>[number]["groups"][number]) {
  const data = group.animationData;
  if (group.frames <= 1 || data.length < 6 + group.frames * 8) return null;
  const phases: [number, number][] = [];
  for (let frame = 0; frame < group.frames; frame += 1) phases.push([data.readUInt32LE(6 + frame * 8), data.readUInt32LE(10 + frame * 8)]);
  return { loopCount: data.readInt32LE(1), startFrame: data.readInt8(5), phases };
}

function modernRecord(catalog: SpriteCatalog, entry: Appearance) {
  return {
    id: entry.id,
    category: entry.category,
    name: entry.name ?? null,
    description: entry.description ?? null,
    flags: entry.flags,
    groups: entry.groups.map((group) => {
      const first = group.spriteIds.find((id) => id !== 0);
      const size = first === undefined ? undefined : catalog.getSpriteSize(first);
      return {
        type: group.fixedFrameGroup,
        width: size === undefined ? 1 : size.width / 32,
        height: size === undefined ? 1 : size.height / 32,
        layers: group.layers,
        patternX: group.patternX,
        patternY: group.patternY,
        patternZ: group.patternZ,
        frames: group.frames,
        spriteIds: group.spriteIds,
        animation: group.animation ?? null,
      };
    }),
  };
}

export interface EditorServer {
  readonly server: Server;
  readonly start: (port?: number) => Promise<number>;
  readonly close: () => Promise<void>;
}

export function createEditorServer(): EditorServer {
  let project: AssetProject | undefined;
  const uploadSessions = new Map<string, StagedUploads>();
  const uploadSession = (url: URL): string => {
    const session = url.searchParams.get("session") ?? "";
    if (!/^[\w-]{0,64}$/.test(session)) throw new Error("Invalid upload session");
    return session;
  };
  let compiled: CompiledFiles | undefined;
  let catalog: SpriteCatalog | undefined;
  // Bumped by every edit of the open project, so the browser can tell whether the files on disk are current.
  let revision = 0;

  const markChanged = (): void => {
    compiled = undefined;
    revision += 1;
  };
  const projectSummary = () => ({ ...project!.summary, revision });

  const obdPool = new ObdWorkerPool();
  const devReload = process.env["DEV_RELOAD"] === "1" ? createDevReload(resolve(process.cwd(), "web")) : undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";

      const staticFile = method === "GET" ? STATIC_FILES.get(url.pathname) : undefined;
      if (staticFile !== undefined) {
        await serveStatic(response, staticFile);
        return;
      }

      if (method === "GET" && url.pathname === "/api/dev/events" && devReload !== undefined) {
        devReload.connect(response);
        return;
      }

      if (method === "POST" && url.pathname === "/api/upload") {
        const kind = url.searchParams.get("kind");
        if (kind !== "dat" && kind !== "spr" && kind !== "otfi") {
          throw new Error("Upload kind must be dat, spr or otfi");
        }
        const session = uploadSession(url);
        const data = await readBody(request, MAX_UPLOAD_BYTES);
        const staged = uploadSessions.get(session) ?? {};
        staged[kind as UploadKind] = data;
        uploadSessions.delete(session);
        uploadSessions.set(session, staged);
        while (uploadSessions.size > MAX_UPLOAD_SESSIONS) uploadSessions.delete(uploadSessions.keys().next().value!);
        sendJson(response, 200, { kind, bytes: data.length });
        return;
      }

      if (method === "POST" && url.pathname === "/api/catalog/open") {
        const body = await readBody(request, MAX_CATALOG_JSON_BYTES);
        catalog = new SpriteCatalog(body.toString("utf8"));
        sendJson(response, 200, { summary: catalog.summary, files: catalog.requiredFiles });
        return;
      }

      if (method === "POST" && url.pathname === "/api/catalog/sheet") {
        if (catalog === undefined) throw new Error("No sprite catalog is open");
        const name = url.searchParams.get("name") ?? "";
        const stored = catalog.addSheet(name, await readBody(request, MAX_CATALOG_SHEET_BYTES));
        if (!stored) throw new Error(`O catálogo não lista o arquivo "${name}"`);
        sendJson(response, 200, { summary: catalog.summary });
        return;
      }

      if (method === "POST" && url.pathname === "/api/catalog/appearances") {
        if (catalog === undefined) throw new Error("No sprite catalog is open");
        catalog.loadAppearances(await readBody(request, MAX_APPEARANCES_BYTES));
        sendJson(response, 200, { summary: catalog.summary });
        return;
      }

      if (method === "GET" && url.pathname === "/api/catalog/objects") {
        if (catalog?.appearances === undefined) throw new Error("O catálogo não tem appearances.dat carregado");
        const category = categoryFrom(url.searchParams.get("category")) as AppearanceCategory;
        const offset = numberParam(url, "offset", 0);
        const limit = Math.min(numberParam(url, "limit", 100), 500);
        const matches = catalog.appearances.list(category, url.searchParams.get("search") ?? undefined);
        sendJson(response, 200, {
          total: matches.length,
          offset,
          records: matches.slice(offset, offset + limit).map((entry) => modernRecord(catalog!, entry)),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/catalog/obd") {
        if (catalog?.appearances === undefined) throw new Error("O catálogo não tem appearances.dat carregado");
        const category = categoryFrom(url.searchParams.get("category")) as AppearanceCategory;
        const id = numberParam(url, "id");
        const appearance = catalog.appearances.get(category, id);
        if (appearance === undefined) throw new Error(`Nenhum objeto ${category} com o ID ${id}`);
        const clientVersion = numberParam(url, "clientVersion", 0);
        if (clientVersion > 0xffff) throw new Error("clientVersion must fit in 16 bits");
        const source = catalog;
        const payload = buildModernObdPayload({ appearance, clientVersion, getSprite: (spriteId) => source.getSprite(spriteId) });
        const aborter = new AbortController();
        response.on("close", () => {
          if (!response.writableEnded) aborter.abort();
        });
        let data: Buffer;
        try {
          data = await obdPool.compress(payload.raw, aborter.signal);
        } catch (error) {
          if (error instanceof AbortedError) return;
          throw error;
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": data.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-obd-warnings": encodeURIComponent(JSON.stringify(payload.warnings)),
        });
        response.end(data);
        return;
      }

      if (method === "GET" && url.pathname === "/api/catalog/summary") {
        if (catalog === undefined) throw new Error("No sprite catalog is open");
        sendJson(response, 200, { summary: catalog.summary });
        return;
      }

      if (method === "GET" && url.pathname === "/api/catalog/sprite") {
        if (catalog === undefined) throw new Error("No sprite catalog is open");
        const spriteId = numberParam(url, "id");
        const sprite = catalog.getSprite(spriteId);
        if (sprite === undefined) throw new Error(`Nenhum sprite carregado com o ID ${spriteId}`);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": sprite.rgba.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-sprite-width": String(sprite.width),
          "x-sprite-height": String(sprite.height),
        });
        response.end(sprite.rgba);
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/open") {
        const session = uploadSession(url);
        const uploads = uploadSessions.get(session) ?? {};
        if (uploads.dat === undefined || uploads.spr === undefined) {
          throw new Error("Upload both DAT and SPR files before opening a project");
        }
        const clientVersion = numberParam(url, "clientVersion");
        uploadSessions.delete(session);
        project = AssetProject.open({
          dat: uploads.dat,
          spr: uploads.spr,
          ...(uploads.otfi === undefined ? {} : { otfi: uploads.otfi }),
        }, { clientVersion });
        compiled = undefined;
        sendJson(response, 200, { summary: projectSummary() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/create") {
        const body = await readJson<{ clientVersion: unknown; signature: unknown }>(request);
        project = AssetProject.create(
          jsonNumber(body.signature, "signature"),
          { clientVersion: jsonNumber(body.clientVersion, "clientVersion") },
        );
        compiled = undefined;
        sendJson(response, 201, { summary: projectSummary() });
        return;
      }

      if (method === "GET" && url.pathname === "/api/project/summary") {
        if (project === undefined) throw new Error("No asset project is open");
        sendJson(response, 200, { summary: projectSummary() });
        return;
      }

      if (method === "GET" && url.pathname === "/api/project/records") {
        if (project === undefined) throw new Error("No asset project is open");
        const category = categoryFrom(url.searchParams.get("category"));
        const offset = numberParam(url, "offset", 0);
        const limit = Math.min(numberParam(url, "limit", 100), 500);
        const search = url.searchParams.get("search");
        const all = search === null
          ? project.list(category, offset, limit)
          : project.list(category, 0, Math.min(project.summary.counts[category], 65_536))
            .filter((record) => String(record.id).includes(search))
            .slice(offset, offset + limit);
        sendJson(response, 200, {
          total: project.summary.counts[category],
          offset,
          records: all.map(categoryRecord),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/property") {
        if (project === undefined) throw new Error("No asset project is open");
        const body = await readJson<{
          category: unknown;
          id: unknown;
          name: unknown;
          value: unknown;
        }>(request);
        const category = categoryFrom(typeof body.category === "string" ? body.category : null);
        const id = jsonNumber(body.id, "id");
        if (typeof body.name !== "string") throw new Error("name must be a string");
        if (typeof body.value !== "boolean" && typeof body.value !== "number" && typeof body.value !== "string") {
          throw new Error("value must be a boolean, number or string");
        }
        project.setProperty(category, id, body.name, body.value);
        markChanged();
        sendJson(response, 200, { summary: projectSummary() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/sprite-reference") {
        if (project === undefined) throw new Error("No asset project is open");
        const body = await readJson<{
          category: unknown;
          id: unknown;
          group: unknown;
          slot: unknown;
          spriteId: unknown;
        }>(request);
        const category = categoryFrom(typeof body.category === "string" ? body.category : null);
        project.setSpriteId(
          category,
          jsonNumber(body.id, "id"),
          jsonNumber(body.group, "group"),
          jsonNumber(body.slot, "slot"),
          jsonNumber(body.spriteId, "spriteId"),
        );
        markChanged();
        sendJson(response, 200, { summary: projectSummary() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/record") {
        if (project === undefined) throw new Error("No asset project is open");
        const body = await readJson<{ category: unknown; sourceId?: unknown }>(request);
        const category = categoryFrom(typeof body.category === "string" ? body.category : null);
        const sourceId = body.sourceId === undefined ? undefined : jsonNumber(body.sourceId, "sourceId");
        const id = project.createRecord(category, sourceId);
        markChanged();
        sendJson(response, 201, { id, summary: projectSummary() });
        return;
      }

      if (method === "DELETE" && url.pathname === "/api/project/record") {
        if (project === undefined) throw new Error("No asset project is open");
        const category = categoryFrom(url.searchParams.get("category"));
        const id = numberParam(url, "id");
        project.removeRecord(category, id);
        markChanged();
        sendJson(response, 200, { summary: projectSummary() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/records/delete") {
        if (project === undefined) throw new Error("No asset project is open");
        const body = await readJson<{ category: unknown; ids: unknown }>(request, 1024 * 1024);
        const category = categoryFrom(typeof body.category === "string" ? body.category : null);
        if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 65_536) {
          throw new Error("ids must list between 1 and 65536 record IDs");
        }
        const ids = body.ids.map((value, index) => jsonNumber(value, `ids[${index}]`));
        const result = project.removeRecords(category, ids);
        if (result.removed.length > 0) markChanged();
        sendJson(response, 200, { ...result, summary: projectSummary() });
        return;
      }

      if (method === "GET" && url.pathname === "/api/project/sprite") {
        if (project === undefined) throw new Error("No asset project is open");
        const spriteId = numberParam(url, "id");
        const image = project.getSprite(spriteId);
        if (image === undefined) throw new Error(`No SPR sprite with ID ${spriteId}`);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": image.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(image);
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/sprite") {
        if (project === undefined) throw new Error("No asset project is open");
        const spriteId = numberParam(url, "id");
        project.replaceSprite(spriteId, await readBody(request, 256 * 256 * 4));
        markChanged();
        sendJson(response, 200, { summary: projectSummary() });
        return;
      }

      if (method === "GET" && url.pathname === "/api/project/sprites") {
        if (project === undefined) throw new Error("No asset project is open");
        const raw = url.searchParams.get("ids") ?? "";
        const ids = raw === "" ? [] : raw.split(",");
        if (ids.length === 0 || ids.length > MAX_SPRITES_PER_REQUEST) {
          throw new Error(`ids must list between 1 and ${MAX_SPRITES_PER_REQUEST} sprite IDs`);
        }
        const images = ids.map((value) => {
          if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid sprite ID "${value}"`);
          const image = project!.getSprite(Number(value));
          if (image === undefined) throw new Error(`No SPR sprite with ID ${value}`);
          return image;
        });
        const body = Buffer.concat(images);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": body.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(body);
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/sprites") {
        if (project === undefined) throw new Error("No asset project is open");
        const { spriteSize, spriteCount, extended } = project.summary.sprites;
        const frameBytes = spriteSize * spriteSize * 4;
        const body = await readBody(request, MAX_SPRITE_BATCH_BYTES);
        if (body.length === 0 || body.length % frameBytes !== 0) {
          throw new Error(`Batch must be a non-empty multiple of ${frameBytes} RGBA bytes`);
        }
        const count = body.length / frameBytes;
        if (!extended && spriteCount + count > 0xffff) {
          throw new Error("Legacy SPR supports at most 65535 sprites; the batch would exceed it");
        }
        const firstId = project.addSprite(body.subarray(0, frameBytes));
        for (let index = 1; index < count; index += 1) {
          project.addSprite(body.subarray(index * frameBytes, (index + 1) * frameBytes));
        }
        markChanged();
        sendJson(response, 201, { firstId, count, summary: projectSummary() });
        return;
      }

      if (method === "POST" && (url.pathname === "/api/project/sprites/usage" || url.pathname === "/api/project/sprites/delete")) {
        if (project === undefined) throw new Error("No asset project is open");
        const body = await readJson<{ ids: unknown }>(request, 8 * 1024 * 1024);
        if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 1_000_000) {
          throw new Error("ids must list between 1 and 1000000 sprite IDs");
        }
        const ids = body.ids.map((value, index) => jsonNumber(value, `ids[${index}]`));
        if (url.pathname.endsWith("/usage")) {
          const users = project.spriteUsage(ids);
          sendJson(response, 200, { total: users.length, records: users.slice(0, 50) });
          return;
        }
        const result = project.removeSprites(ids);
        if (result.removed.length > 0) markChanged();
        sendJson(response, 200, { ...result, summary: projectSummary() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/sprite/add") {
        if (project === undefined) throw new Error("No asset project is open");
        const spriteId = project.addSprite(await readBody(request, 256 * 256 * 4));
        markChanged();
        sendJson(response, 201, { spriteId, summary: projectSummary() });
        return;
      }

      if (method === "GET" && url.pathname === "/api/project/obd") {
        if (project === undefined) throw new Error("No asset project is open");
        const category = categoryFrom(url.searchParams.get("category"));
        const id = numberParam(url, "id");
        const started = process.hrtime.bigint();
        const payload = project.prepareObd(category, id);
        const built = process.hrtime.bigint();
        const aborter = new AbortController();
        response.on("close", () => {
          if (!response.writableEnded) aborter.abort();
        });
        let data: Buffer;
        try {
          data = await obdPool.compress(payload.raw, aborter.signal);
        } catch (error) {
          if (error instanceof AbortedError) return;
          throw error;
        }
        const warnings = payload.warnings;
        const done = process.hrtime.bigint();
        response.writeHead(200, {
          "server-timing": `build;dur=${Number(built - started) / 1e6}, compress;dur=${Number(done - built) / 1e6}`,
          "content-type": "application/octet-stream",
          "content-length": data.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-obd-warnings": encodeURIComponent(JSON.stringify(warnings)),
        });
        response.end(data);
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/obd") {
        if (project === undefined) throw new Error("No asset project is open");
        const result = project.importObd(await readBody(request, MAX_OBD_UPLOAD_BYTES));
        markChanged();
        sendJson(response, 201, { ...result, summary: projectSummary() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/compile") {
        if (project === undefined) throw new Error("No asset project is open");
        const files = project.compile();
        if (files.length !== 3) throw new Error("Compilation did not produce all DAT, SPR and OTFI files");
        compiled = { dat: files[0]!, spr: files[1]!, otfi: files[2]!, revision };
        sendJson(response, 200, {
          revision,
          files: (["dat", "spr", "otfi"] as const).map((format) => ({
            format,
            name: compiled![format].name,
            size: compiled![format].data.length,
          })),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/project/download") {
        if (compiled === undefined) throw new Error("Compile the project before downloading outputs");
        const format = url.searchParams.get("format") as DownloadFormat | null;
        if (format !== "dat" && format !== "spr" && format !== "otfi") {
          throw new Error("Download format must be dat, spr or otfi");
        }
        if (url.searchParams.has("revision") && numberParam(url, "revision") !== compiled.revision) {
          throw new Error("O projeto mudou depois da compilação; compile novamente");
        }
        const file = compiled[format];
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": file.data.length,
          "content-disposition": `attachment; filename="${safeDownloadName(file.name)}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(file.data);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof RequestBodyTooLargeError ? error.statusCode : 400;
      if (error instanceof RequestBodyTooLargeError) {
        response.setHeader("connection", "close");
        response.once("finish", () => request.destroy());
      }
      sendJson(response, status, { error: message });
    });
  });

  return {
    server,
    start(
      port = Number(process.env["PORT"] ?? 4173),
      host = process.env["HOST"] ?? "127.0.0.1",
    ) {
      return new Promise((resolvePort, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Could not determine the local editor server port"));
            return;
          }
          resolvePort(address.port);
        });
      });
    },
    close() {
      return new Promise((resolveClose, reject) => {
        void obdPool.close();
        devReload?.close();
        server.close((error) => error ? reject(error) : resolveClose());
      });
    },
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(__filename)) {
  const editor = createEditorServer();
  editor.start().then((port) => {
    console.log(`OTEditor local web editor listening at http://127.0.0.1:${port}`);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
