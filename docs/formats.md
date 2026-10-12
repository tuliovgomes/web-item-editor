# Format findings and compatibility matrix

The following structures are confirmed from the original parsers. These notes describe parser behavior and are not a substitute for testing against every Open Tibia fork or client version.

| Format | Structure observed in OTEditor | Evidence / current support |
|---|---|---|
| **DAT** | Starts with a 32-bit little-endian signature followed by four 16-bit little-endian maximum IDs (items, outfits, effects, missiles), a 12-byte header total. Items are indexed from client ID 100; outfits, effects and missiles start at ID 1. Records encode version-dependent property flags, layout/frame metadata, and sprite IDs; animated frames may carry durations and outfits may have frame groups. | `libs/otformats/datreader.cpp`, `datreader.h`; source supports editing and writing. TypeScript support: initial implementation reads all four category layouts, preserves raw records, edits sprite references, creates/removes records, and serializes. Unknown flags are rejected because their payload boundaries cannot be safely inferred. |
| **SPR** | 32-bit little-endian signature; 16-bit sprite count in legacy mode or 32-bit count in extended mode; 32-bit little-endian offset table. Sprite records use a three-byte color-key field, a 16-bit payload length, then repeated little-endian transparent-pixel and colored-pixel counts followed by RGB (or RGBA with transparency enabled) pixels. The color-key bytes are not required to equal a fixed marker. Empty sprites have zero offset. The configured sprite dimension may come from OTFI. | `libs/otformats/sprreader.cpp`, `sprreader.h`; source uses mmap for bulk reads and capped LRUs. TypeScript support: parse, decode to RGBA, replace/add/remove and serialize. |
| **OTB** | Four-byte identifier `OTBI` (the reader also accepts four zero bytes), followed by an escaped hierarchical node stream. Marker bytes are `FE` start, `FF` end and `FD` escape. Root data includes an initial byte/flags and a version attribute (`01`, 16-bit payload length, then major/minor/build as three little-endian u32 values). Item node data starts with group u8 and flags u32, then attributes as type u8, payload length u16, payload bytes. Known types include server/client IDs, name, description, speed, sprite hash, minimap color, text lengths, light, stack order and trade/ware ID; other attributes are opaque. Text and numeric payloads are little-endian/Latin-1 in the original reader. | `libs/otformats/nodefilereader.*`, `otbreader.*`; source and optional real-corpus compatibility tests. TypeScript support: first increment. |
| **OTBM** | Uses the same escaped node convention with map nodes for root header, map data, tile areas/tiles/items, towns, waypoints and spawn-related data. Header values include OTBM version, map dimensions, client/item versions and description. Items/tiles carry version-dependent attributes; spawn and house XML sidecars are also parsed/written. | `libs/otformats/otbmreader.*`; reader is not referenced by discovered QML/backend flow. TypeScript support: future, after confirming target dialects. |
| **OTFI** | Text file with a `DatSpr` section and indented `key: value` entries. Observed keys: `extended`, `transparency`, `frame-durations`, `frame-groups`, `metadata-file`, `sprites-file`, `attribute-server`, `metadata-controller`, `sprite-size`. Defaults for missing file names are `Tibia.dat` and `Tibia.spr`. | `libs/otformats/otfireader.*`, `src/projectmodel.cpp`; TypeScript support: parse, edit while retaining unknown lines and generate new-project configuration. |
| **items.xml** | XML `<item>` entries can refer to an exact `id` or `fromid`/`toid` range. Item attributes include XML attributes and nested `<attribute key="…" value="…"/>` elements. The reader expands ranges into ID mappings; the writer streams original XML and changes relevant attributes. | `libs/otformats/itemsxmlreader.*`; TypeScript support: planned. |
| **OBD** | ObjectBuilder payload is LZMA-Alone compressed. The codec recognizes legacy versions where the first u16 is a client version and OBD v2/v3 records with version/client/category/texture-offset headers. Object properties use flags; texture data includes layout, sprite IDs and RGBA pixel buffers. v3 export requires 32×32 sprites. The source caps decompressed data at 128 MiB and decoder memory at 256 MiB. | `src/obdcodec.*`, `tests/editor_tests.cpp`; external examples are optional and absent from clone. TypeScript support: planned after fixture acquisition. |

## First increment: OTB

Implemented OTB scope is intentionally narrower than the original editor:

