const $ = (selector) => document.querySelector(selector);
const FS = globalThis.FolderSync;

const state = {
  summary: null,
  savedRevision: null, // server revision that matches the files on disk (set on open, reload and save)
  selected: null,
  page: 0,
  pageSize: 100,
  records: [],
  spriteInfo: null,
  sprites: { page: 0, pageSize: 192, selected: new Set(), anchor: null, rendered: false },
  clipboard: null,
  recordSel: { category: null, ids: new Set(), anchor: null },
  contextIds: [],
};

const booleanFields = [
  ["isGround", "Ground"], ["isGroundBorder", "Ground border"], ["isOnBottom", "On bottom"],
  ["isOnTop", "On top"], ["isContainer", "Container"], ["isStackable", "Stackable"],
  ["isUseable", "Useable"], ["isWritable", "Writable"], ["writableOnce", "Writable once"],
  ["isFluidContainer", "Fluid container"], ["isFluid", "Fluid"], ["isUnpassable", "Unpassable"],
  ["isUnmoveable", "Unmoveable"], ["blocksMissiles", "Blocks missiles"],
  ["blocksPathfinder", "Blocks pathfinder"], ["isPickupable", "Pickupable"],
  ["isHangable", "Hangable"], ["isHorizontal", "Hook east"], ["isVertical", "Hook south"],
  ["isRotatable", "Rotatable"], ["hasLight", "Light"], ["dontHide", "Do not hide"],
  ["isTranslucent", "Translucent"], ["hasOffset", "Offset"], ["hasBones", "Bones"],
  ["hasElevation", "Elevation"], ["isLyingObject", "Lying object"], ["animateAlways", "Animate always"],
  ["hasMinimapColor", "Minimap color"], ["fullGround", "Full ground"], ["ignoreLook", "Ignore look"],
  ["floorChange", "Floor change"], ["forceUse", "Force use"], ["hasCloth", "Cloth data"],
  ["hasMarket", "Market data"], ["hasAction", "Default action"], ["wrappable", "Wrappable"],
  ["unwrappable", "Unwrappable"], ["topEffect", "Top effect"], ["chargeable", "Chargeable"],
  ["noMoveAnimation", "No move animation"], ["usable", "Usable"],
];

const numberFields = [
  ["groundSpeed", "Ground speed"], ["maxTextLength", "Maximum text length"],
  ["lightLevel", "Light level"], ["lightColor", "Light color"], ["offsetX", "Offset X"],
  ["offsetY", "Offset Y"], ["elevation", "Elevation value"], ["minimapColor", "Minimap color value"],
  ["lensHelp", "Lens help"], ["clothSlot", "Cloth slot"], ["marketCategory", "Market category"],
  ["marketTradeAs", "Market trade-as"], ["marketShowAs", "Market show-as"],
  ["marketVocation", "Market vocation"], ["marketLevel", "Market level"], ["defaultAction", "Default action"],
];

const extraNumberFields = Array.from({ length: 4 }, (_, index) => [
  [`boneOffsetX${index}`, `Bone ${index} X`], [`boneOffsetY${index}`, `Bone ${index} Y`],
]).flat();

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const message = contentType.includes("json") ? (await response.json()).error : await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }
  return contentType.includes("json") ? response.json() : response;
}

/**
 * Writes the status line (always) and, unless `popup` is false, surfaces the outcome through SweetAlert2:
 * errors as a modal alert and successes as a toast. Plain progress messages (no kind) stay in the status line.
 * Flows that show their own SweetAlert2 dialog pass `popup: false` so the user is not notified twice.
 */
function setMessage(message, kind = "", { popup = true } = {}) {
  const element = $("#message");
  element.textContent = message;
  element.className = `message ${kind}`;
  const modal = $("#modalMessage");
  modal.textContent = message;
  modal.className = `message ${kind}`;
  if (!popup) return;
  if (kind === "error") Dialogs.error("Não foi possível concluir a operação", { text: message });
  else if (kind === "success") Dialogs.toast(message);
}

function setBusy(button, busy, busyText = "Processando…") {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}

function currentCategory() {
  return $("#category").value;
}

async function uploadFile(kind, file, session = "") {
  return api(`/api/upload?kind=${kind}&session=${session}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
}

/* Project folder. With the File System Access API (Chromium) the folder is opened with a read/write handle, so
   "Validar e compilar" can replace the opened files in place and the folder can be watched for external edits.
   Other browsers fall back to <input webkitdirectory>, which is read-only: compiled files are then downloaded. */

const supportsFolderAccess = typeof globalThis.showDirectoryPicker === "function";
const folderState = {
  root: null, // FileSystemDirectoryHandle of the picked folder (null with the <input> fallback)
  entries: [], // { name, path, file? , handle?, dir? } for every relevant file found in the folder
  project: null, // { dat, spr, otfi? } entries of the open project, when they can be written back
  watcher: null,
  watchErrorAt: 0,
};
const projectLock = { name: null };

if (supportsFolderAccess) {
  $("#folderPicker").classList.remove("hidden");
  $("#folderInputLabel").classList.add("hidden");
}

/** Runs `work` unless another folder operation (open, reload, save) is in progress. */
async function withProjectLock(name, work) {
  if (projectLock.name) throw new Error(`Aguarde: ${projectLock.name} em andamento.`);
  projectLock.name = name;
  try {
    return await work();
  } finally {
    projectLock.name = null;
  }
}

async function scanDirectory(directory, prefix = directory.name, found = []) {
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === "directory") {
      if (!FS.isSkippedDirectory(name)) await scanDirectory(handle, `${prefix}/${name}`, found);
    } else if (FS.isRelevantName(name)) {
      found.push({ name, path: `${prefix}/${name}`, handle, dir: directory, dirPath: prefix });
    }
  }
  return found;
}

function entryFile(entry) {
  return entry.file ?? entry.handle.getFile();
}

function describeFolder(entries) {
  if (!entries.length) return "Nenhum arquivo DAT/SPR/OTFI ou catalog-content.json nesta pasta.";
  const catalog = FS.findCatalogEntry(entries);
  if (catalog) {
    const sheets = entries.filter((entry) => /^sprites-.+\.bmp\.lzma$/i.test(entry.name)).length;
    return `${catalog.name} · ${sheets} folhas de sprites (cliente moderno)`;
  }
  try {
    const selected = FS.findProjectFiles(entries);
    return [selected.dat.path, selected.spr.path, selected.otfi?.path ?? "OTFI não encontrado (opcional)"].join(" · ");
  } catch (error) {
    return error.message;
  }
}

async function pickFolder() {
  let root;
  try {
    root = await globalThis.showDirectoryPicker({ id: "oteditor-project", mode: "readwrite" });
  } catch (error) {
    if (error?.name === "AbortError") return;
    Dialogs.error("Não foi possível abrir a pasta", { text: error.message });
    return;
  }
  const button = $("#pickFolder");
  try {
    setBusy(button, true, "Lendo pasta…");
    folderState.root = root;
    folderState.entries = await scanDirectory(root);
    $("#pickedFolder").textContent = root.name;
    $("#folderContents").textContent = describeFolder(folderState.entries);
  } catch (error) {
    folderState.root = null;
    folderState.entries = [];
    Dialogs.error("Não foi possível ler a pasta", { text: error.message });
  } finally {
    setBusy(button, false);
  }
}

$("#pickFolder").addEventListener("click", pickFolder);

/**
 * Uploads the chosen DAT/SPR/OTFI and opens them on the server; returns the open result. Each call stages its
 * files under its own session, so another tab opening at the same moment cannot swap in its own DAT or SPR.
 */
async function uploadAndOpen(picked) {
  const session = crypto.randomUUID();
  const dat = await entryFile(picked.dat);
  const spr = await entryFile(picked.spr);
  const otfi = picked.otfi ? await entryFile(picked.otfi) : undefined;
  setMessage(`Enviando ${dat.name}…`);
  await uploadFile("dat", dat, session);
  setMessage(`Enviando ${spr.name} (${formatBytes(spr.size)})…`);
  await uploadFile("spr", spr, session);
  if (otfi) {
    setMessage(`Enviando ${otfi.name}…`);
    await uploadFile("otfi", otfi, session);
  }
  const version = Number($("#clientVersion").value);
  return api(`/api/project/open?clientVersion=${encodeURIComponent(version)}&session=${session}`, { method: "POST" });
}

async function openProject() {
  const button = $("#openProject");
  try {
    await withProjectLock("abertura do projeto", async () => {
      setBusy(button, true, "Lendo arquivos…");
      const entries = folderState.entries;
      if (!entries.length) {
        throw new Error(supportsFolderAccess ? "Escolha a pasta do projeto." : "Selecione a pasta do projeto.");
      }
      if (FS.findCatalogEntry(entries)) {
        await openCatalog(entries);
        stopWatching();
        folderState.project = null;
        return;
      }
      const picked = FS.findProjectFiles(entries);
      const result = await uploadAndOpen(picked);
      stopWatching();
      // Only handle-backed files (File System Access API) can be replaced in place.
      folderState.project = picked.dat.handle && picked.spr.handle ? picked : null;
      startProject(result.summary);
      updateCompileTarget();
      const warnings = result.summary.warnings ?? [];
      setMessage(
        warnings.length ? `Projeto aberto com aviso: ${warnings.join(" ")}` : "Projeto aberto.",
        warnings.length ? "" : "success",
      );
      if (folderState.project) await startWatching();
      rememberFolder();
    });
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

$("#projectFolder").addEventListener("change", () => {
  const files = [...$("#projectFolder").files];
  folderState.root = null;
  folderState.entries = files
    .filter((file) => FS.isRelevantName(file.name))
    .map((file) => ({ name: file.name, path: file.webkitRelativePath || file.name, file }));
  $("#folderContents").textContent = files.length
    ? describeFolder(folderState.entries)
    : "Selecione uma pasta que contenha os arquivos do cliente.";
});

/* Compile destination and external-change watching */

function updateCompileTarget() {
  const target = folderState.project;
  $("#compileTarget").textContent = target
    ? `Destino: ${[target.dat, target.spr, target.otfi].filter(Boolean).map((entry) => entry.path).join(" · ")}`
    : supportsFolderAccess
      ? "Sem pasta de destino: abra o projeto com “Escolher pasta…” para gravar nela. Sem isso, os arquivos compilados são apenas baixados."
      : "Este navegador não permite gravar na pasta (use Chrome ou Edge). Os arquivos compilados são baixados.";
}

function hasUnsavedChanges() {
  return state.summary !== null && state.summary.revision !== state.savedRevision;
}

/** Directories that hold the open project's files; only these are listed on each poll (never recursively). */
function watchedDirectories() {
  const dirs = new Map();
  for (const entry of [folderState.project?.dat, folderState.project?.spr, folderState.project?.otfi]) {
    if (entry?.dir) dirs.set(entry.dirPath, entry.dir);
  }
  return dirs;
}

async function listProjectDirectories() {
  const entries = [];
  for (const [dirPath, dir] of watchedDirectories()) {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && /\.(dat|spr|otfi)$/i.test(name)) {
        entries.push({ name, path: `${dirPath}/${name}`, handle, dir, dirPath });
      }
    }
  }
  return entries;
}

async function readFolderSnapshot() {
  const entries = await listProjectDirectories();
  const files = [];
  for (const entry of entries) {
    try {
      const file = await entry.handle.getFile();
      files.push({ name: entry.path, size: file.size, lastModified: file.lastModified });
    } catch (error) {
      // Deleted between the listing and the read: it is reported as removed by the next poll.
      if (error?.name !== "NotFoundError") throw error;
    }
  }
  return FS.makeSnapshot(files);
}

function setWatchStatus(text, kind = "watching") {
  const chip = $("#watchStatus");
  chip.textContent = text;
  chip.className = `status-pill ${kind}`;
  chip.classList.toggle("hidden", !text);
}

async function startWatching() {
  stopWatching();
  if (!folderState.project) return;
  const watcher = FS.createChangeWatcher({
    readSnapshot: readFolderSnapshot,
    onChange: handleExternalChange,
    onError: handleWatchError,
  });
  folderState.watcher = watcher;
  watcher.start(await readFolderSnapshot());
  setWatchStatus("● monitorando pasta");
}

function stopWatching() {
  folderState.watcher?.stop();
  folderState.watcher = null;
  setWatchStatus("");
}

function handleWatchError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    stopWatching();
    setWatchStatus("monitoramento parado", "watch-error");
    Dialogs.warning("Monitoramento da pasta interrompido", {
      text: "O navegador retirou a permissão de acesso à pasta. Abra a pasta novamente para voltar a monitorá-la.",
    });
    return;
  }
  setWatchStatus("● erro ao ler a pasta", "watch-error");
  const now = Date.now();
  if (now - folderState.watchErrorAt > 30_000) {
    folderState.watchErrorAt = now;
    setMessage(`Não foi possível verificar a pasta: ${error?.message ?? error}. Nova tentativa em instantes.`, "error", { popup: false });
  }
}

async function handleExternalChange(next, previous) {
  if (projectLock.name || importState.running) {
    // A save, reload or import owns the project right now; look again once it is done.
    folderState.watcher?.acknowledge(previous);
    return;
  }
  setWatchStatus("● monitorando pasta");
  const { added, changed, removed } = FS.diffSnapshots(previous, next);
  const lines = [
    ...changed.map((name) => `alterado: ${name}`),
    ...added.map((name) => `novo: ${name}`),
    ...removed.map((name) => `removido: ${name}`),
  ];
  let picked;
  try {
    picked = FS.findProjectFiles(await listProjectDirectories());
  } catch (error) {
    await Dialogs.warning("Arquivos do projeto indisponíveis", {
      html: `<p>${Dialogs.escapeHtml(error.message)}</p>${Dialogs.list(lines)}<p>O projeto continua aberto na memória do editor.</p>`,
    });
    return;
  }
  if (hasUnsavedChanges()) {
    const reload = await Dialogs.confirm({
      title: "Arquivos alterados fora do editor",
      html: `${Dialogs.list(lines)}<p>Recarregar descarta as alterações ainda não gravadas na pasta.</p>`,
      confirmText: "Recarregar e descartar",
      cancelText: "Manter minhas alterações",
      danger: true,
    });
    if (!reload) {
      setMessage("Mudança externa ignorada; suas alterações continuam no editor.");
      return;
    }
  }
  try {
    await withProjectLock("recarga do projeto", () => reloadProject(picked));
    Dialogs.toast(`Projeto recarregado (${lines.length} alteração(ões) na pasta).`, "info");
  } catch (error) {
    Dialogs.error("Falha ao recarregar o projeto", {
      text: `${error.message}. O projeto anterior continua aberto.`,
    });
  }
}

/** Re-opens the folder's files and keeps the category, pages, selections, viewed sprite and open record. */
async function reloadProject(picked) {
  const result = await uploadAndOpen(picked);
  folderState.project = picked;
  rememberFolder();
  updateCompileTarget();
  startProject(result.summary, { preserve: true });
  setMessage("Projeto recarregado da pasta.", "", { popup: false });
}

window.addEventListener("focus", () => folderState.watcher?.checkSoon());

const catalogState = { ids: new Int32Array(0), page: 0, pageSize: 120, cache: new Map(), token: 0 };
const CATALOG_UPLOAD_CONCURRENCY = 6;
const CATALOG_CACHE_LIMIT = 2000;

async function openCatalog(entries) {
  setMessage("Lendo catalog-content.json…");
  const catalogEntry = FS.findCatalogEntry(entries);
  const opened = await api("/api/catalog/open", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: await entryFile(catalogEntry),
  });
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const folderVersion = catalogEntry.path.split("/").at(-2) ?? "";
  objectsState.clientVersion = /^\d{3,5}$/.test(folderVersion) ? Number(folderVersion) : 0;
  const missing = opened.files.filter((name) => !byName.has(name));
  if (missing.length === opened.files.length) {
    throw new Error("A pasta tem o catalog-content.json, mas nenhuma folha sprites-*.bmp.lzma.");
  }
  const queue = opened.files.filter((name) => byName.has(name));
  let done = 0;
  const workers = Array.from({ length: CATALOG_UPLOAD_CONCURRENCY }, async () => {
    while (queue.length) {
      const name = queue.shift();
      await api(`/api/catalog/sheet?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: await entryFile(byName.get(name)),
      });
      done += 1;
      if (done % 50 === 0 || !queue.length) setMessage(`Enviando folhas de sprites… ${done}/${opened.files.length - missing.length}`);
    }
  });
  await Promise.all(workers);
  let summary = opened.summary;
  const appearancesEntry = summary.appearancesFile ? byName.get(summary.appearancesFile) : undefined;
  const appearances = appearancesEntry ? await entryFile(appearancesEntry) : undefined;
  if (appearances) {
    setMessage(`Lendo ${appearances.name} (${formatBytes(appearances.size)})…`);
    summary = (await api("/api/catalog/appearances", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: appearances,
    })).summary;
  }
  catalogState.cache.clear();
  catalogState.page = 0;
  catalogState.token += 1;
  applyCatalogSummary(summary, missing.length);
}

