import assert from "node:assert/strict";
import { test } from "node:test";

interface Entry { name: string; path: string }
interface Snapshot { key: string; files: Map<string, string> }
interface Writable { close(): Promise<void>; abort(): Promise<void> }
interface Target { name: string; open(): Promise<Writable>; fill(writable: Writable): Promise<void> }
interface Watcher {
  start(initial: Snapshot): void;
  stop(): void;
  acknowledge(snapshot: Snapshot): void;
  pausedWhile<T>(work: () => Promise<T>): Promise<T>;
  readonly active: boolean;
}
interface FolderSync {
  isRelevantName(name: string): boolean;
  findProjectFiles(entries: Entry[]): { dat: Entry; spr: Entry; otfi?: Entry };
  findCatalogEntry(entries: Entry[]): Entry | undefined;
  makeSnapshot(files: { name: string; size: number; lastModified: number }[]): Snapshot;
  diffSnapshots(previous: Snapshot, next: Snapshot): { added: string[]; changed: string[]; removed: string[] };
  createChangeWatcher(options: {
    readSnapshot: () => Promise<Snapshot>;
    onChange: (next: Snapshot, previous: Snapshot) => unknown;
    onError?: (error: unknown) => void;
    interval?: number;
    stableReads?: number;
    timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void };
  }): Watcher;
  commitAtomically(targets: Target[]): Promise<string[]>;
  clampPage(page: number, total: number, pageSize: number): number;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- classic browser script shared with the tests
const sync = require("../web/folder-sync.js") as FolderSync;

const entry = (path: string): Entry => ({ name: path.split("/").at(-1)!, path });

test("picks the DAT/SPR/OTFI set by matching stems and keeps nested paths", () => {
  const picked = sync.findProjectFiles([
    entry("client/data/Tibia.dat"),
    entry("client/data/Tibia.spr"),
    entry("client/data/Tibia.otfi"),
    entry("client/appearances.otfi"),
  ]);
  assert.equal(picked.dat.path, "client/data/Tibia.dat");
  assert.equal(picked.spr.path, "client/data/Tibia.spr");
  assert.equal(picked.otfi?.path, "client/data/Tibia.otfi");
  assert.throws(() => sync.findProjectFiles([entry("a/Tibia.dat")]), /precisa conter um arquivo \.dat e um arquivo \.spr/);
  assert.throws(
    () => sync.findProjectFiles([entry("a/A.dat"), entry("a/B.dat"), entry("a/C.spr")]),
    /mais de um DAT\/SPR/,
  );
  assert.equal(sync.findCatalogEntry([entry("x/catalog-content.json")])?.path, "x/catalog-content.json");
  assert.ok(sync.isRelevantName("sprites-1-2.bmp.lzma") && !sync.isRelevantName("notes.txt"));
});

test("snapshots compare file metadata and report additions, changes and removals", () => {
  const before = sync.makeSnapshot([
    { name: "d/Tibia.spr", size: 10, lastModified: 1 },
    { name: "d/Tibia.dat", size: 5, lastModified: 1 },
  ]);
  const same = sync.makeSnapshot([
    { name: "d/Tibia.dat", size: 5, lastModified: 1 },
    { name: "d/Tibia.spr", size: 10, lastModified: 1 },
  ]);
  assert.equal(before.key, same.key, "order of the listing does not matter");
  const after = sync.makeSnapshot([
    { name: "d/Tibia.dat", size: 6, lastModified: 2 },
    { name: "d/Tibia.otfi", size: 1, lastModified: 2 },
  ]);
  assert.deepEqual(sync.diffSnapshots(before, after), {
    added: ["d/Tibia.otfi"],
    changed: ["d/Tibia.dat"],
    removed: ["d/Tibia.spr"],
  });
});

/** Manual clock: `run()` fires every due timer and waits for the async work it starts. */
function fakeTimers() {
  const queue = new Map<number, () => void>();
  let nextId = 1;
  return {
    timers: {
      setTimeout: (fn: () => void) => { const id = nextId++; queue.set(id, fn); return id; },
      clearTimeout: (id: unknown) => { queue.delete(id as number); },
    },
    async run(times = 1) {
      for (let index = 0; index < times; index += 1) {
        const due = [...queue.entries()];
        queue.clear();
        for (const [, fn] of due) fn();
        for (let flush = 0; flush < 20; flush += 1) await Promise.resolve();
      }
    },
  };
}

function snap(size: number) {
  return sync.makeSnapshot([{ name: "d/Tibia.spr", size, lastModified: size }]);
}

function sizeOf(snapshot: Snapshot) {
  return Number(snapshot.files.get("d/Tibia.spr")?.split(":")[0]);
}