- Parse `OTBI` and zero identifiers, escaped bytes, root payload/version, item groups/flags and length-prefixed attributes.
- Retain complete unrecognized item attribute payloads and original root data.
- Return the original input bytes when a document is unchanged; edited output re-escapes node data and preserves the order and payloads of untouched attributes.
- Expose read/write for a whitelist of OTB fields and a CLI that writes to a new, non-existing output path.
- Reject truncated, structurally invalid, oversized files and invalid known-field payloads instead of returning success-shaped partial data.

This does **not** establish compatibility with every OTB fork. No actual OTB corpus is included here. Compatibility tests in this workspace use hand-built fixtures and verify semantic and opaque-attribute preservation.

## Current DAT implementation boundary

- `DatDocument.parse(buffer, { clientVersion, otfi? })` uses the client version's observed defaults (`extended` from 9.60, frame durations from 10.50, frame groups from 10.57); explicit OTFI booleans override these defaults.
- The parser reads the header, all four categories, version-transformed property flags (including payload lengths for recognized flags), sprite dimensions, frame metadata, durations and sprite IDs. Records retain raw bytes for loss-aware output.
- Supported mutations include recognized boolean flags, numeric and market-name properties, sprite-ID edits, appending a default or cloned record, and removing a record. Signed offset properties use signed 16-bit values. IDs follow category ordering (items begin at 100; other categories begin at 1).
- An unchanged document emits the original bytes. Changed output rewrites the maximum-ID header and emits retained record bytes; edits to sprite references update their exact little-endian locations. A new project can be created with an empty valid DAT header.
- Safety limits: 2 GiB input by default, 262,144 total records and 1,048,576 sprite references per record. Truncated structures, impossible dimensions, unknown flags and trailing bytes/version mismatches are errors.
- Unknown DAT flags whose payload schema is unavailable are rejected. Tests use synthetic fixtures and one user-provided modern DAT/SPR/OTFI set; the client assets are not included or redistributed. Full differential compatibility across real client files and all versions is not established.

## Current DAT+SPR+OTFI project workflow

`AssetProject` opens or creates all three documents, exposes DAT properties and sprite operations, then compiles by serializing and re-parsing changed DAT and SPR documents. DAT and SPR signatures are stored independently: confirmed legacy export profiles use separate values, so equality is not a valid compatibility requirement. Compilation rejects nonzero DAT sprite references that exceed the SPR sprite count before returning the three output files. The browser client communicates with a loopback-only Node HTTP server. Select one directory containing a single project; the browser locates the DAT/SPR pair (preferring a shared filename stem) and an optional matching OTFI, then uploads files sequentially. Client version `0` infers a minimum schema version from OTFI (`frame-groups` => 10.57, `frame-durations` => 10.50, `extended` => 9.60); without OTFI it falls back to 7.72. Set the exact client version explicitly when known. This inference cannot make unsupported flag payloads safe to parse. The per-file HTTP, DAT and SPR size limit is 2 GiB. Uploads and parsed documents are held in memory, so large assets require sufficient available memory; originals are never overwritten.

The supplied `30_09_26` asset set opened in automatic mode as version 10.57 (39,264 items, 7,026 outfits, 1,617 effects, 156 missiles and 430,719 sprites). A DAT pickupable-flag edit compiled successfully while preserving the original SPR bytes exactly. This is a smoke test for that specific set, not a general claim of compatibility with every 10.57 client.

SPR parsing accepts the format's three-byte per-sprite color-key field without assuming a fixed marker value. SPR edits use fixed-size RGBA images (sprite dimension from OTFI), bounded input sizes, RGB/RGBA RLE encoding, and stable IDs when removing entries (removed entries become empty). Modified SPR files are canonically serialized; byte-identical round-trip is not promised after edits.

## OBD v2 (Object Builder Data)

LZMA-alone stream, little-endian payload: `u16 version(200)`, `u16 clientVersion`, `u8 category` (1 item, 2 outfit, 3 effect, 4 missile), `u32 patternsOffset`, flags (OBD codes, ended by `0xFF`), frame group layout (width, height, exactSize if >1, layers, patternX/Y/Z, frames, animation block when frames>1), then per sprite `u32 id` + 4096 bytes ARGB. Implemented in `src/formats/obd.ts`; imports always append a new record.

## TypeScript mapping (initial)

```ts
interface OtbHeader {
  identifier: Buffer;
  majorVersion?: number;
  minorVersion?: number;
  buildNumber?: number;
}

interface OtbItem {
  group: number;
  flags: number;
  attributes: Array<{ type: number; payload: Buffer }>;
  serverId?: number;
  clientId?: number;
  name?: string;
}
```

The concrete implementation also retains raw binary node data and duplicate/unknown attributes; the sketch omits those preservation details for readability.