function applyCatalogSummary(summary, missingSheets) {
  const total = summary.ranges.reduce((sum, [first, last]) => sum + last - first + 1, 0);
  const ids = new Int32Array(total);
  let index = 0;
  for (const [first, last] of summary.ranges) for (let id = first; id <= last; id += 1) ids[index++] = id;
  catalogState.ids = ids;
  $("#catalogCard").classList.remove("hidden");
  $("#catalogCount").textContent = `${summary.spriteCount} sprites`;
  $("#projectStatus").textContent = `catálogo · ${summary.spriteCount} sprites`;
  renderCatalogGrid();
  loadCatalogSprite(ids[0] ?? 0).catch(() => {});
  applyObjectsSummary(summary);
  setMessage(
    missingSheets ? `Catálogo aberto, mas faltam ${missingSheets} folhas na pasta; esses sprites ficam vazios.` : "Catálogo de sprites carregado. Os arquivos ficam somente na memória do editor local.",
    missingSheets ? "" : "success",
  );
}

async function fetchCatalogSprite(id) {
  const cached = catalogState.cache.get(id);
  if (cached) return cached;
  const response = await api(`/api/catalog/sprite?id=${id}`);
  const sprite = {
    width: Number(response.headers.get("x-sprite-width")),
    height: Number(response.headers.get("x-sprite-height")),
    rgba: new Uint8ClampedArray(await response.arrayBuffer()),
  };
  if (catalogState.cache.size >= CATALOG_CACHE_LIMIT) catalogState.cache.delete(catalogState.cache.keys().next().value);
  catalogState.cache.set(id, sprite);
  return sprite;
}

function drawCatalogSprite(canvas, sprite, box) {
  canvas.width = sprite.width;
  canvas.height = sprite.height;
  canvas.getContext("2d").putImageData(new ImageData(sprite.rgba, sprite.width, sprite.height), 0, 0);
  if (box) {
    const scale = box / Math.max(sprite.width, sprite.height);
    canvas.style.width = `${sprite.width * scale}px`;
    canvas.style.height = `${sprite.height * scale}px`;
  }
}

function renderCatalogGrid() {
  const { ids, pageSize } = catalogState;
  const pages = Math.max(1, Math.ceil(ids.length / pageSize));
  catalogState.page = Math.min(catalogState.page, pages - 1);
  const start = catalogState.page * pageSize;
  const end = Math.min(ids.length, start + pageSize);
  $("#catalogPageLabel").textContent = ids.length ? `/ ${pages} · IDs ${ids[start]}–${ids[end - 1]}` : "sem sprites";
  const input = $("#catalogPageInput");
  input.disabled = !ids.length;
  input.max = String(pages);
  input.value = ids.length ? String(catalogState.page + 1) : "";
  $("#catalogPrev").disabled = catalogState.page === 0;
  $("#catalogNext").disabled = end >= ids.length;

  const grid = $("#catalogGrid");
  grid.replaceChildren();
  const token = ++catalogState.token;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      fetchCatalogSprite(Number(entry.target.dataset.id)).then((sprite) => {
        if (token === catalogState.token) drawCatalogSprite(entry.target.querySelector("canvas"), sprite, 48);
      }).catch(() => {});
    }
  }, { root: grid });
  for (let index = start; index < end; index += 1) {
    const tile = document.createElement("button");
    tile.className = "sprite-tile";
    tile.dataset.id = String(ids[index]);
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const label = document.createElement("span");
    label.textContent = String(ids[index]);
    tile.append(canvas, label);
    grid.append(tile);
    observer.observe(tile);
  }
}

async function loadCatalogSprite(id) {
  const sprite = await fetchCatalogSprite(id);
  drawCatalogSprite($("#catalogCanvas"), sprite, Math.min(224, Math.max(sprite.width, sprite.height) * 4));
  $("#catalogSpriteId").value = String(id);
  $("#catalogInfo").textContent = `Sprite ${id} · ${sprite.width} × ${sprite.height} px`;
  document.querySelectorAll("#catalogGrid .sprite-tile").forEach((tile) => {
    tile.classList.toggle("selected", Number(tile.dataset.id) === id);
  });
}

function gotoCatalogId(id) {
  const index = catalogState.ids.indexOf(id);
  if (index < 0) throw new Error(`O catálogo não tem o sprite ${id}.`);
  const page = Math.floor(index / catalogState.pageSize);
  if (page !== catalogState.page) {
    catalogState.page = page;
    renderCatalogGrid();
  }
  return loadCatalogSprite(id);
}

$("#catalogGrid").addEventListener("click", (event) => {
  const tile = event.target.closest(".sprite-tile");
  if (tile) loadCatalogSprite(Number(tile.dataset.id)).catch((error) => setMessage(error.message, "error"));
});
$("#catalogPrev").addEventListener("click", () => { catalogState.page -= 1; renderCatalogGrid(); });
$("#catalogNext").addEventListener("click", () => { catalogState.page += 1; renderCatalogGrid(); });
$("#catalogPageInput").addEventListener("change", () => {
  const page = Number($("#catalogPageInput").value);
  if (Number.isInteger(page) && page >= 1) catalogState.page = page - 1;
  renderCatalogGrid();
});
$("#catalogGo").addEventListener("click", () => {
  gotoCatalogId(Number($("#catalogSpriteId").value)).catch((error) => setMessage(error.message, "error"));
});

const objectsState = { category: "items", page: 0, pageSize: 60, total: 0, records: [], selected: null, token: 0, timer: null, playToken: 0, picked: new Set(), anchor: null, clientVersion: 0, exporting: false };

function applyObjectsSummary(summary) {
  const card = $("#objectsCard");
  card.classList.toggle("hidden", !summary.appearances);
  if (!summary.appearances) return;
  const counts = summary.appearances;
  $("#objectsCount").textContent = `${counts.items} itens · ${counts.outfits} outfits · ${counts.effects} efeitos · ${counts.missiles} projéteis`;
  objectsState.page = 0;
  objectsState.selected = null;
  objectsState.picked.clear();
  updateObjectsExport();
  refreshObjects();
}

function updateObjectsExport() {
  const button = $("#objectsExport");
  const count = objectsState.picked.size;
  button.disabled = objectsState.exporting || count === 0;
  button.textContent = count > 1 ? `Exportar ${count} (.obd em ZIP)` : "Exportar .obd";
}

function pickObject(record, event) {
  const picked = objectsState.picked;
  if (event.shiftKey && objectsState.anchor !== null) {
    const ids = objectsState.records.map((item) => item.id);
    const [from, to] = [ids.indexOf(objectsState.anchor), ids.indexOf(record.id)].sort((a, b) => a - b);
    if (!event.ctrlKey && !event.metaKey) picked.clear();
    if (from >= 0) ids.slice(from, to + 1).forEach((id) => picked.add(id));
  } else if (event.ctrlKey || event.metaKey) {
    if (!picked.delete(record.id)) picked.add(record.id);
    objectsState.anchor = record.id;
  } else {
    picked.clear();
    picked.add(record.id);
    objectsState.anchor = record.id;
  }
  document.querySelectorAll("#objectsGrid .sprite-tile").forEach((tile) => {
    tile.classList.toggle("selected", picked.has(objectsState.records[Number(tile.dataset.index)]?.id));
  });
  updateObjectsExport();
}

async function exportModernObd() {
  const category = objectsState.category;
  const ids = [...objectsState.picked].sort((a, b) => a - b);
  if (!ids.length || objectsState.exporting) return;
  objectsState.exporting = true;
  updateObjectsExport();
  const status = $("#objectsStatus");
  const started = performance.now();
  const results = new Array(ids.length);
  const problems = [];
  let finished = 0;
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const index = next++;
      const query = new URLSearchParams({ category, id: String(ids[index]), clientVersion: String(objectsState.clientVersion) });
      try {
        const response = await api(`/api/catalog/obd?${query}`);
        JSON.parse(decodeURIComponent(response.headers.get("x-obd-warnings") || "%5B%5D")).forEach((warning) => problems.push(warning));
        results[index] = { name: `${category}_${ids[index]}.obd`, data: new Uint8Array(await response.arrayBuffer()) };
      } catch (error) {
        problems.push(`falha ${category} ${ids[index]}: ${error.message}`);
      }
      finished += 1;
      status.textContent = `Exportando OBD ${finished}/${ids.length}…`;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    const entries = results.filter(Boolean);
    if (!entries.length) throw new Error(problems[0] ?? "nenhum objeto exportado");
    if (entries.length === 1) downloadBytes(entries[0].data, entries[0].name, "application/octet-stream");
    else downloadBytes(IO.buildZip(entries), `${category}_${ids[0]}-${ids.at(-1)}_obd.zip`, "application/zip");
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const notes = problems.length ? ` Avisos: ${problems.slice(0, 3).join(" | ")}${problems.length > 3 ? " …" : ""}` : "";
    const version = objectsState.clientVersion ? "" : " A versão do cliente não foi detectada pelo nome da pasta; o OBD foi gravado com versão 0.";
    status.textContent = `${entries.length}/${ids.length} objeto(s) exportado(s) em .obd (${seconds} s).${version}${notes}`;
  } catch (error) {
    status.textContent = `Falha ao exportar OBD: ${error.message}`;
  } finally {
    objectsState.exporting = false;
    updateObjectsExport();
  }
}
$("#objectsExport").addEventListener("click", exportModernObd);

