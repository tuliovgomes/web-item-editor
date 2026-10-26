import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDevReload } from "../src/dev-reload.js";
import { createEditorServer } from "../src/server.js";

/** Reads SSE events from `url` until `until` returns true for the list collected so far. */
async function readEvents(url: string, until: (events: { event: string; data: unknown }[]) => boolean, onOpen?: () => Promise<void>) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = "";
  let opened = false;
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
      if (!opened && events.length > 0 && onOpen) {
        opened = true;
        await onOpen();
      }
    }
  } finally {
    controller.abort();
  }
  return events;
}

test("streams the boot ID and one settled change per edited web file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oteditor-dev-"));
  await writeFile(join(directory, "app.css"), "a{}");
  const reload = createDevReload(directory, 30);
  const server = createServer((_request, response) => reload.connect(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");

  try {
    await new Promise((resolve) => setTimeout(resolve, 120)); // let the first scan take its baseline
    const events = await readEvents(
      `http://127.0.0.1:${address.port}/`,
      (seen) => seen.some((item) => item.event === "change"),
      async () => {
        await writeFile(join(directory, "app.css"), "a{color:red}");
        await writeFile(join(directory, "app.js"), "1");
      },
    );
    assert.deepEqual(events[0], { event: "hello", data: { bootId: reload.bootId } });
    const changes = events.filter((item) => item.event === "change");
    assert.equal(changes.length, 1);
    assert.deepEqual((changes[0]!.data as { files: string[] }).files.sort(), ["app.css", "app.js"]);
  } finally {
    reload.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("the live-reload route exists only in development mode", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/dev/events`)).status, 404);
  } finally {
    await editor.close();
  }

  process.env["DEV_RELOAD"] = "1";
  const dev = createEditorServer();
  delete process.env["DEV_RELOAD"];
  const devPort = await dev.start(0);
  try {
    const events = await readEvents(`http://127.0.0.1:${devPort}/api/dev/events`, (seen) => seen.length > 0);
    assert.equal(events[0]?.event, "hello");
  } finally {
    await dev.close();
  }
});
