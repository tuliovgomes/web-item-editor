/* Pure, DOM-free helpers for the project folder: picking the DAT/SPR/OTFI set, watching it for external changes
   and replacing its files without leaving a half-written set. Loaded as a classic script in the browser
   (global `FolderSync`) and as a CommonJS module by the tests. */
(function (root) {
  "use strict";

  const PROJECT_FILE = /^(.+)\.(dat|spr|otfi)$/i;
  // Files worth listing when a folder is scanned: the legacy set and the modern client catalog.
  const RELEVANT_FILE = /\.(dat|spr|otfi)$|^catalog-content\.json$|^sprites-.+\.bmp\.lzma$/i;
  const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

  function isRelevantName(name) {
    return RELEVANT_FILE.test(name);
  }

  function isSkippedDirectory(name) {
    return SKIPPED_DIRECTORIES.has(name);
  }

  /** Entries are `{ name, path }` objects (extra fields are kept); returns the chosen `{ dat, spr, otfi? }`. */
  function findProjectFiles(entries) {
    const candidates = { dat: [], spr: [], otfi: [] };
    for (const entry of entries) {
      const match = PROJECT_FILE.exec(entry.name);
      if (match) candidates[match[2].toLowerCase()].push({ entry, stem: match[1].toLowerCase() });
    }

    if (!candidates.dat.length || !candidates.spr.length) {
      throw new Error("A pasta selecionada precisa conter um arquivo .dat e um arquivo .spr.");
    }

    const matchingPairs = candidates.dat.flatMap((dat) =>
      candidates.spr.filter((spr) => spr.stem === dat.stem).map((spr) => ({ dat, spr })),
    );
    let selectedPair;
    if (matchingPairs.length === 1) {
      selectedPair = matchingPairs[0];
    } else if (candidates.dat.length === 1 && candidates.spr.length === 1) {
      selectedPair = { dat: candidates.dat[0], spr: candidates.spr[0] };
    } else {
      throw new Error("Encontrei mais de um DAT/SPR. Deixe apenas um par na pasta ou use nomes correspondentes.");
    }

    const matchingOtfi = candidates.otfi.filter((candidate) => candidate.stem === selectedPair.dat.stem);
    let otfi;
    if (matchingOtfi.length === 1) otfi = matchingOtfi[0].entry;
    else if (matchingOtfi.length > 1 || (!matchingOtfi.length && candidates.otfi.length > 1)) {
      throw new Error("Encontrei mais de um OTFI. Deixe apenas um OTFI correspondente ao DAT.");
    } else if (candidates.otfi.length === 1) otfi = candidates.otfi[0].entry;

    return { dat: selectedPair.dat.entry, spr: selectedPair.spr.entry, otfi };
  }

  function findCatalogEntry(entries) {
    return entries.find((entry) => entry.name === "catalog-content.json");
  }

  /**
   * A snapshot is a sorted list of `[name, "size:lastModified"]` pairs; `key` compares two snapshots cheaply.
   * Only metadata is read, never file contents, so polling stays inexpensive even for multi-GB SPR files.
   */
  function makeSnapshot(files) {
    const pairs = files.map(({ name, size, lastModified }) => [name, `${size}:${lastModified}`]);
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { key: pairs.map(([name, signature]) => `${name}=${signature}`).join("|"), files: new Map(pairs) };
  }

  function diffSnapshots(previous, next) {
    const added = [];
    const changed = [];
    const removed = [];
    for (const [name, signature] of next.files) {
      if (!previous.files.has(name)) added.push(name);
      else if (previous.files.get(name) !== signature) changed.push(name);
    }
    for (const name of previous.files.keys()) if (!next.files.has(name)) removed.push(name);
    return { added, changed, removed };
  }

  /**
   * Polls `readSnapshot()` and calls `onChange(next, previous)` once per settled external change.
   * - A change must read the same on `stableReads` consecutive polls, so a file still being written (or the burst
   *   of events one save produces) is reported once, after it settles.
   * - Polls are skipped while paused, while a previous poll or `onChange` is still running, and never overlap.
   * - After `onChange` the new snapshot becomes the baseline whatever the handler decided, so a failed reload or a
   *   dismissed prompt is not repeated in a loop. Writes made by the editor itself call `acknowledge()` instead.
   */
  function createChangeWatcher({
    readSnapshot,
    onChange,
    onError = () => {},
    interval = 1500,
    stableReads = 2,
    // Wrapped: browsers throw "Illegal invocation" when window.setTimeout is called as a method of another object.
    timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  }) {
    let baseline = null;
    let pending = null;
    let pendingReads = 0;
    let timer = null;
    let running = false;
    let paused = 0;
    let stopped = true;

    function schedule() {
      if (stopped) return;
      timers.clearTimeout(timer);
      timer = timers.setTimeout(tick, interval);
    }

    async function tick() {
      timer = null;
      if (stopped) return;
      if (paused > 0 || running) {
        schedule();
        return;
      }
      running = true;
      try {
        await poll();
      } finally {
        running = false;
        schedule();
      }
    }

    async function poll() {
      let next;
      try {
        next = await readSnapshot();
      } catch (error) {
        onError(error);
        return;
      }
      // A pause or acknowledge that happened while the read was in flight makes this read stale.
      if (stopped || paused > 0 || baseline === null) return;
      if (next.key === baseline.key) {
        pending = null;
        pendingReads = 0;
        return;
      }
      if (pending === null || pending.key !== next.key) {
        pending = next;
        pendingReads = 1;
      } else {
        pendingReads += 1;
      }
      if (pendingReads < stableReads) return;
      const previous = baseline;
      baseline = next;
      pending = null;
      pendingReads = 0;
      try {
        await onChange(next, previous);
      } catch (error) {
        onError(error);
      }
    }

    return {
      start(initial) {
        baseline = initial;
        pending = null;
        pendingReads = 0;
        stopped = false;
        schedule();
      },
      stop() {
        stopped = true;
        timers.clearTimeout(timer);
        timer = null;
        baseline = null;
        pending = null;
      },
      /** Accepts `snapshot` as current without reporting it (used after the editor writes the files itself). */
      acknowledge(snapshot) {
        baseline = snapshot;
        pending = null;
        pendingReads = 0;
      },
      /** Suspends change reports until the returned promise settles; nests safely. */
      async pausedWhile(work) {
        paused += 1;
        try {
          return await work();
        } finally {
          paused -= 1;
          pending = null;
          pendingReads = 0;
        }
      },
      /** Polls on the next turn instead of waiting for the interval (e.g. when the window regains focus). */
      checkSoon() {
        if (!stopped && timer !== null) {
          timers.clearTimeout(timer);
          timer = timers.setTimeout(tick, 0);
        }
      },
      get active() {
        return !stopped;
      },
      get baseline() {
        return baseline;
      },
    };
  }

  /**
   * Replaces several files as a unit. Each target is `{ name, open(), fill(writable) }`, where `open()` returns a
   * writable that only replaces the real file on `close()` (as FileSystemWritableFileStream does, through a swap
   * file). Every file is fully written first; if any open or write fails, all swap files are discarded with
   * `abort()` and the originals stay untouched. Only then are the files committed one after another.
   */
  async function commitAtomically(targets) {
    const opened = [];
    let current;
    try {
      for (const target of targets) {
        current = target;
        const writable = await target.open();
        opened.push({ target, writable });
        await target.fill(writable);
      }
    } catch (error) {
      await Promise.all(opened.map(({ writable }) => Promise.resolve().then(() => writable.abort()).catch(() => {})));
      const reason = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`Falha ao gravar ${current?.name ?? "os arquivos"}: ${reason}. Nenhum arquivo da pasta foi alterado.`);
      wrapped.committed = [];
      wrapped.cause = error;
      throw wrapped;
    }

    const committed = [];
    for (let index = 0; index < opened.length; index += 1) {
      const { target, writable } = opened[index];
      try {
        await writable.close();
        committed.push(target.name);
      } catch (error) {
        await Promise.all(opened.slice(index + 1).map(({ writable: rest }) => Promise.resolve().then(() => rest.abort()).catch(() => {})));
        const reason = error instanceof Error ? error.message : String(error);
        const kept = committed.length ? ` Já substituídos: ${committed.join(", ")}.` : " Nenhum arquivo foi substituído.";
        const wrapped = new Error(`Falha ao substituir ${target.name}: ${reason}.${kept}`);
        wrapped.committed = committed;
        wrapped.cause = error;
        throw wrapped;
      }
    }
    return committed;
  }

  function clampPage(page, total, pageSize) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    return Math.min(Math.max(0, page), pages - 1);
  }

  const api = {
    isRelevantName, isSkippedDirectory, findProjectFiles, findCatalogEntry, makeSnapshot, diffSnapshots,
    createChangeWatcher, commitAtomically, clampPage,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FolderSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