test("reports one external change only after it settles, never repeats it and ignores acknowledged writes", async () => {
  const clock = fakeTimers();
  let current = snap(1);
  const changes: Array<[number, number]> = [];
  const watcher = sync.createChangeWatcher({
    readSnapshot: async () => current,
    onChange: (next, previous) => { changes.push([sizeOf(next), sizeOf(previous)]); },
    stableReads: 2,
    timers: clock.timers,
  });
  watcher.start(snap(1));
  await clock.run(3);
  assert.deepEqual(changes, [], "no change, no report");

  current = snap(2); // a file still being written…
  await clock.run();
  current = snap(3); // …keeps changing: nothing is reported until two polls agree
  await clock.run();
  assert.deepEqual(changes, []);
  await clock.run();
  assert.deepEqual(changes, [[3, 1]]);
  await clock.run(5);
  assert.equal(changes.length, 1, "the same change is reported once");

  // The editor's own save: polls are paused during the write and the result is acknowledged.
  await watcher.pausedWhile(async () => {
    current = snap(4);
    await clock.run(3);
    watcher.acknowledge(snap(4));
  });
  await clock.run(5);
  assert.equal(changes.length, 1, "self-written files never trigger a reload");

  watcher.stop();
  current = snap(5);
  await clock.run(5);
  assert.equal(changes.length, 1, "a stopped watcher keeps no timer running");
  assert.equal(watcher.active, false);
});

test("works with the default timers when they must not be called as methods (as in browsers)", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const strict = (fn: typeof setTimeout) => function (this: unknown, ...args: Parameters<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return fn(...args);
  };
  globalThis.setTimeout = strict(realSetTimeout) as typeof setTimeout;
  globalThis.clearTimeout = strict(realClearTimeout as unknown as typeof setTimeout) as unknown as typeof clearTimeout;
  try {
    let current = snap(1);
    const seen: number[] = [];
    const watcher = sync.createChangeWatcher({
      readSnapshot: async () => current,
      onChange: (next) => { seen.push(sizeOf(next)); },
      interval: 5,
      stableReads: 1,
    });
    watcher.start(snap(1));
    current = snap(2);
    for (let wait = 0; wait < 100 && seen.length === 0; wait += 1) await new Promise((resolve) => realSetTimeout(resolve, 5));
    watcher.stop();
    assert.deepEqual(seen, [2]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("keeps polling after read errors and after a failing change handler", async () => {
  const clock = fakeTimers();
  let fail = true;
  let current = snap(1);
  const errors: unknown[] = [];
  let calls = 0;
  const watcher = sync.createChangeWatcher({
    readSnapshot: async () => { if (fail) throw new Error("locked"); return current; },
    onChange: () => { calls += 1; throw new Error("reload failed"); },
    onError: (error) => errors.push(error),
    stableReads: 1,
    timers: clock.timers,
  });
  watcher.start(snap(1));
  await clock.run(2);
  assert.equal(errors.length, 2);
  fail = false;
  current = snap(2);
  await clock.run(4);
  assert.equal(calls, 1, "a failed reload is not retried in a loop");
  assert.equal(errors.length, 3);
  watcher.stop();
});

function fakeFile(name: string, log: string[], { failFill = false, failClose = false } = {}): Target {
  return {
    name,
    open: async () => ({
      close: async () => { if (failClose) throw new Error("disk full"); log.push(`close ${name}`); },
      abort: async () => { log.push(`abort ${name}`); },
    }),
    fill: async () => { if (failFill) throw new Error("connection lost"); log.push(`fill ${name}`); },
  };
}

test("replaces files only after all of them were fully written", async () => {
  const log: string[] = [];
  const committed = await sync.commitAtomically([fakeFile("a.dat", log), fakeFile("a.spr", log), fakeFile("a.otfi", log)]);
  assert.deepEqual(committed, ["a.dat", "a.spr", "a.otfi"]);
  assert.deepEqual(log, ["fill a.dat", "fill a.spr", "fill a.otfi", "close a.dat", "close a.spr", "close a.otfi"]);
});

test("a failed write discards every swap file and replaces nothing", async () => {
  const log: string[] = [];
  await assert.rejects(
    sync.commitAtomically([fakeFile("a.dat", log), fakeFile("a.spr", log, { failFill: true }), fakeFile("a.otfi", log)]),
    (error: Error & { committed?: string[] }) => {
      assert.match(error.message, /Falha ao gravar a\.spr: connection lost\. Nenhum arquivo da pasta foi alterado\./);
      assert.deepEqual(error.committed, []);
      return true;
    },
  );
  assert.ok(!log.some((line) => line.startsWith("close")), "no file was committed");
  assert.deepEqual(log.filter((line) => line.startsWith("abort")).sort(), ["abort a.dat", "abort a.spr"]);
});

test("a failed commit names the files already replaced", async () => {
  const log: string[] = [];
  await assert.rejects(
    sync.commitAtomically([fakeFile("a.dat", log), fakeFile("a.spr", log, { failClose: true }), fakeFile("a.otfi", log)]),
    (error: Error & { committed?: string[] }) => {
      assert.match(error.message, /Falha ao substituir a\.spr: disk full\. Já substituídos: a\.dat\./);
      assert.deepEqual(error.committed, ["a.dat"]);
      return true;
    },
  );
  assert.ok(log.includes("abort a.otfi"));
});

test("clamps a page to the available range", () => {
  assert.equal(sync.clampPage(5, 250, 100), 2);
  assert.equal(sync.clampPage(1, 0, 100), 0);
  assert.equal(sync.clampPage(-1, 10, 100), 0);
});
