import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AssetProject } from "./project/project.js";
import { AbortedError, ObdWorkerPool } from "./project/obd-pool.js";
import type { DatCategory } from "./formats/dat.js";
import type { CompiledProjectFile } from "./project/project.js";

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024 - 1;
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

async function serveStatic(response: ServerResponse, file: string): Promise<void> {
  const path = resolve(process.cwd(), "web", file);
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
    })),
  };
}

export interface EditorServer {
  readonly server: Server;
  readonly start: (port?: number) => Promise<number>;
  readonly close: () => Promise<void>;
}

export function createEditorServer(): EditorServer {
  let project: AssetProject | undefined;
  let uploads: StagedUploads = {};
  let compiled: CompiledFiles | undefined;

  const obdPool = new ObdWorkerPool();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/") {
        await serveStatic(response, "index.html");
        return;
      }
      if (method === "GET" && url.pathname === "/app.css") {
        await serveStatic(response, "app.css");
        return;
      }
      if (method === "GET" && url.pathname === "/app.js") {
        await serveStatic(response, "app.js");
        return;
      }
      if (method === "GET" && url.pathname === "/sprite-io.js") {
        await serveStatic(response, "sprite-io.js");
        return;
      }

      if (method === "POST" && url.pathname === "/api/upload") {
        const kind = url.searchParams.get("kind");
        if (kind !== "dat" && kind !== "spr" && kind !== "otfi") {
          throw new Error("Upload kind must be dat, spr or otfi");
        }
        uploads[kind as UploadKind] = await readBody(request, MAX_UPLOAD_BYTES);
        compiled = undefined;
        sendJson(response, 200, { kind, bytes: uploads[kind as UploadKind]!.length });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/open") {
        if (uploads.dat === undefined || uploads.spr === undefined) {
          throw new Error("Upload both DAT and SPR files before opening a project");
        }
        const clientVersion = numberParam(url, "clientVersion");
        project = AssetProject.open({
          dat: uploads.dat,
          spr: uploads.spr,
          ...(uploads.otfi === undefined ? {} : { otfi: uploads.otfi }),
        }, { clientVersion });
        uploads = {};
        compiled = undefined;
        sendJson(response, 200, { summary: project.summary });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/create") {
        const body = await readJson<{ clientVersion: unknown; signature: unknown }>(request);
        project = AssetProject.create(
          jsonNumber(body.signature, "signature"),
          { clientVersion: jsonNumber(body.clientVersion, "clientVersion") },
        );
        compiled = undefined;
        sendJson(response, 201, { summary: project.summary });
        return;
      }

      if (method === "GET" && url.pathname === "/api/project/summary") {
        if (project === undefined) throw new Error("No asset project is open");
        sendJson(response, 200, { summary: project.summary });
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
        compiled = undefined;
        sendJson(response, 200, { summary: project.summary });
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
        compiled = undefined;
        sendJson(response, 200, { summary: project.summary });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/record") {
        if (project === undefined) throw new Error("No asset project is open");
        const body = await readJson<{ category: unknown; sourceId?: unknown }>(request);
        const category = categoryFrom(typeof body.category === "string" ? body.category : null);
        const sourceId = body.sourceId === undefined ? undefined : jsonNumber(body.sourceId, "sourceId");
        const id = project.createRecord(category, sourceId);
        compiled = undefined;
        sendJson(response, 201, { id, summary: project.summary });
        return;
      }

      if (method === "DELETE" && url.pathname === "/api/project/record") {
        if (project === undefined) throw new Error("No asset project is open");
        const category = categoryFrom(url.searchParams.get("category"));
        const id = numberParam(url, "id");
        project.removeRecord(category, id);
        compiled = undefined;
        sendJson(response, 200, { summary: project.summary });
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
        compiled = undefined;
        sendJson(response, 200, { summary: project.summary });
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
        compiled = undefined;
        sendJson(response, 201, { firstId, count, summary: project.summary });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/sprite/add") {
        if (project === undefined) throw new Error("No asset project is open");
        const spriteId = project.addSprite(await readBody(request, 256 * 256 * 4));
        compiled = undefined;
        sendJson(response, 201, { spriteId, summary: project.summary });
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
        compiled = undefined;
        sendJson(response, 201, { ...result, summary: project.summary });
        return;
      }

      if (method === "POST" && url.pathname === "/api/project/compile") {
        if (project === undefined) throw new Error("No asset project is open");
        const files = project.compile();
        if (files.length !== 3) throw new Error("Compilation did not produce all DAT, SPR and OTFI files");
        compiled = { dat: files[0]!, spr: files[1]!, otfi: files[2]! };
        sendJson(response, 200, {
          files: Object.entries(compiled).map(([format, file]) => ({
            format,
            name: file.name,
            size: file.data.length,
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
