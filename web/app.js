const $ = (selector) => document.querySelector(selector);

const state = {
  summary: null,
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

function setMessage(message, kind = "") {
  const element = $("#message");
  element.textContent = message;
  element.className = `message ${kind}`;
  const modal = $("#modalMessage");
  modal.textContent = message;
  modal.className = `message ${kind}`;
}

function setBusy(button, busy, busyText = "Processando…") {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label;
}

function currentCategory() {
  return $("#category").value;
}

async function uploadFile(kind, file) {
  return api(`/api/upload?kind=${kind}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
}

function findProjectFiles(files) {
  const candidates = { dat: [], spr: [], otfi: [] };
  for (const file of files) {
    const relativePath = file.webkitRelativePath || file.name;
    const filename = relativePath.split("/").at(-1);
    const match = /^(.+)\.(dat|spr|otfi)$/i.exec(filename);
    if (match) candidates[match[2].toLowerCase()].push({ file, stem: match[1].toLowerCase() });
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

  const matchingOtfi = candidates.otfi.filter((entry) => entry.stem === selectedPair.dat.stem);
  let otfi;
  if (matchingOtfi.length === 1) otfi = matchingOtfi[0].file;
  else if (matchingOtfi.length > 1 || (!matchingOtfi.length && candidates.otfi.length > 1)) {
    throw new Error("Encontrei mais de um OTFI. Deixe apenas um OTFI correspondente ao DAT.");
  } else if (candidates.otfi.length === 1) otfi = candidates.otfi[0].file;

  return { dat: selectedPair.dat.file, spr: selectedPair.spr.file, otfi };
}

async function openProject() {
  const button = $("#openProject");
  try {
    setBusy(button, true, "Lendo arquivos…");
    const selectedFiles = $("#projectFolder").files;
    if (!selectedFiles.length) throw new Error("Selecione a pasta do projeto.");
    const { dat, spr, otfi } = findProjectFiles(selectedFiles);
    setMessage(`Enviando ${dat.name}…`);
    await uploadFile("dat", dat);
    setMessage(`Enviando ${spr.name} (${formatBytes(spr.size)})…`);
    await uploadFile("spr", spr);
    if (otfi) {
      setMessage(`Enviando ${otfi.name}…`);
      await uploadFile("otfi", otfi);
    }
    const version = Number($("#clientVersion").value);
    const result = await api(`/api/project/open?clientVersion=${encodeURIComponent(version)}`, { method: "POST" });
    state.selected = null;
    state.page = 0;
    thumbCache.clear();
    state.sprites.rendered = false;
    state.sprites.selected.clear();
    state.sprites.page = 0;
    applySummary(result.summary);
    const warnings = result.summary.warnings ?? [];
    setMessage(
      warnings.length ? `Projeto aberto com aviso: ${warnings.join(" ")}` : "Projeto aberto. Os arquivos ficam somente na memória do editor local.",
      warnings.length ? "" : "success",
    );
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

$("#projectFolder").addEventListener("change", () => {
  const files = $("#projectFolder").files;
  if (!files.length) {
    $("#folderContents").textContent = "Selecione uma pasta que contenha os arquivos do cliente.";
    return;
  }
  try {
    const selected = findProjectFiles(files);
    $("#folderContents").textContent = [
      selected.dat.name,
      selected.spr.name,
      selected.otfi?.name ?? "OTFI não encontrado (opcional)",
    ].join(" · ");
  } catch (error) {
    $("#folderContents").textContent = error.message;
  }
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
    state.selected = null;
    state.page = 0;
    thumbCache.clear();
    state.sprites.rendered = false;
    state.sprites.selected.clear();
    state.sprites.page = 0;
    applySummary(result.summary);
    setMessage("Projeto vazio criado. Adicione registros e sprites antes de compilar.", "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function applySummary(summary) {
  const previousCount = state.summary?.sprites.spriteCount;
  state.summary = summary;
  state.spriteInfo = summary.sprites;
  $("#workspace").classList.remove("hidden");
  $("#compilePanel").classList.remove("hidden");
  $("#projectStatus").textContent = `${summary.sprites.spriteCount} sprites · ${summary.dirty ? "alterações pendentes" : "carregado"}`;
  $("#spriteCanvas").width = summary.sprites.spriteSize;
  $("#spriteCanvas").height = summary.sprites.spriteSize;
  renderSprite(new Uint8Array(summary.sprites.spriteSize * summary.sprites.spriteSize * 4));
  refreshRecords();
  if (previousCount !== summary.sprites.spriteCount || !state.sprites.rendered) renderSpriteGrid();
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
    if (state.selected) {
      const selected = state.records.find((record) => record.id === state.selected.id && record.category === state.selected.category);
      if (selected) {
        state.selected = selected;
        if ($("#recordModal").open) renderRecord(selected);
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
    setMessage(/No asset project is open/i.test(message) ? "O servidor foi reiniciado e perdeu o projeto. Recarregue a página e abra a pasta novamente." : "Servidor indisponível no momento. Tentando reconectar…", "error");
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

// Outfit patternX is the direction (0 north/back, 1 east, 2 south/front, 3 west).
function frameSpriteIds(record, group, frame) {
  const width = Math.max(1, group.width);
  const height = Math.max(1, group.height);
  const direction = record.category === "outfits" && group.patternX >= 3 ? 2 : 0;
  const perCell = group.layers;
  const cells = [];
  for (let h = 0; h < height; h += 1) {
    for (let w = 0; w < width; w += 1) {
      const index = ((((frame * group.patternZ) * group.patternY) * group.patternX + direction) * perCell) * height * width + h * width + w;
      cells.push({ w, h, id: group.spriteIds[index] });
    }
  }
  return { width, height, cells };
}

async function drawThumbnail(canvas, record, frame = 0) {
  const group = record.groups[0];
  const size = state.spriteInfo.spriteSize;
  if (!group) return;
  const { width, height, cells } = frameSpriteIds(record, group, frame % Math.max(1, group.frames));
  const buffer = document.createElement("canvas");
  buffer.width = size * width;
  buffer.height = size * height;
  const bufferContext = buffer.getContext("2d");
  for (const cell of cells) {
    if (!cell.id) continue;
    try {
      const rgba = await fetchSpriteRgba(cell.id);
      bufferContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), (width - 1 - cell.w) * size, (height - 1 - cell.h) * size);
    } catch (error) {
      if (error?.name === "ServerUnavailableError") return;
      // Missing sprites stay transparent in the thumbnail.
    }
  }
  if (canvas.width !== buffer.width) canvas.width = buffer.width;
  if (canvas.height !== buffer.height) canvas.height = buffer.height;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(buffer, 0, 0);
}

const animations = new WeakMap();

function stopAnimation(canvas) {
  const timer = animations.get(canvas);
  if (timer) clearInterval(timer);
  animations.delete(canvas);
}

function startAnimation(canvas, record) {
  stopAnimation(canvas);
  const frames = record.groups[0]?.frames ?? 1;
  if (frames <= 1) return;
  let frame = 0;
  let busy = false;
  animations.set(canvas, setInterval(async () => {
    if (busy) return;
    busy = true;
    frame = (frame + 1) % frames;
    await drawThumbnail(canvas, record, frame);
    busy = false;
  }, 250));
}

let thumbObserver;
const visibleTiles = new Map();

// One shared timer animates only the tiles currently scrolled into view.
setInterval(() => {
  for (const [tile, entry] of visibleTiles) {
    const frames = entry.record.groups[0]?.frames ?? 1;
    if (frames <= 1 || entry.busy || !tile.isConnected) continue;
    entry.busy = true;
    entry.frame = (entry.frame + 1) % frames;
    drawThumbnail(tile.querySelector("canvas"), entry.record, entry.frame).finally(() => {
      entry.busy = false;
    });
  }
}, 250);

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
  if (event.target instanceof Element && event.target.closest("input, textarea, select, dialog")) return;
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
  drawThumbnail($("#modalThumb"), record).then(() => startAnimation($("#modalThumb"), record));
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

async function removeRecord() {
  if (!state.selected || !confirm(`Excluir o registro ${state.selected.id}? Esta alteração só é aplicada aos arquivos compilados.`)) return;
  try {
    const query = new URLSearchParams({ category: state.selected.category, id: String(state.selected.id) });
    const result = await api(`/api/project/record?${query}`, { method: "DELETE" });
    state.selected = null;
    $("#recordModal").close();
    applySummary(result.summary);
    setMessage("Registro removido do modelo.", "success");
  } catch (error) {
    setMessage(error.message, "error");
  }
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

async function compileProject() {
  const button = $("#compileProject");
  try {
    setBusy(button, true, "Validando DAT/SPR/OTFI…");
    const result = await api("/api/project/compile", { method: "POST" });
    const downloads = $("#downloads");
    downloads.replaceChildren();
    for (const file of result.files) {
      const button = document.createElement("button");
      button.textContent = `Baixar ${file.name} (${formatBytes(file.size)})`;
      button.addEventListener("click", () => downloadFile(file.format, file.name));
      downloads.append(button);
    }
    setMessage("Compilação validada. Baixe cada arquivo para criar o conjunto de saída.", "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function downloadFile(format, name) {
  try {
    const response = await api(`/api/project/download?format=${format}`);
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
$("#recordModal").addEventListener("close", () => stopAnimation($("#modalThumb")));
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
  document.querySelectorAll(".sprite-tile").forEach((tile) => {
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
    document.querySelectorAll(".sprite-tile").forEach((tile) => state.sprites.selected.add(Number(tile.dataset.id)));
    document.querySelectorAll(".sprite-tile").forEach((tile) => tile.classList.add("selected"));
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

function spriteIdForTarget(target) {
  const tile = target.closest(".sprite-tile");
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

async function fetchObd(category, id) {
  const query = new URLSearchParams({ category, id: String(id) });
  const response = await api(`/api/project/obd?${query}`);
  const warnings = JSON.parse(decodeURIComponent(response.headers.get("x-obd-warnings") || "%5B%5D"));
  return { data: new Uint8Array(await response.arrayBuffer()), warnings };
}

async function exportObd(category, ids) {
  const warnings = [];
  const entries = [];
  for (let index = 0; index < ids.length; index += 1) {
    setMessage(`Exportando OBD ${index + 1}/${ids.length} (objetos grandes podem levar alguns segundos cada)…`);
    const result = await fetchObd(category, ids[index]);
    entries.push({ name: `${category}_${ids[index]}.obd`, data: result.data });
    result.warnings.forEach((warning) => warnings.push(`${category} ${ids[index]}: ${warning}`));
  }
  if (entries.length === 1) downloadBytes(entries[0].data, entries[0].name, "application/octet-stream");
  else downloadBytes(IO.buildZip(entries), `${category}_${ids[0]}-${ids.at(-1)}_obd.zip`, "application/zip");
  const suffix = warnings.length ? ` Avisos: ${warnings.slice(0, 3).join(" | ")}${warnings.length > 3 ? " …" : ""}` : "";
  setMessage(`${entries.length} objeto(s) exportado(s) em .obd.${suffix}`, warnings.length ? "" : "success");
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
  if (last) {
    $("#category").value = last.category;
    state.page = 0;
    applySummary(last.summary);
    clearRecordSelection();
  }
  const detail = problems.length ? ` Avisos/erros: ${problems.slice(0, 3).join(" | ")}${problems.length > 3 ? " …" : ""}` : "";
  setMessage(`${imported} OBD importado(s) como novo(s) registro(s).${detail}`, problems.length ? (imported ? "" : "error") : "success");
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
  if (imported) {
    state.sprites.page = Math.floor((lastId - 1) / state.sprites.pageSize);
    applySummary(state.summary);
    renderSpriteGrid();
    await loadSprite(firstId).catch(() => {});
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