async function refreshObjects() {
  const token = ++objectsState.token;
  const query = new URLSearchParams({
    category: objectsState.category,
    offset: String(objectsState.page * objectsState.pageSize),
    limit: String(objectsState.pageSize),
  });
  const search = $("#objectsSearch").value.trim();
  if (search) query.set("search", search);
  try {
    const result = await api(`/api/catalog/objects?${query}`);
    if (token !== objectsState.token) return;
    objectsState.total = result.total;
    objectsState.records = result.records;
    renderObjectGrid();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

// Sprite order inside a group: frame, depth (z), pattern Y, pattern X (direction), layer.
function groupSpriteId(group, { frame = 0, x = 0, y = 0, z = 0, layer = 0 }) {
  const index = ((((frame * group.patternZ + z) * group.patternY + y) * group.patternX + x) * group.layers) + layer;
  return group.spriteIds[index] ?? 0;
}

function defaultDirection(record, group) {
  return record.category === "outfits" && group.patternX >= 3 ? 2 : 0;
}

async function drawObject(canvas, record, group, options, box) {
  const id = groupSpriteId(group, options);
  if (!id) return;
  drawCatalogSprite(canvas, await fetchCatalogSprite(id), box);
}

function renderObjectGrid() {
  const { records, pageSize, total } = objectsState;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  objectsState.page = Math.min(objectsState.page, pages - 1);
  $("#objectsPageLabel").textContent = total ? `/ ${pages} · ${total} objetos` : "nenhum objeto";
  const input = $("#objectsPageInput");
  input.disabled = !total;
  input.max = String(pages);
  input.value = total ? String(objectsState.page + 1) : "";
  $("#objectsPrev").disabled = objectsState.page === 0;
  $("#objectsNext").disabled = objectsState.page >= pages - 1;
  const grid = $("#objectsGrid");
  grid.replaceChildren();
  const token = objectsState.token;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const record = records[Number(entry.target.dataset.index)];
      const group = record.groups[previewGroupIndex(record)];
      if (!group || token !== objectsState.token) continue;
      drawObject(entry.target.querySelector("canvas"), record, group, { x: defaultDirection(record, group) }, 48).catch(() => {});
    }
  }, { root: grid });
  records.forEach((record, index) => {
    const tile = document.createElement("button");
    tile.className = `sprite-tile ${objectsState.picked.has(record.id) ? "selected" : ""}`;
    tile.dataset.index = String(index);
    tile.title = record.name ?? "";
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const label = document.createElement("span");
    label.textContent = String(record.id);
    tile.append(canvas, label);
    grid.append(tile);
    observer.observe(tile);
  });
}

function stopObjectAnimation() {
  clearTimeout(objectsState.timer);
  objectsState.timer = null;
  objectsState.playToken += 1;
}

function flagText(value) {
  if (Array.isArray(value)) return value.map(flagText).join(" | ");
  if (value !== null && typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}: ${item}`).join(", ");
  return value === true ? "sim" : String(value);
}

function selectObject(record) {
  objectsState.selected = record;
  stopObjectAnimation();
  $("#objectTitle").textContent = `${record.category} #${record.id}${record.name ? ` · ${record.name}` : ""}`;
  const groupSelect = $("#objectGroup");
  groupSelect.replaceChildren(...record.groups.map((group, index) => new Option(frameGroupLabel(record.category, group, index, record.groups.length), String(index))));
  groupSelect.value = String(previewGroupIndex(record));
  groupSelect.disabled = record.groups.length <= 1;
  const flags = $("#objectFlags");
  flags.replaceChildren();
  for (const [name, value] of Object.entries(record.flags)) {
    const term = document.createElement("dt");
    term.textContent = name;
    const detail = document.createElement("dd");
    detail.textContent = flagText(value);
    flags.append(term, detail);
  }
  if (!Object.keys(record.flags).length) $("#objectFlags").textContent = "Sem flags.";
  selectObjectGroup(previewGroupIndex(record));
}

function selectObjectGroup(index) {
  const record = objectsState.selected;
  const group = record?.groups[index];
  stopObjectAnimation();
  if (!group) return;
  const outfit = record.category === "outfits";
  fillPatternSelect($("#objectDirection"), group.patternX,
    (x) => (outfit && group.patternX === 4 ? DIRECTION_NAMES[x] : `Padrão X ${x}`), defaultDirection(record, group));
  fillPatternSelect($("#objectAddon"), group.patternY, (y) => (outfit ? (y === 0 ? "Sem addon" : `Addon ${y}`) : `Padrão Y ${y}`), 0);
  fillPatternSelect($("#objectMount"), group.patternZ, (z) => (outfit ? (z === 0 ? "Sem montaria" : `Montado${group.patternZ > 2 ? ` ${z}` : ""}`) : `Padrão Z ${z}`), 0);
  $("#objectAddon").classList.toggle("hidden", group.patternY <= 1);
  $("#objectMount").classList.toggle("hidden", group.patternZ <= 1);
  $("#objectMeta").textContent = `${group.width * 32}×${group.height * 32}px · camadas ${group.layers} · padrão ${group.patternX}×${group.patternY}×${group.patternZ} · frames ${group.frames}`;
  $("#objectSprites").textContent = `Sprites: ${group.spriteIds.length > 24 ? `${group.spriteIds.slice(0, 24).join(", ")}… (${group.spriteIds.length})` : group.spriteIds.join(", ")}`;
  playObject(record, group);
}

function playObject(record, group) {
  const canvas = $("#objectCanvas");
  const x = Number($("#objectDirection").value);
  const y = Number($("#objectAddon").value) || 0;
  const z = Number($("#objectMount").value) || 0;
  const token = objectsState.playToken;
  let frame = 0;
  const step = async () => {
    if (objectsState.selected !== record || objectsState.playToken !== token) return;
    $("#objectFrame").textContent = `Frame ${frame + 1}/${group.frames}${group.frames > 1 ? (group.animation ? " · durações do arquivo" : " · durações padrão") : ""}`;
    try {
      const id = groupSpriteId(group, { frame, x, y, z });
      if (id) {
        const sprite = await fetchCatalogSprite(id);
        drawCatalogSprite(canvas, sprite, Math.min(224, Math.max(sprite.width, sprite.height) * 4));
      } else {
        canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      }
    } catch {
      // Missing sprite sheets leave the previous frame in place.
    }
    // A newer play (other group/direction) may have started while this frame was loading.
    if (group.frames <= 1 || objectsState.selected !== record || objectsState.playToken !== token) return;
    const delay = frameDuration(record, group, frame);
    frame = (frame + 1) % group.frames;
    objectsState.timer = setTimeout(step, delay);
  };
  step();
}

$("#objectsGrid").addEventListener("click", (event) => {
  const tile = event.target.closest(".sprite-tile");
  if (!tile) return;
  const record = objectsState.records[Number(tile.dataset.index)];
  pickObject(record, event);
  selectObject(record);
});
$("#objectGroup").addEventListener("change", () => selectObjectGroup(Number($("#objectGroup").value)));
for (const selector of ["#objectDirection", "#objectAddon", "#objectMount"]) {
  $(selector).addEventListener("change", () => {
    const record = objectsState.selected;
    stopObjectAnimation();
    if (record) playObject(record, record.groups[Number($("#objectGroup").value)]);
  });
}
$("#objectsCategory").addEventListener("change", () => {
  objectsState.category = $("#objectsCategory").value;
  objectsState.picked.clear();
  updateObjectsExport();
  objectsState.page = 0;
  refreshObjects();
});
let objectsSearchTimer;
$("#objectsSearch").addEventListener("input", () => {
  clearTimeout(objectsSearchTimer);
  objectsSearchTimer = setTimeout(() => { objectsState.page = 0; refreshObjects(); }, 250);
});
$("#objectsPrev").addEventListener("click", () => { objectsState.page -= 1; refreshObjects(); });
$("#objectsNext").addEventListener("click", () => { objectsState.page += 1; refreshObjects(); });
$("#objectsPageInput").addEventListener("change", () => {
  const page = Number($("#objectsPageInput").value);
  if (Number.isInteger(page) && page >= 1) { objectsState.page = page - 1; refreshObjects(); }
});

async function createProject() {
  const button = $("#createProject");
  try {
    setBusy(button, true, "Criando…");
    const result = await api("/api/project/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientVersion: Number($("#clientVersion").value),
        signature: Number($("#signature").value),
      }),
    });
    stopWatching();
    folderState.project = null;
    rememberFolder();
    startProject(result.summary);
    updateCompileTarget();
    setMessage("Projeto vazio criado. Adicione registros e sprites antes de compilar.", "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function recordExists(category, id, counts) {
  const first = category === "items" ? 100 : 1;
  return id >= first && id < first + counts[category];
}

/**
 * Installs a freshly opened project. A new project starts from the first page with nothing selected; a reload of
 * the same folder (`preserve`) keeps the category, search, pages, selections, viewed sprite and open record,
 * dropping only what no longer exists. Sprite pixels may have changed, so cached thumbnails are discarded.
 */
function startProject(summary, { preserve = false } = {}) {
  const viewedSprite = Number($("#spriteId").value);
  thumbCache.clear();
  state.sprites.rendered = false;
  state.savedRevision = summary.revision;
  if (preserve) {
    for (const id of state.sprites.selected) if (id > summary.sprites.spriteCount) state.sprites.selected.delete(id);
    const sel = state.recordSel;
    if (sel.category) for (const id of sel.ids) if (!recordExists(sel.category, id, summary.counts)) sel.ids.delete(id);
    updateRecordSelectionCount();
    state.page = FS.clampPage(state.page, summary.counts[currentCategory()], state.pageSize);
    if (state.selected && !recordExists(state.selected.category, state.selected.id, summary.counts)) closeRecordModal();
  } else {
    state.page = 0;
    state.sprites.page = 0;
    state.sprites.selected.clear();
    clearRecordSelection();
    closeRecordModal();
  }
  const size = summary.sprites.spriteSize;
  const canvas = $("#spriteCanvas");
  if (canvas.width !== size || canvas.height !== size || !preserve) {
    canvas.width = size;
    canvas.height = size;
  }
  applySummary(summary);
  if (preserve && viewedSprite >= 1 && viewedSprite <= summary.sprites.spriteCount) {
    loadSprite(viewedSprite).catch(() => {});
  } else {
    renderSprite(new Uint8Array(size * size * 4));
  }
}

/** Reflects a summary returned by any project route. It never changes pages, selections or the viewed sprite. */
function applySummary(summary) {
  const previousCount = state.summary?.sprites.spriteCount;
  state.summary = summary;
  state.spriteInfo = summary.sprites;
  $("#workspace").classList.remove("hidden");
  $("#compilePanel").classList.remove("hidden");
  updateProjectStatus();
  refreshRecords();
  if (previousCount !== summary.sprites.spriteCount || !state.sprites.rendered) renderSpriteGrid();
}

function updateProjectStatus() {
  if (!state.summary) return;
  const unsaved = hasUnsavedChanges();
  const where = folderState.project ? "salvo na pasta" : "sem alterações";
  $("#projectStatus").textContent = `${state.summary.sprites.spriteCount} sprites · ${unsaved ? "alterações não gravadas" : where}`;
}

let refreshToken = 0;

async function refreshRecords() {
  if (!state.summary) return;
  const search = $("#searchId").value.trim();
  const query = new URLSearchParams({
    category: currentCategory(),
    offset: String(state.page * state.pageSize),
    limit: String(state.pageSize),
  });
  if (search) query.set("search", search);
  const token = ++refreshToken;
  try {
    const result = await api(`/api/project/records?${query}`);
    if (token !== refreshToken) return;
    state.records = result.records;
    renderRecordList(result);
    if (state.pendingOpenRecord) {
      const wanted = state.pendingOpenRecord;
      state.pendingOpenRecord = null;
      const record = state.records.find((item) => item.id === wanted.id && item.category === wanted.category);
      if (record) openRecord(record);
    }
    if (state.selected) {
      const selected = state.records.find((record) => record.id === state.selected.id && record.category === state.selected.category);
      if (selected) {
        state.selected = selected;
        if ($("#recordModal").open) renderRecord(selected);
      } else if ($("#recordModal").open) {
        closeRecordModal();
      }
    }
  } catch (error) {
    setMessage(error.message, "error");
  }
}

const thumbCache = new Map();
const THUMB_CACHE_LIMIT = 4000;
const SPRITE_FETCH_BACKOFF_MS = 5000;
let spriteFetchBackoffUntil = 0;
let spriteFetchLastNotice = 0;

function markSpriteFetchUnavailable(error) {
  const message = String(error?.message ?? error);
  const transient = error instanceof TypeError || /Failed to fetch|ERR_CONNECTION_REFUSED|ERR_NETWORK_CHANGED|NetworkError|No asset project is open/i.test(message);
  if (!transient) return error;
  const now = Date.now();
  spriteFetchBackoffUntil = Math.max(spriteFetchBackoffUntil, now + SPRITE_FETCH_BACKOFF_MS);
  if (now - spriteFetchLastNotice > SPRITE_FETCH_BACKOFF_MS) {
    spriteFetchLastNotice = now;
    setMessage(/No asset project is open/i.test(message) ? "O servidor foi reiniciado e perdeu o projeto. Recarregue a página e abra a pasta novamente." : "Servidor indisponível no momento. Tentando reconectar…", "error", { popup: false });
  }
  const unavailable = new Error("Servidor indisponível no momento. Tentando reconectar…");
  unavailable.name = "ServerUnavailableError";
  return unavailable;
}

