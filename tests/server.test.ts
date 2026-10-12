import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { AssetProject } from "../src/project/project.js";
import { createEditorServer } from "../src/server.js";

test("rejects oversized uploads immediately with the active 2 GiB limit", async () => {
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
          "content-length": String(2 * 1024 * 1024 * 1024 + 1),
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
    assert.match(response.body, /limite de 2 GiB por arquivo/);
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
