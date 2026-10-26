import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ServerResponse } from "node:http";

/**
 * Development-only live reload for the browser (enabled with DEV_RELOAD=1).
 * - `/api/dev/events` is a Server-Sent Events stream. Each connection first gets `hello` with this process's
 *   boot ID, so a page that reconnects after a server restart knows the in-memory project was lost.
 * - The web directory is polled (stat only): file-change events do not cross Docker Desktop bind mounts from
 *   Windows, polling does. Changes are reported once they settle (a scan with no further change), so one save
 *   that touches a file twice produces a single `change` event.
 */
export interface DevReload {
  readonly bootId: string;
  readonly connect: (response: ServerResponse) => void;
  readonly close: () => void;
}

async function scan(directory: string, root = directory, found = new Map<string, string>()): Promise<Map<string, string>> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path, root, found);
    else if (entry.isFile()) {
      const info = await stat(path);
      found.set(relative(root, path).replaceAll("\\", "/"), `${info.size}:${info.mtimeMs}`);
    }
  }
  return found;
}

export function createDevReload(directory: string, intervalMs = 400): DevReload {
  const bootId = randomUUID();
  const clients = new Set<ServerResponse>();
  const pending = new Set<string>();
  let known: Map<string, string> | undefined;
  let scanning = false;

  const send = (response: ServerResponse, event: string, data: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const poll = setInterval(() => {
    if (scanning) return;
    scanning = true;
    scan(directory).then((next) => {
      if (known !== undefined) {
        let changedNow = false;
        for (const [file, signature] of next) if (known.get(file) !== signature) { pending.add(file); changedNow = true; }
        for (const file of known.keys()) if (!next.has(file)) { pending.add(file); changedNow = true; }
        if (pending.size > 0 && !changedNow) {
          const files = [...pending];
          pending.clear();
          for (const client of clients) send(client, "change", { files });
        }
      }
      known = next;
    }).catch(() => {
      // A file replaced mid-scan; the next poll sees the settled state.
    }).finally(() => {
      scanning = false;
    });
  }, intervalMs);
  poll.unref();

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, 15_000);
  heartbeat.unref();

  return {
    bootId,
    connect(response) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.write("retry: 1000\n\n");
      send(response, "hello", { bootId });
      clients.add(response);
      response.on("close", () => clients.delete(response));
    },
    close() {
      clearInterval(poll);
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}