async function fetchSpriteRgba(id) {
  if (thumbCache.has(id)) return thumbCache.get(id);
  if (Date.now() < spriteFetchBackoffUntil) {
    const unavailable = new Error("Servidor indisponível no momento. Tentando reconectar…");
    unavailable.name = "ServerUnavailableError";
    throw unavailable;
  }
  let response;
  try {
    response = await api(`/api/project/sprite?id=${id}`);
  } catch (error) {
    throw markSpriteFetchUnavailable(error);
  }
  const data = new Uint8ClampedArray(await response.arrayBuffer());
  if (thumbCache.size >= THUMB_CACHE_LIMIT) thumbCache.delete(thumbCache.keys().next().value);
  thumbCache.set(id, data);
  return data;
}

/* Frame composition for DAT records. Sprite order inside a group (as in the client and Object Builder):
   frame, pattern Z (mount), pattern Y (addon), pattern X (direction), layer, tile row, tile column; tile (0, 0)
   is the bottom-right 32×32 cell of the image. Outfit layers above 0 are color masks and are not drawn. */

const DIRECTION_NAMES = ["Norte", "Leste", "Sul", "Oeste"];

/** The group previews and thumbnails show first: an outfit's walking animation when it has one. */
function previewGroupIndex(record) {
  if (record.category === "outfits" && record.groups.length > 1) {
    const walking = record.groups.findIndex((group) => group.type === 1);
    if (walking >= 0) return walking;
  }
  return 0;
}

function frameGroupLabel(category, group, index, count) {
  const frames = `${group.frames} frame${group.frames === 1 ? "" : "s"}`;
  if (category === "outfits" && count > 1) {
    const name = group.type === 0 ? "Parado" : group.type === 1 ? "Andando" : `Grupo ${index + 1}`;
    return `${name} · ${frames}`;
  }
  return `Grupo ${index + 1} · ${frames}`;
}

/** Milliseconds to show `frame`: the file's min/max duration when it has one, a sensible default otherwise. */
function frameDuration(record, group, frame) {
  const phase = group.animation?.phases?.[frame];
  if (phase) return Math.max(40, (phase[0] + phase[1]) / 2);
  return record.category === "outfits" ? 200 : 500;
}

function legacyFrameCells(record, group, { frame = 0, x = 0, y = 0, z = 0 } = {}) {
  const width = Math.max(1, group.width);
  const height = Math.max(1, group.height);
  const layers = record.category === "outfits" ? 1 : group.layers;
  const cells = [];
  for (let layer = 0; layer < layers; layer += 1) {
    const base = (((((frame % group.frames) * group.patternZ + z) * group.patternY + y) * group.patternX + x) * group.layers + layer) * height * width;
    for (let h = 0; h < height; h += 1) {
      for (let w = 0; w < width; w += 1) cells.push({ w, h, id: group.spriteIds[base + h * width + w] });
    }
  }
  return { width, height, cells };
}

async function drawLegacyFrame(canvas, record, group, pattern) {
  const size = state.spriteInfo.spriteSize;
  const { width, height, cells } = legacyFrameCells(record, group, pattern);
  const buffer = document.createElement("canvas");
  buffer.width = size * width;
  buffer.height = size * height;
  const bufferContext = buffer.getContext("2d");
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const tileContext = tile.getContext("2d");
  for (const cell of cells) {
    if (!cell.id) continue;
    try {
      const rgba = await fetchSpriteRgba(cell.id);
      // drawImage (not putImageData) so stacked layers blend instead of replacing each other.
      tileContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
      bufferContext.drawImage(tile, (width - 1 - cell.w) * size, (height - 1 - cell.h) * size);
    } catch (error) {
      if (error?.name === "ServerUnavailableError") return false;
      // Missing sprites stay transparent.
    }
  }
  if (canvas.width !== buffer.width) canvas.width = buffer.width;
  if (canvas.height !== buffer.height) canvas.height = buffer.height;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(buffer, 0, 0);
  return true;
}

async function drawThumbnail(canvas, record, frame = 0) {
  const group = record.groups[previewGroupIndex(record)];
  if (!group) return;
  await drawLegacyFrame(canvas, record, group, { frame, x: defaultDirection(record, group) });
}

let thumbObserver;
const visibleTiles = new Map();

// One shared timer animates only the tiles currently scrolled into view.
setInterval(() => {
  for (const [tile, entry] of visibleTiles) {
    const frames = entry.record.groups[previewGroupIndex(entry.record)]?.frames ?? 1;
    if (frames <= 1 || entry.busy || !tile.isConnected) continue;
    entry.busy = true;
    entry.frame = (entry.frame + 1) % frames;
    drawThumbnail(tile.querySelector("canvas"), entry.record, entry.frame).finally(() => {
      entry.busy = false;
    });
  }
}, 250);

function closeRecordModal() {
  state.selected = null;
  if ($("#recordModal").open) $("#recordModal").close();
}

function openRecord(record) {
  state.selected = record;
  renderRecord(record);
  if (!$("#recordModal").open) $("#recordModal").showModal();
  document.querySelectorAll(".record-tile").forEach((tile) => {
    tile.classList.toggle("selected", Number(tile.dataset.id) === record.id && state.recordSel.ids.size === 0);
  });
}

function renderRecordList(result) {
  const list = $("#recordList");
  const pageKey = `${currentCategory()}:${state.page}:${$("#searchId").value.trim()}`;
  const scrollTop = list.dataset.pageKey === pageKey ? list.scrollTop : 0;
  list.dataset.pageKey = pageKey;
  list.replaceChildren();
  thumbObserver?.disconnect();
  visibleTiles.clear();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const tile = entry.target;
      if (!entry.isIntersecting) {
        visibleTiles.delete(tile);
        continue;
      }
      const record = state.records.find((item) => item.id === Number(tile.dataset.id));
      if (!record) continue;
      visibleTiles.set(tile, { record, frame: 0, busy: false });
      if (tile.dataset.drawn !== "1") {
        tile.dataset.drawn = "1";
        drawThumbnail(tile.querySelector("canvas"), record);
      }
    }
  }, { root: list });
  for (const record of result.records) {
    const button = document.createElement("button");
    button.className = `record-tile ${isRecordSelected(record) ? "selected" : ""}`;
    button.dataset.id = String(record.id);
    button.title = `${record.category} ${record.id} · ${record.flags.length} flags`;
    const canvas = document.createElement("canvas");
    canvas.width = state.spriteInfo.spriteSize;
    canvas.height = state.spriteInfo.spriteSize;
    const id = document.createElement("span");
    id.className = "record-id";
    id.textContent = String(record.id);
    button.append(canvas, id);
    button.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || state.recordSel.ids.size > 0) {
        selectRecord(record, event);
      } else {
        openRecord(record);
      }
    });
    list.append(button);
    thumbObserver.observe(button);
  }
  list.scrollTop = scrollTop;
  const totalPages = Math.max(1, Math.ceil(result.total / state.pageSize));
  $("#pageLabel").textContent = result.total ? `/ ${totalPages}` : "vazio";
  const pageInput = $("#pageInput");
  pageInput.disabled = !result.total;
  pageInput.max = String(totalPages);
  pageInput.value = result.total ? String(state.page + 1) : "";
  state.totalPages = totalPages;
  $("#previousPage").disabled = state.page === 0;
  $("#nextPage").disabled = (state.page + 1) * state.pageSize >= result.total;
}


/* Record multi-selection */

function isRecordSelected(record) {
  return state.recordSel.category === record.category && state.recordSel.ids.has(record.id);
}

function clearRecordSelection() {
  state.recordSel = { category: null, ids: new Set(), anchor: null };
  document.querySelectorAll(".record-tile.selected").forEach((tile) => tile.classList.remove("selected"));
  updateRecordSelectionCount();
}

function updateRecordSelectionCount() {
  const chip = $("#recordSelectionCount");
  const count = state.recordSel.ids.size;
  chip.textContent = `${count} registro(s) selecionado(s) — Esc limpa`;
  chip.classList.toggle("hidden", count === 0);
}

function selectRecord(record, event) {
  const sel = state.recordSel;
  if (sel.category !== record.category) {
    sel.category = record.category;
    sel.ids = new Set();
    sel.anchor = null;
  }
  if (event.shiftKey && sel.anchor !== null) {
    const [from, to] = [sel.anchor, record.id].sort((a, b) => a - b);
    if (!event.ctrlKey && !event.metaKey) sel.ids.clear();
    for (const item of state.records) if (item.id >= from && item.id <= to) sel.ids.add(item.id);
  } else {
    if (!sel.ids.delete(record.id)) sel.ids.add(record.id);
    sel.anchor = record.id;
  }
  document.querySelectorAll(".record-tile").forEach((tile) => {
    tile.classList.toggle("selected", sel.ids.has(Number(tile.dataset.id)));
  });
  updateRecordSelectionCount();
}

function selectAllRecords() {
  state.recordSel = { category: currentCategory(), ids: new Set(state.records.map((record) => record.id)), anchor: null };
  document.querySelectorAll(".record-tile").forEach((tile) => tile.classList.add("selected"));
  updateRecordSelectionCount();
}

document.addEventListener("keydown", (event) => {
  if (event.target instanceof Element && event.target.closest("input, textarea, select, dialog, .swal2-container")) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && state.summary && $("#recordList")?.matches(":hover, :focus-within")) {
    event.preventDefault();
    selectAllRecords();
  } else if (event.key === "Escape" && state.recordSel.ids.size > 0) {
    clearRecordSelection();
  }
});

function renderRecord(record) {
  $("#recordTitle").textContent = `${record.category} · ID ${record.id}`;
    const meta = $("#recordMeta");
  meta.replaceChildren();
  [
    `flags ${record.flags.join(", ") || "—"}`,
    `${record.groups.length} grupo(s)`,
    `${record.groups.reduce((sum, group) => sum + group.spriteIds.length, 0)} referências SPR`,
  ].forEach((value) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = value;
    meta.append(chip);
  });
  renderProperties(record);
  renderSpriteReferences(record);
  drawThumbnail($("#modalThumb"), record);
  setupRecordPreview(record);
}

/* Animated preview of a DAT record: every frame group, direction, addon and mount, with the file's durations.
   Re-rendering the same record (after an edit) keeps the chosen group, pattern and frame. */

const recordPreview = { key: null, record: null, group: 0, x: 0, y: 0, z: 0, frame: 0, playing: true, timer: null, token: 0 };

function fillPatternSelect(select, count, name, value) {
  select.replaceChildren(...Array.from({ length: count }, (_, index) => new Option(name(index), String(index))));
  select.value = String(value);
  select.disabled = count <= 1;
}

function setupRecordPreview(record) {
  const preview = recordPreview;
  const key = `${record.category}:${record.id}`;
  const same = preview.key === key;
  preview.key = key;
  preview.record = record;
  if (!same) {
    preview.group = previewGroupIndex(record);
    preview.frame = 0;
    preview.playing = true;
  }
  preview.group = Math.min(preview.group, Math.max(0, record.groups.length - 1));
  $("#previewGroup").replaceChildren(...record.groups.map((group, index) =>
    new Option(frameGroupLabel(record.category, group, index, record.groups.length), String(index))));
  $("#previewGroup").value = String(preview.group);
  $("#previewGroup").disabled = record.groups.length <= 1;
  configurePreviewPatterns(same);
  restartRecordPreview();
}

function configurePreviewPatterns(keep) {
  const preview = recordPreview;
  const { record } = preview;
  const group = record.groups[preview.group];
  if (!group) return;
  const outfit = record.category === "outfits";
  preview.x = keep && preview.x < group.patternX ? preview.x : defaultDirection(record, group);
  preview.y = keep && preview.y < group.patternY ? preview.y : 0;
  preview.z = keep && preview.z < group.patternZ ? preview.z : 0;
  preview.frame %= group.frames;
  fillPatternSelect($("#previewDirection"), group.patternX,
    (x) => (outfit && group.patternX === 4 ? DIRECTION_NAMES[x] : `Padrão X ${x}`), preview.x);
  fillPatternSelect($("#previewAddon"), group.patternY, (y) => (outfit ? (y === 0 ? "Sem addon" : `Addon ${y}`) : `Padrão Y ${y}`), preview.y);
  fillPatternSelect($("#previewMount"), group.patternZ, (z) => (outfit ? (z === 0 ? "Sem montaria" : `Montado${group.patternZ > 2 ? ` ${z}` : ""}`) : `Padrão Z ${z}`), preview.z);
  $("#previewAddonLabel").classList.toggle("hidden", group.patternY <= 1);
  $("#previewMountLabel").classList.toggle("hidden", group.patternZ <= 1);
}

function stopRecordPreview() {
  clearTimeout(recordPreview.timer);
  recordPreview.timer = null;
  recordPreview.token += 1;
}

