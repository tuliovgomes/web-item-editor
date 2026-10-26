import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { AssetProject } from "../src/project/project.js";
import { createEditorServer } from "../src/server.js";

test("rejects oversized uploads immediately with the active 4 GiB limit", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);

  try {
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port,
        path: "/api/upload?kind=spr",
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(4 * 1024 * 1024 * 1024 + 1),
        },
      }, (result) => {
        let body = "";
        result.setEncoding("utf8");
        result.on("data", (chunk: string) => { body += chunk; });
        result.on("end", () => resolve({ status: result.statusCode, body }));
      });
      request.on("error", reject);
      request.end();
    });

    assert.equal(response.status, 413);
    assert.match(response.body, /limite de 4 GiB por arquivo/);
  } finally {
    await editor.close();
  }
});

test("uploads and opens a DAT+SPR+OTFI set from one selected project folder", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const files = AssetProject.create(0x1234, { clientVersion: 772 }).compile();

  try {
    for (const format of ["dat", "spr", "otfi"] as const) {
      const file = files.find((candidate) => candidate.name.endsWith(`.${format}`));
      assert.ok(file);
      const uploaded = await fetch(`${baseUrl}/api/upload?kind=${format}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Blob([Uint8Array.from(file.data)]),
      });
      assert.equal(uploaded.status, 200);
    }

    const opened = await fetch(`${baseUrl}/api/project/open?clientVersion=772`, { method: "POST" });
    assert.equal(opened.status, 200);
    const result = await opened.json() as {
      summary: { datSignature: number; sprites: { signature: number } };
    };
    assert.equal(result.summary.datSignature, 0x1234);
    assert.equal(result.summary.sprites.signature, 0x1234);
  } finally {
    await editor.close();
  }
});

test("serves the local editor and supports project edit, compile and download routes", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /OTEditor/);
    assert.match(html, /id="projectFolder"[^>]*webkitdirectory/);
    assert.doesNotMatch(html, /id="datFile"|id="sprFile"|id="otfiFile"/);

    const created = await fetch(`${baseUrl}/api/project/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientVersion: 772, signature: 0x1234 }),
    });
    assert.equal(created.status, 201);

    const recordResponse = await fetch(`${baseUrl}/api/project/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "items" }),
    });
    const record = await recordResponse.json() as { id: number };
    assert.equal(recordResponse.status, 201);
    assert.equal(record.id, 100);

    const propertyResponse = await fetch(`${baseUrl}/api/project/property`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: "items",
        id: record.id,
        name: "isStackable",
        value: true,
      }),
    });
    assert.equal(propertyResponse.status, 200);

    const recordsResponse = await fetch(`${baseUrl}/api/project/records?category=items`);
    const records = await recordsResponse.json() as {
      records: Array<{ properties: Record<string, boolean | number | string> }>;
    };
    assert.equal(records.records[0]?.properties["isStackable"], true);

    const compileResponse = await fetch(`${baseUrl}/api/project/compile`, { method: "POST" });
    const compileResult = await compileResponse.json() as {
      files: Array<{ format: string }>;
    };
    assert.equal(compileResponse.status, 200);
    assert.deepEqual(compileResult.files.map((file) => file.format), ["dat", "spr", "otfi"]);

    for (const format of ["dat", "spr", "otfi"]) {
      const download = await fetch(`${baseUrl}/api/project/download?format=${format}`);
      assert.equal(download.status, 200);
      assert.ok((await download.arrayBuffer()).byteLength > 0);
    }
  } finally {
    await editor.close();
  }
});

test("deletes selected records in one request and reports the IDs that failed", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    const created = await post("/api/project/create", { clientVersion: 772, signature: 1 });
    const start = (await created.json() as { summary: { revision: number } }).summary.revision;
    for (let index = 0; index < 5; index += 1) {
      const record = await (await post("/api/project/record", { category: "items" })).json() as { id: number };
      await post("/api/project/property", { category: "items", id: record.id, name: "groundSpeed", value: record.id });
    }

    const response = await post("/api/project/records/delete", { category: "items", ids: [101, 103, 500] });
    assert.equal(response.status, 200);
    const result = await response.json() as {
      removed: number[];
      failed: Array<{ id: number }>;
      summary: { counts: { items: number }; revision: number };
    };
    assert.deepEqual(result.removed, [101, 103]);
    assert.deepEqual(result.failed.map((failure) => failure.id), [500]);
    assert.equal(result.summary.counts.items, 3);
    assert.ok(result.summary.revision > start, "every edit bumps the project revision");

    const listed = await (await fetch(`${baseUrl}/api/project/records?category=items`)).json() as {
      records: Array<{ properties: { groundSpeed: number } }>;
    };
    assert.deepEqual(listed.records.map((record) => record.properties.groundSpeed), [100, 102, 104]);

    const invalid = await post("/api/project/records/delete", { category: "items", ids: [] });
    assert.equal(invalid.status, 400);
  } finally {
    await editor.close();
  }
});

test("only serves compiled files of the revision that was compiled", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fetch(`${baseUrl}/api/project/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientVersion: 772, signature: 1 }),
    });
    const compiled = await (await fetch(`${baseUrl}/api/project/compile`, { method: "POST" })).json() as { revision: number };
    const current = await fetch(`${baseUrl}/api/project/download?format=dat&revision=${compiled.revision}`);
    assert.equal(current.status, 200);
    const stale = await fetch(`${baseUrl}/api/project/download?format=dat&revision=${compiled.revision + 1}`);
    assert.equal(stale.status, 400);
    assert.match((await stale.json() as { error: string }).error, /compile novamente/);

    await fetch(`${baseUrl}/api/project/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "items" }),
    });
    const afterEdit = await fetch(`${baseUrl}/api/project/download?format=spr&revision=${compiled.revision}`);
    assert.equal(afterEdit.status, 400, "an edit after compiling invalidates the compiled set");
  } finally {
    await editor.close();
  }
});

test("serves SweetAlert2 and the editor scripts, and the editor uses no native confirm or alert", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const html = await (await fetch(baseUrl)).text();
    for (const path of ["/vendor/sweetalert2.min.js", "/vendor/sweetalert2.min.css", "/dialogs.js", "/folder-sync.js", "/app.js"]) {
      assert.match(html, new RegExp(`(src|href)="${path.replaceAll(".", "\.")}"`));
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type") ?? "", path.endsWith(".css") ? /text\/css/ : /text\/javascript/);
    }
    const app = await (await fetch(`${baseUrl}/app.js`)).text();
    assert.doesNotMatch(app, /(?<![.\w])(confirm|alert|prompt)\(/, "app.js must use Dialogs (SweetAlert2), not window.confirm/alert/prompt");
    assert.equal((await fetch(`${baseUrl}/vendor/../package.json`)).status, 404);
  } finally {
    await editor.close();
  }
});

test("reports sprite usage and empties selected sprites in one request", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    await post("/api/project/create", { clientVersion: 772, signature: 1 });
    const frame = new Uint8Array(32 * 32 * 4).fill(200);
    const batch = new Uint8Array(frame.length * 3);
    for (let index = 0; index < 3; index += 1) batch.set(frame, index * frame.length);
    await fetch(`${baseUrl}/api/project/sprites`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: batch });
    const { id } = await (await post("/api/project/record", { category: "items" })).json() as { id: number };
    await post("/api/project/sprite-reference", { category: "items", id, group: 0, slot: 0, spriteId: 2 });

    const usage = await (await post("/api/project/sprites/usage", { ids: [1, 2] })).json() as { total: number; records: unknown[] };
    assert.deepEqual(usage, { total: 1, records: [{ category: "items", id }] });

    const deleted = await post("/api/project/sprites/delete", { ids: [1, 2, 7] });
    assert.equal(deleted.status, 200);
    const result = await deleted.json() as { removed: number[]; failed: Array<{ id: number }>; summary: { sprites: { spriteCount: number } } };
    assert.deepEqual(result.removed, [1, 2]);
    assert.deepEqual(result.failed.map((failure) => failure.id), [7]);
    assert.equal(result.summary.sprites.spriteCount, 3);

    const sprites = new Uint8Array(await (await fetch(`${baseUrl}/api/project/sprites?ids=1,2,3`)).arrayBuffer());
    assert.ok(sprites.subarray(0, frame.length * 2).every((byte) => byte === 0));
    assert.ok(sprites.subarray(frame.length * 2).every((byte) => byte === 200));
    assert.equal((await post("/api/project/sprites/delete", { ids: [] })).status, 400);
  } finally {
    await editor.close();
  }
});

test("stages uploads per session so two tabs opening at once never mix their files", async () => {
  const editor = createEditorServer();
  const port = await editor.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const first = AssetProject.create(0x1111, { clientVersion: 772 }).compile();
  const second = AssetProject.create(0x2222, { clientVersion: 772 }).compile();
  const upload = (session: string, kind: string, data: Buffer) => fetch(`${baseUrl}/api/upload?kind=${kind}&session=${session}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Blob([Uint8Array.from(data)]),
  });

  try {
    // Interleaved exactly like two tabs reopening after a restart: A's DAT, B's DAT, A's SPR, B's SPR.
    await upload("tab-a", "dat", first[0]!.data);
    await upload("tab-b", "dat", second[0]!.data);
    await upload("tab-a", "spr", first[1]!.data);
    await upload("tab-b", "spr", second[1]!.data);
    const openedA = await (await fetch(`${baseUrl}/api/project/open?clientVersion=772&session=tab-a`, { method: "POST" })).json() as {
      summary: { datSignature: number; sprites: { signature: number } };
    };
    assert.equal(openedA.summary.datSignature, 0x1111);
    assert.equal(openedA.summary.sprites.signature, 0x1111);
    const openedB = await (await fetch(`${baseUrl}/api/project/open?clientVersion=772&session=tab-b`, { method: "POST" })).json() as {
      summary: { datSignature: number };
    };
    assert.equal(openedB.summary.datSignature, 0x2222);

    const reused = await fetch(`${baseUrl}/api/project/open?clientVersion=772&session=tab-a`, { method: "POST" });
    assert.equal(reused.status, 400, "a session is consumed by its open");
    assert.equal((await fetch(`${baseUrl}/api/upload?kind=dat&session=../x`, { method: "POST", body: "x" })).status, 400);
  } finally {
    await editor.close();
  }
});
