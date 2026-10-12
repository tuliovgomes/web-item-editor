/* Pure, DOM-free helpers for sprite/spritesheet import and export. Loaded as a classic script in the browser
   (global `SpriteIO`) and as a CommonJS module by the tests. */
(function (root) {
  "use strict";

  const SHEET_COLUMNS = 32;
  const SHEET_SPRITES = SHEET_COLUMNS * SHEET_COLUMNS;

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function sanitizeFileName(name) {
    const cleaned = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "");
    return cleaned.slice(0, 120) || "file";
  }

  /** Builds a store-only (uncompressed) ZIP archive. PNG data is already compressed. */
  function buildZip(entries) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    const names = new Set();
    let offset = 0;
    for (const entry of entries) {
      const name = sanitizeFileName(entry.name);
      if (names.has(name)) throw new Error(`Duplicate ZIP entry name: ${name}`);
      names.add(name);
      const nameBytes = encoder.encode(name);
      const data = entry.data;
      if (data.length > 0xffffffff || offset > 0xffffffff || entries.length > 0xffff) {
        throw new Error("ZIP package exceeds the classic ZIP size limits");
      }
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);
      const header = new DataView(new ArrayBuffer(46));
      header.setUint32(0, 0x02014b50, true);
      header.setUint16(4, 20, true);
      header.setUint16(6, 20, true);
      header.setUint16(8, 0x0800, true);
      header.setUint32(16, crc, true);
      header.setUint32(20, data.length, true);
      header.setUint32(24, data.length, true);
      header.setUint16(28, nameBytes.length, true);
      header.setUint32(42, offset, true);
      central.push(new Uint8Array(header.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const all = [...chunks, ...central, new Uint8Array(end.buffer)];
    const result = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
    let position = 0;
    for (const part of all) {
      result.set(part, position);
      position += part.length;
    }
    return result;
  }

  /** Detects the real image type from magic bytes; the extension is never trusted. */
  function sniffImageType(bytes) {
    const startsWith = (...signature) => signature.every((value, index) => bytes[index] === value);
    if (bytes.length >= 8 && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
    if (bytes.length >= 3 && startsWith(0xff, 0xd8, 0xff)) return "jpeg";
    if (bytes.length >= 6 && startsWith(0x47, 0x49, 0x46, 0x38)) return "gif";
    if (bytes.length >= 2 && startsWith(0x42, 0x4d)) return "bmp";
    if (bytes.length >= 12 && startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return "webp";
    return null;
  }

  /** Sheet N groups SPR IDs (N*1024+1 .. (N+1)*1024) in a 32-column grid. */
  function sheetIndexOf(spriteId) {
    return Math.floor((spriteId - 1) / SHEET_SPRITES);
  }

  function sheetRange(sheetIndex, spriteCount) {
    const first = sheetIndex * SHEET_SPRITES + 1;
    const last = Math.min(spriteCount, first + SHEET_SPRITES - 1);
    const ids = [];
    for (let id = first; id <= last; id += 1) ids.push(id);
    return ids;
  }

  function sheetPosition(spriteId) {
    const slot = (spriteId - 1) % SHEET_SPRITES;
    return { sheet: sheetIndexOf(spriteId), column: slot % SHEET_COLUMNS, row: Math.floor(slot / SHEET_COLUMNS) };
  }

  /** Composes `ids` (RGBA frames, in order) into one RGBA atlas and returns it with reconstruction metadata. */
  function composeSheet(ids, frames, tileSize, columns) {
    if (ids.length !== frames.length || ids.length === 0) throw new Error("Sheet needs one frame per sprite ID");
    const frameBytes = tileSize * tileSize * 4;
    const cols = Math.max(1, Math.min(columns, ids.length));
    const rows = Math.ceil(ids.length / cols);
    const width = cols * tileSize;
    const height = rows * tileSize;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const cells = [];
    ids.forEach((id, index) => {
      const frame = frames[index];
      if (frame.length !== frameBytes) throw new Error(`Sprite ${id} has an unexpected frame length`);
      const x = (index % cols) * tileSize;
      const y = Math.floor(index / cols) * tileSize;
      for (let line = 0; line < tileSize; line += 1) {
        rgba.set(frame.subarray(line * tileSize * 4, (line + 1) * tileSize * 4), ((y + line) * width + x) * 4);
      }
      cells.push({ id, x, y });
    });
    return { width, height, rgba, metadata: { version: 1, tileSize, columns: cols, rows, width, height, cells } };
  }

  function isEmptyTile(rgba) {
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false;
    return true;
  }

  /**
   * Slices an RGBA atlas into tiles. Uses `metadata.cells` when given; otherwise requires a regular grid of
   * `tileSize` tiles and refuses to guess when the image is not an exact multiple.
   */
  function sliceSheet(rgba, width, height, tileSize, options) {
    const opts = options || {};
    const maxTiles = opts.maxTiles || 8192;
    if (rgba.length !== width * height * 4) throw new Error("Image data does not match its dimensions");
    let positions;
    if (opts.metadata) {
      const meta = opts.metadata;
      if (meta.tileSize !== tileSize) {
        throw new Error(`Metadata tile size ${meta.tileSize} differs from the project sprite size ${tileSize}`);
      }
      if (!Array.isArray(meta.cells)) throw new Error("Metadata has no cells array");
      positions = meta.cells.map((cell) => {
        if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) || cell.x < 0 || cell.y < 0
          || cell.x + tileSize > width || cell.y + tileSize > height) {
          throw new Error(`Metadata cell (${cell.x}, ${cell.y}) is outside the image`);
        }
        return { x: cell.x, y: cell.y, sourceId: cell.id };
      });
    } else {
      if (width % tileSize !== 0 || height % tileSize !== 0) {
        throw new Error(
          `Image is ${width}×${height}; it is not a regular grid of ${tileSize}×${tileSize} tiles, so it was not cut automatically`,
        );
      }
      positions = [];
      for (let y = 0; y < height; y += tileSize) for (let x = 0; x < width; x += tileSize) positions.push({ x, y });
    }
    if (positions.length > maxTiles) throw new Error(`Image has ${positions.length} tiles; the limit is ${maxTiles}`);
    const tiles = [];
    let skipped = 0;
    for (const position of positions) {
      const tile = new Uint8ClampedArray(tileSize * tileSize * 4);
      for (let line = 0; line < tileSize; line += 1) {
        const start = ((position.y + line) * width + position.x) * 4;
        tile.set(rgba.subarray(start, start + tileSize * 4), line * tileSize * 4);
      }
      if (opts.skipEmpty !== false && isEmptyTile(tile)) {
        skipped += 1;
        continue;
      }
      tiles.push({ x: position.x, y: position.y, sourceId: position.sourceId, rgba: tile });
    }
    return { tiles, skipped };
  }

  function transparencyRatio(rgba) {
    let transparent = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) transparent += 1;
    return transparent / (rgba.length / 4);
  }

  const api = {
    SHEET_COLUMNS, SHEET_SPRITES, crc32, sanitizeFileName, buildZip, sniffImageType,
    sheetIndexOf, sheetRange, sheetPosition, composeSheet, sliceSheet, isEmptyTile, transparencyRatio,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SpriteIO = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