function restartRecordPreview() {
  stopRecordPreview();
  const token = recordPreview.token;
  const step = async () => {
    const preview = recordPreview;
    const { record } = preview;
    const group = record?.groups[preview.group];
    if (!group || token !== preview.token) return;
    const pattern = { frame: preview.frame, x: preview.x, y: preview.y, z: preview.z };
    await drawLegacyFrame($("#recordPreview"), record, group, pattern);
    if (token !== preview.token) return;
    const durations = group.animation ? "durações do arquivo" : "durações padrão";
    $("#previewInfo").textContent = `Frame ${preview.frame + 1}/${group.frames} · ${group.width}×${group.height} tile(s) · ${group.layers} camada(s) · padrão ${group.patternX}×${group.patternY}×${group.patternZ} · ${group.spriteIds.length} sprites no grupo${group.frames > 1 ? ` · ${durations}` : ""}`;
    $("#previewPlay").textContent = preview.playing ? "⏸" : "▶";
    $("#previewPlay").setAttribute("aria-label", preview.playing ? "Pausar" : "Reproduzir");
    $("#previewPlay").disabled = group.frames <= 1;
    $("#previewPrev").disabled = group.frames <= 1;
    $("#previewNext").disabled = group.frames <= 1;
    if (!preview.playing || group.frames <= 1) return;
    preview.timer = setTimeout(() => {
      preview.frame = (preview.frame + 1) % group.frames;
      step();
    }, frameDuration(record, group, preview.frame));
  };
  step();
}

$("#previewGroup").addEventListener("change", () => {
  recordPreview.group = Number($("#previewGroup").value);
  recordPreview.frame = 0;
  configurePreviewPatterns(true);
  restartRecordPreview();
});
for (const [selector, key] of [["#previewDirection", "x"], ["#previewAddon", "y"], ["#previewMount", "z"]]) {
  $(selector).addEventListener("change", () => {
    recordPreview[key] = Number($(selector).value);
    restartRecordPreview();
  });
}
$("#previewPlay").addEventListener("click", () => {
  recordPreview.playing = !recordPreview.playing;
  restartRecordPreview();
});
for (const [selector, delta] of [["#previewPrev", -1], ["#previewNext", 1]]) {
  $(selector).addEventListener("click", () => {
    const group = recordPreview.record?.groups[recordPreview.group];
    if (!group) return;
    recordPreview.playing = false;
    recordPreview.frame = (recordPreview.frame + delta + group.frames) % group.frames;
    restartRecordPreview();
  });
}

function renderProperties(record) {
  const container = $("#properties");
  container.replaceChildren();
  for (const [name, label] of booleanFields) {
    const row = document.createElement("label");
    row.className = "property-row boolean";
    const title = document.createElement("span");
    title.className = "property-name";
    title.textContent = label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = record.properties[name] === true;
    input.addEventListener("change", () => saveProperty(record, name, input.checked));
    row.append(title, input);
    container.append(row);
  }

  for (const [name, label] of [...numberFields, ...extraNumberFields]) {
    const row = document.createElement("div");
    row.className = "property-row";
    const title = document.createElement("span");
    title.className = "property-name";
    title.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(record.properties[name] ?? 0);
    input.setAttribute("aria-label", label);
    const save = document.createElement("button");
    save.textContent = "Salvar";
    save.addEventListener("click", () => saveProperty(record, name, Number(input.value)));
    const control = document.createElement("div");
    control.className = "save-field";
    control.append(input, save);
    row.append(title, control);
    container.append(row);
  }

  const textRow = document.createElement("div");
  textRow.className = "property-row";
  const marketLabel = document.createElement("span");
  marketLabel.className = "property-name";
  marketLabel.textContent = "Market name";
  const marketInput = document.createElement("input");
  marketInput.value = String(record.properties.marketName ?? "");
  marketInput.maxLength = 65535;
  const marketSave = document.createElement("button");
  marketSave.textContent = "Salvar";
  marketSave.addEventListener("click", () => saveProperty(record, "marketName", marketInput.value));
  const marketControl = document.createElement("div");
  marketControl.className = "save-field";
  marketControl.append(marketInput, marketSave);
  textRow.append(marketLabel, marketControl);
  container.append(textRow);
}

async function saveProperty(record, name, value) {
  try {
    const result = await api("/api/project/property", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: record.category, id: record.id, name, value }),
    });
    applySummary(result.summary);
    setMessage(`${name} atualizado no modelo.`, "success");
  } catch (error) {
    setMessage(error.message, "error");
    refreshRecords();
  }
}

function renderSpriteReferences(record) {
  const container = $("#spriteReferences");
  container.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "Referências a sprites por grupo";
  container.append(heading);
  const groupSelector = document.createElement("select");
  record.groups.forEach((group, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `Grupo ${index + 1} · ${group.width}×${group.height} · ${group.frames} frame(s)`;
    groupSelector.append(option);
  });
  container.append(groupSelector);
  const grid = document.createElement("div");
  grid.className = "reference-grid";
  container.append(grid);
  const draw = () => {
    grid.replaceChildren();
    const groupIndex = Number(groupSelector.value);
    const group = record.groups[groupIndex];
    if (!group) return;
    if (group.spriteIds.length > 256) {
      const warning = document.createElement("p");
      warning.className = "hint";
      warning.textContent = `${group.spriteIds.length} slots: exibindo os primeiros 256.`;
      grid.append(warning);
    }
    group.spriteIds.slice(0, 256).forEach((spriteId, slot) => {
      const label = document.createElement("label");
      label.className = "reference";
      label.textContent = `Slot ${slot}`;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.value = String(spriteId);
      input.addEventListener("change", async () => {
        try {
          const result = await api("/api/project/sprite-reference", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              category: record.category,
              id: record.id,
              group: groupIndex,
              slot,
              spriteId: Number(input.value),
            }),
          });
          applySummary(result.summary);
          setMessage(`Referência do slot ${slot} alterada.`, "success");
          await loadSprite(Number(input.value));
        } catch (error) {
          setMessage(error.message, "error");
          input.value = String(spriteId);
        }
      });
      label.append(input);
      grid.append(label);
    });
  };
  groupSelector.addEventListener("change", draw);
  draw();
}

async function addRecord() {
  try {
    const result = await api("/api/project/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: currentCategory() }),
    });
    state.page = Math.max(0, Math.floor((result.id - (currentCategory() === "items" ? 100 : 1)) / state.pageSize));
    state.selected = null;
    applySummary(result.summary);
    setMessage(`Registro ${result.id} criado.`, "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
}

const CATEGORY_LABELS = { items: "itens", outfits: "outfits", effects: "efeitos", missiles: "projéteis" };

/**
 * Deletes records after an explicit SweetAlert2 confirmation. One ID uses the single-record route (as the
 * record dialog always did); several use the batch route, which removes them from the highest ID down so the
 * positional IDs of the remaining selected records never shift onto unselected ones mid-operation.
 */
async function deleteRecords(category, ids) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (!sorted.length) return;
  const many = sorted.length > 1;
  const confirmed = await Dialogs.confirm({
    title: many ? `Excluir ${sorted.length} registros?` : `Excluir o registro ${sorted[0]}?`,
    html: `<p>${many
      ? `Serão excluídos <strong>${sorted.length}</strong> registros de ${CATEGORY_LABELS[category]}:`
      : `Será excluído o registro de ${CATEGORY_LABELS[category]}:`}</p>${Dialogs.list(sorted.map((id) => `${category} ${id}`))}`
      + "<p>Os registros seguintes passam a ter IDs menores. A exclusão vale para o modelo em memória e só chega aos arquivos quando você compilar.</p>",
    confirmText: many ? `Excluir ${sorted.length} registros` : "Excluir registro",
    danger: true,
  });
  if (!confirmed) {
    setMessage("Exclusão cancelada; nenhum registro foi removido.");
    return;
  }
  let result;
  try {
    if (many) {
      result = await api("/api/project/records/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category, ids: sorted }),
      });
    } else {
      const query = new URLSearchParams({ category, id: String(sorted[0]) });
      result = { removed: sorted, failed: [], ...(await api(`/api/project/record?${query}`, { method: "DELETE" })) };
    }
  } catch (error) {
    await Dialogs.error("Não foi possível excluir", { text: `${error.message}. Nenhum registro foi removido.` });
    refreshRecords();
    return;
  }
  const lowestRemoved = result.removed[0];
  if (state.selected?.category === category && lowestRemoved !== undefined && state.selected.id >= lowestRemoved) {
    // The open record was deleted or now has a different ID.
    closeRecordModal();
  }
  if (state.recordSel.category === category) clearRecordSelection();
  if (category === currentCategory()) state.page = FS.clampPage(state.page, result.summary.counts[category], state.pageSize);
  applySummary(result.summary);
  if (result.failed.length) {
    setMessage(`${result.removed.length} de ${sorted.length} registro(s) excluído(s); ${result.failed.length} falharam.`, "", { popup: false });
    await Dialogs.warning("Exclusão incompleta", {
      html: `<p>${result.removed.length} de ${sorted.length} registro(s) foram excluídos. Não foi possível excluir:</p>`
        + Dialogs.list(result.failed.map((failure) => `${category} ${failure.id}: ${failure.error}`)),
    });
  } else {
    setMessage(many ? `${result.removed.length} registros excluídos do modelo.` : `Registro ${sorted[0]} excluído do modelo.`, "success");
  }
}

function removeRecord() {
  if (!state.selected) return;
  return deleteRecords(state.selected.category, [state.selected.id]);
}

function renderSprite(rgba) {
  const canvas = $("#spriteCanvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height), 0, 0);
}

async function loadSprite(id) {
  const result = await api(`/api/project/sprite?id=${encodeURIComponent(id)}`);
  renderSprite(await result.arrayBuffer());
  $("#spriteId").value = String(id);
}

async function readSelectedImage() {
  const file = $("#spriteImage").files[0];
  if (!file) throw new Error("Selecione uma imagem.");
  const image = await createImageBitmap(file);
  const expected = state.spriteInfo.spriteSize;
  if (image.width !== expected || image.height !== expected) {
    image.close();
    throw new Error(`A imagem deve ter exatamente ${expected} × ${expected} pixels.`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = expected;
  canvas.height = expected;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  image.close();
  return new Uint8Array(context.getImageData(0, 0, expected, expected).data);
}

async function replaceSprite(add = false) {
  try {
    const rgba = await readSelectedImage();
    if (add) {
      const result = await api("/api/project/sprite/add", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: rgba,
      });
      applySummary(result.summary);
      await loadSprite(result.spriteId);
      setMessage(`Sprite ${result.spriteId} adicionado.`, "success");
    } else {
      const spriteId = Number($("#spriteId").value);
      const result = await api(`/api/project/sprite?id=${encodeURIComponent(spriteId)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: rgba,
      });
      thumbCache.delete(spriteId);
      applySummary(result.summary);
      renderSpriteGrid();
      await loadSprite(spriteId);
      setMessage(`Sprite ${spriteId} substituído.`, "success");
    }
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function renderDownloads(result) {
  const downloads = $("#downloads");
  downloads.replaceChildren();
  for (const file of result.files) {
    const button = document.createElement("button");
    button.textContent = `Baixar ${file.name} (${formatBytes(file.size)})`;
    button.addEventListener("click", () => downloadFile(file.format, file.name, result.revision));
    downloads.append(button);
  }
}

async function ensureWritePermission(target) {
  const options = { mode: "readwrite" };
  const dirs = new Set([target.dat.dir, target.spr.dir, target.otfi?.dir].filter(Boolean));
  for (const dir of dirs) {
    if ((await dir.queryPermission(options)) !== "granted" && (await dir.requestPermission(options)) !== "granted") return false;
  }
  return true;
}

/**
 * Streams one compiled file from the server into `writable`, checking the byte count. The writable belongs to
 * FolderSync.commitAtomically, which commits or aborts it, so the pipe must neither close nor abort it.
 */
async function streamCompiledFile(format, revision, expectedSize, writable) {
  const response = await api(`/api/project/download?format=${format}&revision=${revision}`);
  let written = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      written += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  await response.body.pipeThrough(counter).pipeTo(writable, { preventClose: true, preventAbort: true });
  if (written !== expectedSize) throw new Error(`recebidos ${written} de ${expectedSize} bytes`);
}

/**
 * Validate and compile, then replace the opened DAT/SPR/OTFI in the selected folder:
 * 1. the server serializes, re-parses and validates the set (nothing on disk is touched if this fails);
 * 2. the user confirms the replacement;
 * 3. every file is streamed into a swap file and only when all three are complete are they committed,
 *    so a failure leaves the folder as it was. Other files in the folder are never written.
 * The folder watcher is paused during the write and then told about the new files, so the editor's own save
 * is not mistaken for an external change.
 */
async function compileProject() {
  const button = $("#compileProject");
  const target = folderState.project;
  // Ask for write access first, while the click still counts as a user gesture.
  const permission = target ? ensureWritePermission(target).catch(() => false) : null;
  if (!target) {
    const proceed = await Dialogs.confirm({
      icon: "info",
      title: "Nenhuma pasta de destino",
      text: supportsFolderAccess
        ? "Este projeto não foi aberto com “Escolher pasta…”, então não há onde gravar. Deseja validar, compilar e apenas baixar os arquivos?"
        : "Este navegador não permite gravar em pastas locais. Deseja validar, compilar e baixar os arquivos?",
      confirmText: "Compilar e baixar",
    });
    if (!proceed) return;
  }
  try {
    await withProjectLock("compilação", async () => {
      setBusy(button, true, "Validando DAT/SPR/OTFI…");
      if (target && !(await permission)) {
        throw new Error("O navegador não concedeu permissão de escrita na pasta. Nenhum arquivo foi alterado.");
      }
      let result;
      try {
        result = await api("/api/project/compile", { method: "POST" });
      } catch (error) {
        $("#downloads").replaceChildren();
        await Dialogs.error("Falha na validação", {
          text: `${error.message}. A compilação foi interrompida e nenhum arquivo da pasta foi alterado.`,
        });
        setMessage(`Falha na validação: ${error.message}`, "error", { popup: false });
        return;
      }
      renderDownloads(result);
      if (!target) {
        setMessage("Compilação validada. Baixe cada arquivo para criar o conjunto de saída.", "success");
        return;
      }
      const byFormat = new Map(result.files.map((file) => [file.format, file]));
      const plan = [["dat", target.dat], ["spr", target.spr], ["otfi", target.otfi]]
        .filter(([, entry]) => entry)
        .map(([format, entry]) => ({ format, entry, size: byFormat.get(format).size }));
      setBusy(button, true, "Aguardando confirmação…");
      const confirmed = await Dialogs.confirm({
        title: "Substituir arquivos na pasta?",
        html: "<p>A validação e a compilação foram concluídas. Os arquivos abaixo serão substituídos:</p>"
          + Dialogs.list(plan.map(({ entry, size }) => `${entry.path} (${formatBytes(size)})`))
          + `<p>Os demais arquivos da pasta não são alterados.${target.otfi ? "" : " A pasta não tem OTFI, então nenhum OTFI será criado."}</p>`,
        confirmText: "Substituir arquivos",
        danger: true,
      });
      if (!confirmed) {
        setMessage("Compilação validada; nenhum arquivo da pasta foi substituído. Os arquivos continuam disponíveis para download.");
        return;
      }
      setBusy(button, true, "Gravando na pasta…");
      const watcher = folderState.watcher;
      const write = async () => {
        try {
          return await FS.commitAtomically(plan.map(({ format, entry, size }) => ({
            name: entry.path,
            open: () => entry.handle.createWritable({ keepExistingData: false }),
            fill: (writable) => streamCompiledFile(format, result.revision, size, writable),
          })));
        } finally {
          // Whatever reached the disk was written by the editor itself: never reload it as an external change.
          if (watcher) watcher.acknowledge(await readFolderSnapshot().catch(() => watcher.baseline));
        }
      };
      try {
        const committed = watcher ? await watcher.pausedWhile(write) : await write();
        state.savedRevision = result.revision;
        updateProjectStatus();
        setMessage(`Compilação validada e gravada: ${committed.join(", ")}.`, "", { popup: false });
        await Dialogs.success("Compilação concluída", {
          html: `<p>Validação e compilação concluídas. Arquivos substituídos na pasta:</p>${Dialogs.list(committed)}`,
        });
      } catch (error) {
        setMessage(error.message, "error", { popup: false });
        await Dialogs.error("Falha ao gravar na pasta", { text: error.message });
      }
    });
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function downloadFile(format, name, revision) {
  try {
    const response = await api(`/api/project/download?format=${format}&revision=${revision}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name.split(/[\\/]/).at(-1);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

$("#openProject").addEventListener("click", openProject);
$("#createProject").addEventListener("click", createProject);
$("#category").addEventListener("change", () => {
  clearRecordSelection();
  state.page = 0;
  state.selected = null;
  refreshRecords();
});
$("#searchId").addEventListener("input", () => {
  state.page = 0;
  refreshRecords();
});
$("#previousPage").addEventListener("click", () => {
  state.page = Math.max(0, state.page - 1);
  refreshRecords();
});
$("#nextPage").addEventListener("click", () => {
  state.page += 1;
  refreshRecords();
});
function parsePageNumber(input, totalPages) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, totalPages) - 1;
}

$("#pageInput").addEventListener("change", (event) => {
  const page = parsePageNumber(event.target, state.totalPages ?? 1);
  if (page === null) {
    event.target.value = String(state.page + 1);
    return;
  }
  state.page = page;
  refreshRecords();
});

$("#closeModal").addEventListener("click", () => $("#recordModal").close());
$("#recordModal").addEventListener("close", () => {
  stopRecordPreview();
  recordPreview.key = null;
});
$("#addRecord").addEventListener("click", addRecord);
$("#removeRecord").addEventListener("click", removeRecord);
$("#loadSprite").addEventListener("click", () => loadSprite(Number($("#spriteId").value)).catch((error) => setMessage(error.message, "error")));
$("#replaceSprite").addEventListener("click", () => replaceSprite(false));
$("#addSprite").addEventListener("click", () => replaceSprite(true));
$("#compileProject").addEventListener("click", compileProject);


/* ---------- Sprite browser, context menu, import/export ---------- */

const IO = globalThis.SpriteIO;
const LIMITS = { maxFiles: 50, maxFileBytes: 32 * 1024 * 1024, maxPixels: 8192 * 8192 };
const importState = { running: false, abort: null, seen: new Set() };

function spriteSize() {
  return state.summary.sprites.spriteSize;
}

async function fetchSprites(ids, signal) {
  if (Date.now() < spriteFetchBackoffUntil) {
    const unavailable = new Error("Servidor indisponível no momento. Tentando reconectar…");
    unavailable.name = "ServerUnavailableError";
    throw unavailable;
  }
  const bytes = spriteSize() * spriteSize() * 4;
  const frames = [];
  for (let start = 0; start < ids.length; start += 512) {
    signal?.throwIfAborted();
    const chunk = ids.slice(start, start + 512);
    let response;
    try {
      response = await api(`/api/project/sprites?ids=${chunk.join(",")}`, { signal });
    } catch (error) {
      throw markSpriteFetchUnavailable(error);
    }
    const data = new Uint8ClampedArray(await response.arrayBuffer());
    if (data.length !== chunk.length * bytes) throw new Error("O servidor devolveu sprites incompletos.");
    chunk.forEach((_, index) => frames.push(data.subarray(index * bytes, (index + 1) * bytes)));
  }
  return frames;
}

function rgbaToPngBytes(rgba, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      canvas.width = 0;
      if (!blob) return reject(new Error("O navegador não conseguiu codificar o PNG."));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

function downloadBytes(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateSelectionCount() {
  const chip = $("#selectionCount");
  const count = state.sprites.selected.size;
  chip.textContent = `${count} selecionada(s)`;
  chip.classList.toggle("hidden", count === 0);
}

function renderSpriteGrid() {
  if (!state.summary) return;
  const { page, pageSize } = state.sprites;
  const total = state.summary.sprites.spriteCount;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page >= pages) state.sprites.page = pages - 1;
  const first = state.sprites.page * pageSize + 1;
  const last = Math.min(total, first + pageSize - 1);
  const grid = $("#spriteGrid");
  const scrollTop = Number(grid.dataset.page) === state.sprites.page ? grid.scrollTop : 0;
  grid.dataset.page = String(state.sprites.page);
  grid.replaceChildren();
  state.sprites.rendered = true;
  $("#spritePageLabel").textContent = total ? `/ ${pages} · ${first}–${last} de ${total}` : "sem sprites";
  const spriteInput = $("#spritePageInput");
  spriteInput.disabled = !total;
  spriteInput.max = String(pages);
  spriteInput.value = total ? String(state.sprites.page + 1) : "";
  $("#spritePrev").disabled = state.sprites.page === 0;
  $("#spriteNext").disabled = last >= total;
  updateSelectionCount();
  if (!total) return;
  const ids = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const size = spriteSize();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const canvas = entry.target.querySelector("canvas");
      fetchSpriteRgba(Number(entry.target.dataset.id)).then((rgba) => {
        canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
      }).catch(() => {});
    }
  }, { root: grid });
  for (const id of ids) {
    const tile = document.createElement("button");
    tile.className = `sprite-tile ${state.sprites.selected.has(id) ? "selected" : ""}`;
    tile.dataset.id = String(id);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const label = document.createElement("span");
    label.textContent = String(id);
    tile.append(canvas, label);
    grid.append(tile);
    observer.observe(tile);
  }
  grid.scrollTop = scrollTop;
}

function selectSprite(id, event) {
  const selected = state.sprites.selected;
  if (event.shiftKey && state.sprites.anchor !== null) {
    const [from, to] = [state.sprites.anchor, id].sort((a, b) => a - b);
    if (!event.ctrlKey && !event.metaKey) selected.clear();
    for (let value = from; value <= to; value += 1) selected.add(value);
  } else if (event.ctrlKey || event.metaKey) {
    if (!selected.delete(id)) selected.add(id);
    state.sprites.anchor = id;
  } else {
    selected.clear();
    selected.add(id);
    state.sprites.anchor = id;
  }
  document.querySelectorAll("#spriteGrid .sprite-tile").forEach((tile) => {
    tile.classList.toggle("selected", selected.has(Number(tile.dataset.id)));
  });
  updateSelectionCount();
}

$("#spriteGrid").addEventListener("click", (event) => {
  const tile = event.target.closest(".sprite-tile");
  if (!tile) return;
  const id = Number(tile.dataset.id);
  selectSprite(id, event);
  loadSprite(id).catch((error) => setMessage(error.message, "error"));
});
$("#spriteGrid").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    document.querySelectorAll("#spriteGrid .sprite-tile").forEach((tile) => state.sprites.selected.add(Number(tile.dataset.id)));
    document.querySelectorAll("#spriteGrid .sprite-tile").forEach((tile) => tile.classList.add("selected"));
    updateSelectionCount();
  }
});
$("#spritePageInput").addEventListener("change", (event) => {
  const total = state.summary?.sprites.spriteCount ?? 0;
  const pages = Math.max(1, Math.ceil(total / state.sprites.pageSize));
  const page = parsePageNumber(event.target, pages);
  if (page === null) {
    event.target.value = String(state.sprites.page + 1);
    return;
  }
  state.sprites.page = page;
  renderSpriteGrid();
});
$("#spritePrev").addEventListener("click", () => { state.sprites.page = Math.max(0, state.sprites.page - 1); renderSpriteGrid(); });
$("#spriteNext").addEventListener("click", () => { state.sprites.page += 1; renderSpriteGrid(); });

/* Context menu */

const menu = $("#spriteMenu");

function closeMenu() {
  menu.classList.add("hidden");
  menu.replaceChildren();
}

function menuItem(label, handler, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", () => {
    closeMenu();
    Promise.resolve(handler()).catch((error) => setMessage(error.message, "error"));
  });
  return button;
}

function dangerItem(button) {
  button.classList.add("danger-item");
  return button;
}

function spriteIdForTarget(target) {
  const tile = target.closest("#spriteGrid .sprite-tile");
  if (tile) return { id: Number(tile.dataset.id), fromGrid: true };
  if (target.closest("#spriteCanvas")) return { id: Number($("#spriteId").value), fromGrid: false };
  const record = target.closest(".record-tile");
  if (record) {
    const found = state.records.find((item) => item.id === Number(record.dataset.id));
    const spriteId = found?.groups[0]?.spriteIds.find((value) => value > 0);
    return spriteId ? { id: spriteId, fromGrid: false } : null;
  }
  const slot = target.closest(".reference");
  if (slot) return { id: Number(slot.querySelector("input").value), fromGrid: false };
  return null;
}

function placeMenu(event) {
  (event.target.closest("dialog") ?? document.body).append(menu);
  menu.classList.remove("hidden");
  const margin = 8;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - height - margin))}px`;
  menu.querySelector("button:not(:disabled)")?.focus();
}

function showRecordMenu(event, tile) {
  const category = currentCategory();
  const id = Number(tile.dataset.id);
  const sel = state.recordSel;
  if (sel.category !== category || !sel.ids.has(id)) {
    const record = state.records.find((item) => item.id === id);
    if (record) {
      sel.category = category;
      sel.ids = new Set([id]);
      sel.anchor = id;
      document.querySelectorAll(".record-tile").forEach((node) => node.classList.toggle("selected", Number(node.dataset.id) === id));
      updateRecordSelectionCount();
    }
  }
  const ids = [...state.recordSel.ids].sort((a, b) => a - b);
  menu.replaceChildren();
  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = ids.length > 1 ? `${ids.length} registros selecionados` : `${category} ${ids[0]}`;
  menu.append(
    title,
    menuItem(ids.length > 1 ? `Exportar ${ids.length} objetos (.obd em ZIP)` : "Exportar .obd", () => exportObd(category, ids)),
    menuItem("Limpar seleção", clearRecordSelection),
    document.createElement("hr"),
    dangerItem(ids.length > 1
      ? menuItem(`Excluir selecionados (${ids.length})`, () => deleteRecords(category, ids))
      : menuItem("Excluir registro", () => deleteRecords(category, ids))),
  );
  placeMenu(event);
}

document.addEventListener("contextmenu", (event) => {
  if (!state.summary) return;
  const recordTile = event.target instanceof Element ? event.target.closest(".record-tile") : null;
  if (recordTile) {
    event.preventDefault();
    showRecordMenu(event, recordTile);
    return;
  }
  const hit = event.target instanceof Element ? spriteIdForTarget(event.target) : null;
  if (!hit) return;
  event.preventDefault();
  const total = state.summary.sprites.spriteCount;
  if (!Number.isInteger(hit.id) || hit.id < 1 || hit.id > total) {
    closeMenu();
    setMessage("Esta referência não aponta para uma sprite existente.", "error");
    return;
  }
  if (hit.fromGrid && !state.sprites.selected.has(hit.id)) {
    selectSprite(hit.id, {});
  }
  const ids = hit.fromGrid && state.sprites.selected.size > 0 ? [...state.sprites.selected].sort((a, b) => a - b) : [hit.id];
  state.contextIds = ids;
  const many = ids.length > 1;
  menu.replaceChildren();
  const title = document.createElement("div");
  title.className = "menu-title";
  title.textContent = many ? `${ids.length} sprites selecionadas` : `Sprite ${ids[0]}`;
  menu.append(
    title,
    menuItem(many ? "Exportar sprites (PNG em ZIP)" : "Exportar sprite (PNG)", () => exportSprites(ids)),
    document.createElement("hr"),
    menuItem("Importar sprite…", () => $("#importSingleInput").click()),
    menuItem("Importar spritesheets…", () => $("#importSheetsInput").click()),
    document.createElement("hr"),
    menuItem("Copiar sprite", () => copySprite(ids[0])),
    menuItem("Colar como nova sprite", pasteSprite, state.clipboard === null),
    menuItem("Propriedades", () => showSpriteProperties(ids[0])),
  );
  // Only sprites picked in the SPR grid can be deleted: a right-click on a record or a slot names a reference.
  if (hit.fromGrid) {
    menu.append(
      document.createElement("hr"),
      dangerItem(menuItem(many ? `Excluir selecionadas (${ids.length})` : "Excluir sprite", () => deleteSprites(ids))),
    );
  }
  (event.target.closest("dialog") ?? document.body).append(menu);
  menu.classList.remove("hidden");
  const margin = 8;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - height - margin))}px`;
  menu.querySelector("button:not(:disabled)")?.focus();
});

document.addEventListener("pointerdown", (event) => {
  if (!menu.classList.contains("hidden") && !menu.contains(event.target)) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !menu.classList.contains("hidden")) {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    return;
  }
  if (!menu.classList.contains("hidden") && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    const items = [...menu.querySelectorAll("button:not(:disabled)")];
    const index = items.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  }
}, true);
window.addEventListener("resize", closeMenu);
window.addEventListener("blur", closeMenu);
document.addEventListener("scroll", closeMenu, true);

/* Export */

async function exportSprites(ids) {
  const size = spriteSize();
  const frames = await fetchSprites(ids);
  if (ids.length === 1) {
    downloadBytes(await rgbaToPngBytes(frames[0], size, size), `sprite_${ids[0]}.png`, "image/png");
    setMessage(`Sprite ${ids[0]} exportada (${size}×${size} PNG com alfa).`, "success");
    return;
  }
  const entries = [];
  for (let index = 0; index < ids.length; index += 1) {
    entries.push({ name: `sprite_${ids[index]}.png`, data: await rgbaToPngBytes(frames[index], size, size) });
  }
  downloadBytes(IO.buildZip(entries), `sprites_${ids[0]}-${ids.at(-1)}.zip`, "application/zip");
  setMessage(`${ids.length} sprites exportadas em ZIP.`, "success");
}

async function fetchObd(category, id, signal) {
  const query = new URLSearchParams({ category, id: String(id) });
  const response = await api(`/api/project/obd?${query}`, { signal });
  const warnings = JSON.parse(decodeURIComponent(response.headers.get("x-obd-warnings") || "%5B%5D"));
  return { data: new Uint8Array(await response.arrayBuffer()), warnings };
}

const OBD_EXPORT_CONCURRENCY = 4;

async function exportObd(category, ids) {
  if (importState.running) {
    setMessage("Já existe uma importação ou exportação em andamento.", "error");
    return;
  }
  importState.running = true;
  importState.abort = new AbortController();
  const { signal } = importState.abort;
  const started = performance.now();
  const results = new Array(ids.length);
  const failures = [];
  const warnings = [];
  let finished = 0;
  let bytes = 0;
  let next = 0;
  const report = () =>
    setImportPanel(
      `Exportando OBD ${finished}/${ids.length} · ${(bytes / 1024).toFixed(0)} KiB · ${((performance.now() - started) / 1000).toFixed(1)} s`,
      (finished / ids.length) * 100,
    );
  const worker = async () => {
    while (!signal.aborted && next < ids.length) {
      const index = next++;
      try {
        const result = await fetchObd(category, ids[index], signal);
        results[index] = { name: `${category}_${ids[index]}.obd`, data: result.data };
        bytes += result.data.length;
        result.warnings.forEach((warning) => warnings.push(`${category} ${ids[index]}: ${warning}`));
      } catch (error) {
        if (signal.aborted) return;
        failures.push(`${category} ${ids[index]}: ${error.message}`);
      }
      finished += 1;
      report();
    }
  };
  try {
    report();
    await Promise.all(Array.from({ length: Math.min(OBD_EXPORT_CONCURRENCY, ids.length) }, worker));
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (signal.aborted) {
      setImportPanel(`Exportação cancelada (${finished}/${ids.length} processado(s)).`, 100, false);
      setMessage("Exportação cancelada; nenhum arquivo foi baixado.", "error");
      return;
    }
    const entries = results.filter(Boolean);
    if (entries.length === 0) throw new Error(failures[0] ?? "nenhum objeto exportado");
    if (entries.length === 1) downloadBytes(entries[0].data, entries[0].name, "application/octet-stream");
    else downloadBytes(IO.buildZip(entries), `${category}_${ids[0]}-${ids.at(-1)}_obd.zip`, "application/zip");
    const notes = [...failures.map((failure) => `falha ${failure}`), ...warnings];
    const suffix = notes.length ? ` Avisos: ${notes.slice(0, 3).join(" | ")}${notes.length > 3 ? " …" : ""}` : "";
    setImportPanel(`Concluído: ${entries.length}/${ids.length} OBD em ${seconds} s.`, 100, false);
    setMessage(`${entries.length} objeto(s) exportado(s) em .obd (${seconds} s).${suffix}`, notes.length ? "" : "success");
  } catch (error) {
    setImportPanel(`Falha na exportação: ${error.message}`, 100, false);
    setMessage(`Falha ao exportar OBD: ${error.message}`, "error");
  } finally {
    importState.running = false;
    importState.abort = null;
  }
}

async function importObdFiles(files) {
  if (importState.running) {
    setMessage("Já existe uma importação em andamento.", "error");
    return;
  }
  importState.running = true;
  importState.abort = new AbortController();
  const { signal } = importState.abort;
  const problems = [];
  const created = [];
  let imported = 0;
  let last = null;
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setImportPanel(`Importando OBD ${index + 1}/${files.length}: ${file.name}`, (index / files.length) * 100);
      try {
        if (file.size > 8 * 1024 * 1024) throw new Error("excede 8 MiB");
        const result = await api("/api/project/obd", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: await file.arrayBuffer(),
          signal,
        });
        last = result;
        imported += 1;
        created.push(`${result.category} ${result.id}`);
        result.warnings.forEach((warning) => problems.push(`${file.name}: ${warning}`));
      } catch (error) {
        if (signal.aborted) break;
        problems.push(`${file.name}: ${error.message}`);
      }
    }
  } finally {
    importState.running = false;
    setImportPanel(`Concluído: ${imported}/${files.length} OBD importado(s).`, 100, false);
  }
  // Imported objects are appended as new records. The list only reflects the new counts: the category, page,
  // selection and open record stay as the user left them (switching to the new record's category and jumping
  // to page 0 here used to throw away the user's place in the list on every drop).
  if (last) applySummary(last.summary);
  const where = created.length ? ` Novo(s) registro(s): ${created.slice(0, 5).join(", ")}${created.length > 5 ? " …" : ""}.` : "";
  const detail = problems.length ? ` Avisos/erros: ${problems.slice(0, 3).join(" | ")}${problems.length > 3 ? " …" : ""}` : "";
  setMessage(`${imported} OBD importado(s).${where}${detail}`, problems.length ? (imported ? "" : "error") : "success");
}

/* Delete */

/**
 * Empties the given sprites after an explicit confirmation. SPR IDs are referenced by the DAT, so the IDs stay
 * in place (each becomes a transparent sprite) and no other sprite is renumbered; the confirmation lists the
 * objects that still reference them.
 */
async function deleteSprites(ids) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (!sorted.length) return;
  const many = sorted.length > 1;
  const post = (path) => api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: sorted }),
  });
  const usage = await post("/api/project/sprites/usage");
  const users = usage.records.map((record) => `${record.category} ${record.id}`);
  const usageHtml = usage.total
    ? `<p><strong>${usage.total}</strong> objeto(s) usam ${many ? "essas sprites" : "essa sprite"} e ficarão com partes transparentes:</p>${Dialogs.list(users, 8, usage.total)}`
    : `<p>Nenhum objeto usa ${many ? "essas sprites" : "essa sprite"}.</p>`;
  const confirmed = await Dialogs.confirm({
    title: many ? `Excluir ${sorted.length} sprites?` : `Excluir a sprite ${sorted[0]}?`,
    html: `<p>${many ? `Serão excluídas <strong>${sorted.length}</strong> sprites:` : "Será excluída a sprite:"}</p>`
      + Dialogs.list(sorted.map((id) => `Sprite ${id}`))
      + usageHtml
      + "<p>Os IDs não mudam: cada sprite excluída vira uma sprite vazia, para não renumerar as referências do DAT. A exclusão só chega aos arquivos quando você compilar.</p>",
    confirmText: many ? `Excluir ${sorted.length} sprites` : "Excluir sprite",
    danger: true,
  });
  if (!confirmed) {
    setMessage("Exclusão cancelada; nenhuma sprite foi removida.");
    return;
  }
  let result;
  try {
    result = await post("/api/project/sprites/delete");
  } catch (error) {
    await Dialogs.error("Não foi possível excluir", { text: `${error.message}. Nenhuma sprite foi removida.` });
    return;
  }
  for (const id of result.removed) {
    thumbCache.delete(id);
    state.sprites.selected.delete(id);
  }
  // applySummary re-renders the record list (and the open record), so thumbnails using these sprites refetch them.
  applySummary(result.summary);
  renderSpriteGrid();
  const viewed = Number($("#spriteId").value);
  if (result.removed.includes(viewed)) loadSprite(viewed).catch(() => {});
  if (result.failed.length) {
    setMessage(`${result.removed.length} de ${sorted.length} sprite(s) excluída(s); ${result.failed.length} falharam.`, "", { popup: false });
    await Dialogs.warning("Exclusão incompleta", {
      html: `<p>${result.removed.length} de ${sorted.length} sprite(s) foram excluídas. Não foi possível excluir:</p>`
        + Dialogs.list(result.failed.map((failure) => `Sprite ${failure.id}: ${failure.error}`)),
    });
  } else {
    setMessage(many ? `${result.removed.length} sprites excluídas do modelo.` : `Sprite ${sorted[0]} excluída do modelo.`, "success");
  }
}

/* Copy / properties */

async function copySprite(id) {
  const [frame] = await fetchSprites([id]);
  state.clipboard = new Uint8ClampedArray(frame);
  const size = spriteSize();
  try {
    if (navigator.clipboard && globalThis.ClipboardItem) {
      const png = await rgbaToPngBytes(frame, size, size);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]);
    }
    setMessage(`Sprite ${id} copiada. Use "Colar como nova sprite" para duplicá-la.`, "success");
  } catch {
    setMessage(`Sprite ${id} copiada dentro do editor (o navegador negou acesso à área de transferência).`, "success");
  }
}

async function pasteSprite() {
  if (!state.clipboard) throw new Error("Nenhuma sprite copiada.");
  const result = await api("/api/project/sprite/add", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: state.clipboard,
  });
  applySummary(result.summary);
  await loadSprite(result.spriteId);
  setMessage(`Sprite colada como nova sprite ${result.spriteId}.`, "success");
}

async function showSpriteProperties(id) {
  const [frame] = await fetchSprites([id]);
  const info = state.summary.sprites;
  const position = IO.sheetPosition(id);
  const empty = IO.isEmptyTile(frame);
  const rows = [
    ["ID", String(id)],
    ["Dimensões", `${info.spriteSize}×${info.spriteSize} px`],
    ["Origem", `arquivo SPR do projeto (assinatura 0x${info.signature.toString(16).toUpperCase()})`],
    ["Formato SPR", `${info.extended ? "contagem de 32 bits" : "contagem de 16 bits"} · ${info.transparency ? "RGBA" : "RGB"}`],
    ["Spritesheet", `#${position.sheet} · coluna ${position.column}, linha ${position.row}`],
    ["Conteúdo", empty ? "vazia (totalmente transparente)" : `${Math.round(IO.transparencyRatio(frame) * 100)}% transparente`],
    ["Total de sprites", String(info.spriteCount)],
  ];
  const list = $("#spritePropsList");
  list.replaceChildren();
  for (const [name, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
  $("#spritePropsDialog").showModal();
}
$("#closeSpriteProps").addEventListener("click", () => $("#spritePropsDialog").close());

/* Import */

function setImportPanel(text, progress, running = true) {
  $("#importPanel").classList.remove("hidden");
  $("#importText").textContent = text;
  $("#importProgress").value = progress;
  $("#importCancel").disabled = !running;
}

async function decodeImage(file, signal) {
  if (file.size > LIMITS.maxFileBytes) {
    throw new Error(`excede o limite de ${formatBytes(LIMITS.maxFileBytes)} por arquivo`);
  }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const type = IO.sniffImageType(head);
  if (!type) throw new Error("não é uma imagem PNG, BMP, GIF, JPEG ou WebP válida (verificado pelo conteúdo)");
  signal.throwIfAborted();
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`imagem ${type.toUpperCase()} corrompida ou não decodificável`);
  }
  try {
    if (bitmap.width * bitmap.height > LIMITS.maxPixels) {
      throw new Error(`${bitmap.width}×${bitmap.height} excede o limite de ${LIMITS.maxPixels.toLocaleString()} pixels`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    canvas.width = 0;
    return { width: bitmap.width, height: bitmap.height, rgba: data, type };
  } finally {
    bitmap.close();
  }
}

async function readMetadata(file) {
  if (file.size > 4 * 1024 * 1024) throw new Error("metadados JSON acima de 4 MiB");
  const data = JSON.parse(await file.text());
  if (!data || typeof data !== "object" || !Array.isArray(data.cells)) throw new Error("JSON não é um metadado de spritesheet do OTEditor");
  return data;
}

async function importFiles(fileList, { single = false } = {}) {
  if (!state.summary) {
    setMessage("Abra ou crie um projeto antes de importar sprites.", "error");
    return;
  }
  if (importState.running) {
    setMessage("Já existe uma importação em andamento.", "error");
    return;
  }
  const files = [...fileList];
  if (!files.length) return;
  if (files.length > LIMITS.maxFiles) {
    setMessage(`Selecione no máximo ${LIMITS.maxFiles} arquivos por importação.`, "error");
    return;
  }
  importState.running = true;
  importState.abort = new AbortController();
  const { signal } = importState.abort;
  const size = spriteSize();
  const jsonByStem = new Map();
  const images = [];
  const report = [];
  for (const file of files) {
    const stem = file.name.replace(/\.[^.]+$/, "").toLowerCase();
    if (/\.json$/i.test(file.name)) jsonByStem.set(stem, file);
    else images.push({ file, stem });
  }
  let imported = 0;
  let firstId = null;
  let lastId = null;
  try {
    for (let index = 0; index < images.length; index += 1) {
      const { file, stem } = images[index];
      setImportPanel(`Importando ${index + 1}/${images.length}: ${file.name}`, (index / images.length) * 100);
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      try {
        if (importState.seen.has(key)) throw new Error("este arquivo já foi importado nesta sessão (ignorado para evitar duplicatas)");
        const image = await decodeImage(file, signal);
        let tiles;
        let skipped = 0;
        if (image.width === size && image.height === size) {
          tiles = [{ rgba: image.rgba }];
        } else if (single) {
          throw new Error(`a imagem tem ${image.width}×${image.height}; uma sprite deve ter ${size}×${size}. Use "Importar spritesheets" para cortar em grade`);
        } else {
          const metaFile = jsonByStem.get(stem);
          const metadata = metaFile ? await readMetadata(metaFile) : undefined;
          ({ tiles, skipped } = IO.sliceSheet(image.rgba, image.width, image.height, size, { metadata }));
        }
        signal.throwIfAborted();
        if (!tiles.length) throw new Error("nenhuma sprite não vazia encontrada");
        const batch = new Uint8Array(tiles.length * size * size * 4);
        tiles.forEach((tile, tileIndex) => batch.set(tile.rgba, tileIndex * size * size * 4));
        const result = await api("/api/project/sprites", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: batch,
          signal,
        });
        state.summary = result.summary;
        importState.seen.add(key);
        imported += tiles.length;
        firstId ??= result.firstId;
        lastId = result.firstId + result.count - 1;
        report.push(`✔ ${file.name}: ${tiles.length} sprite(s) → IDs ${result.firstId}–${lastId}${skipped ? `, ${skipped} vazia(s) ignorada(s)` : ""}`);
      } catch (error) {
        if (signal.aborted) throw error;
        report.push(`✖ ${file.name}: ${error.message}`);
      }
    }
    for (const [stem, file] of jsonByStem) {
      if (!images.some((entry) => entry.stem === stem)) report.push(`⚠ ${file.name}: JSON sem imagem correspondente (ignorado)`);
    }
  } catch (error) {
    report.push(signal.aborted ? "⚠ Importação cancelada; arquivos já enviados foram mantidos." : `✖ ${error.message}`);
  } finally {
    importState.running = false;
    importState.abort = null;
  }
  const failures = report.filter((line) => line.startsWith("✖")).length;
  setImportPanel(`${imported} sprite(s) importada(s) de ${images.length} arquivo(s); ${failures} falha(s).\n${report.join("\n")}`, 100, false);
  setMessage(
    imported ? `${imported} sprite(s) importada(s) (IDs ${firstId}–${lastId}).${failures ? ` ${failures} arquivo(s) falharam.` : ""}` : "Nenhuma sprite foi importada.",
    failures || !imported ? "error" : "success",
  );
  // New sprites are appended after the last ID; the grid only re-renders its current page (the page label and
  // the last page change with the new total). The page, the selection and the sprite in the preview are kept:
  // jumping to the imported IDs here used to move the user's place in the sprite list on every drop.
  if (imported) {
    applySummary(state.summary);
    renderSpriteGrid();
  }
}

$("#importCancel").addEventListener("click", () => importState.abort?.abort());
$("#importSheetsButton").addEventListener("click", () => $("#importSheetsInput").click());
$("#importSingleInput").addEventListener("change", (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  importFiles(files, { single: true });
});
$("#importSheetsInput").addEventListener("change", (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  importFiles(files);
});

/* Drag and drop from the file manager (internal drags carry no "Files" type) */

let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  $("#dropOverlay").classList.remove("hidden");
});
window.addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = state.summary ? "copy" : "none";
});
window.addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $("#dropOverlay").classList.add("hidden");
});
window.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  $("#dropOverlay").classList.add("hidden");
  const dropped = [...event.dataTransfer.files];
  const obd = dropped.filter((file) => /\.obd$/i.test(file.name));
  const rest = dropped.filter((file) => !/\.obd$/i.test(file.name));
  if (!state.summary) {
    setMessage("Abra ou crie um projeto antes de importar.", "error");
    return;
  }
  if (obd.length) importObdFiles(obd).then(() => (rest.length ? importFiles(rest) : undefined));
  else importFiles(rest);
});

/* ---------- Development live reload (only when the server runs with DEV_RELOAD=1) ----------
   The server streams `hello` (its boot ID) and `change` (edited files under web/) over /api/dev/events.
   - CSS changes swap the stylesheet in place.
   - JS/HTML changes reload the page. The project stays in the server's memory, so the new page reattaches to
     it and restores the category, search, pages, selections, viewed sprite and open record; the folder handles
     come back from IndexedDB.
   - A new boot ID means the server restarted (code under src/ changed) and lost the project: it is reopened
     from the folder, keeping the view. Edits that were not saved to the folder are lost, and the user is told.
   In production the route answers 404, the EventSource fails before any `hello` and is closed for good. */

const VIEW_KEY = "oteditor:dev-view";
const devReload = { bootId: null, timer: null };

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function folderStore(mode) {
  const open = indexedDB.open("oteditor", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("folder");
  const db = await idbRequest(open);
  return { store: db.transaction("folder", mode).objectStore("folder"), db };
}

/** Keeps the open folder's handles (structured-cloneable) so a reloaded page can use them again. */
async function rememberFolder() {
  try {
    const { store, db } = await folderStore("readwrite");
    await idbRequest(folderState.project ? store.put({ root: folderState.root, project: folderState.project }, "project") : store.delete("project"));
    db.close();
  } catch {
    // Without IndexedDB a development reload only loses the folder link, not the project.
  }
}

async function recallFolder() {
  try {
    const { store, db } = await folderStore("readonly");
    const value = await idbRequest(store.get("project"));
    db.close();
    return value ?? null;
  } catch {
    return null;
  }
}

function saveViewForReload() {
  const view = {
    category: currentCategory(),
    search: $("#searchId").value,
    clientVersion: $("#clientVersion").value,
    page: state.page,
    spritePage: state.sprites.page,
    spriteId: $("#spriteId").value,
    sprites: [...state.sprites.selected],
    records: state.recordSel.category ? { category: state.recordSel.category, ids: [...state.recordSel.ids] } : null,
    openRecord: $("#recordModal").open && state.selected ? { category: state.selected.category, id: state.selected.id } : null,
    savedRevision: state.savedRevision,
    scroll: window.scrollY,
  };
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Private mode: the page still reloads, just without the saved view.
  }
}

function takeSavedView() {
  try {
    const raw = sessionStorage.getItem(VIEW_KEY);
    sessionStorage.removeItem(VIEW_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function applySavedView(view) {
  $("#category").value = view.category;
  $("#searchId").value = view.search;
  $("#clientVersion").value = view.clientVersion;
  $("#spriteId").value = view.spriteId;
  state.page = view.page;
  state.sprites.page = view.spritePage;
  state.sprites.selected = new Set(view.sprites);
  if (view.records) state.recordSel = { category: view.records.category, ids: new Set(view.records.ids), anchor: null };
  state.pendingOpenRecord = view.openRecord;
}

/** Re-links the remembered folder; watching needs permission, which a reloaded page may have to ask again. */
async function relinkFolder(remembered) {
  folderState.root = remembered.root;
  folderState.project = remembered.project;
  folderState.entries = [];
  $("#pickedFolder").textContent = remembered.root?.name ?? remembered.project.dat.path.split("/")[0];
  updateCompileTarget();
  if ((await remembered.project.dat.dir.queryPermission({ mode: "readwrite" })) === "granted") {
    await startWatching();
    return;
  }
  setWatchStatus("● pasta desconectada — clique para reconectar", "watch-error");
  const chip = $("#watchStatus");
  chip.classList.add("clickable");
  chip.addEventListener("click", async function reconnect() {
    if (!(await ensureWritePermission(remembered.project))) return;
    chip.removeEventListener("click", reconnect);
    chip.classList.remove("clickable");
    await startWatching();
  });
}

/** After a development page reload: reattach to the project still open on the server and restore the view. */
async function restoreAfterDevReload() {
  const view = takeSavedView();
  if (!view) return;
  const remembered = await recallFolder();
  try {
    applySavedView(view);
    let summary;
    try {
      summary = (await api("/api/project/summary")).summary;
    } catch {
      // The server restarted together with the page: reopen the project from the folder, if it can be read.
      if (!remembered || (await remembered.project.dat.dir.queryPermission({ mode: "read" })) !== "granted") {
        setMessage("O servidor reiniciou e perdeu o projeto. Abra a pasta novamente.", "error");
        return;
      }
      folderState.project = remembered.project;
      remembered.project = FS.findProjectFiles(await listProjectDirectories());
      summary = (await uploadAndOpen(remembered.project)).summary;
      view.savedRevision = summary.revision;
    }
    startProject(summary, { preserve: true });
    state.savedRevision = view.savedRevision;
    updateProjectStatus();
    if (remembered) await relinkFolder(remembered);
    else updateCompileTarget();
    requestAnimationFrame(() => window.scrollTo(0, view.scroll));
    setMessage("Editor atualizado (recarga de desenvolvimento).", "", { popup: false });
  } catch (error) {
    setMessage(`Não foi possível restaurar o projeto após a recarga: ${error.message}`, "error");
  }
}

function swapStylesheet() {
  const current = document.querySelector('link[rel="stylesheet"][href^="/app.css"]');
  if (!current) return;
  const next = current.cloneNode();
  next.href = `/app.css?v=${Date.now()}`;
  next.addEventListener("load", () => current.remove(), { once: true });
  current.after(next);
}

function applyDevChange(files) {
  if (files.every((file) => file.endsWith(".css"))) {
    swapStylesheet();
    return;
  }
  // Coalesce bursts; never reload in the middle of a save, a reload or an import.
  clearTimeout(devReload.timer);
  devReload.timer = setTimeout(function reloadWhenIdle() {
    if (projectLock.name || importState.running) {
      devReload.timer = setTimeout(reloadWhenIdle, 500);
      return;
    }
    if (state.summary) saveViewForReload();
    location.reload();
  }, 150);
}

async function handleServerRestart() {
  if (!state.summary) return;
  const lostEdits = hasUnsavedChanges();
  if (!folderState.project) {
    setMessage("O servidor reiniciou e perdeu o projeto. Abra a pasta novamente.", "error");
    return;
  }
  try {
    // Pick the files again: the folder may have changed while the server was down.
    const picked = FS.findProjectFiles(await listProjectDirectories());
    await withProjectLock("recarga do projeto", () => reloadProject(picked));
    if (lostEdits) {
      Dialogs.warning("Servidor reiniciado", {
        text: "O servidor foi reiniciado e o projeto foi reaberto da pasta. As alterações que ainda não tinham sido gravadas na pasta foram perdidas.",
      });
    } else {
      Dialogs.toast("Servidor reiniciado; projeto reaberto da pasta.", "info");
    }
  } catch (error) {
    setMessage(`O servidor reiniciou e não foi possível reabrir o projeto: ${error.message}`, "error");
  }
}

function connectDevReload() {
  const source = new EventSource("/api/dev/events");
  source.addEventListener("hello", (event) => {
    const { bootId } = JSON.parse(event.data);
    const restarted = devReload.bootId !== null && devReload.bootId !== bootId;
    devReload.bootId = bootId;
    if (restarted) handleServerRestart();
  });
  source.addEventListener("change", (event) => applyDevChange(JSON.parse(event.data).files));
  source.addEventListener("error", () => {
    // No `hello` yet: the route does not exist (production server). Stop instead of retrying forever.
    if (devReload.bootId === null) source.close();
  });
}

restoreAfterDevReload().finally(connectDevReload);
