# OTEditor original repository audit

## Scope and evidence

The original repository was cloned from `https://github.com/dewral/OTEditor` and inspected at commit `1aab0513c63e1248b4cea0226ffc6e56fd6347f4` (2026-10-07, tag `1.0`). The working tree was clean. The clone contains C++/Qt/QML source, tests, build/release scripts, UI assets, and compatibility notes; it contains no `.dat`, `.spr`, `.otb`, `.otbm`, or `.obd` client/server data fixtures. The test suite optionally reads external OTB, OBD, and client-data corpora through environment variables.

Findings below distinguish source-confirmed behavior from gaps. The audit is based on repository content; it is not a claim that every external Open Tibia variant or every UI path has been exhaustively exercised.

## Architecture and startup

- **Application:** a Windows desktop editor using Qt 6.5+, Qt Quick/QML, C++20, and CMake 3.24+. The root build defines `otformats`, `editorcore`, and `aispritecore` libraries and a QML executable (`CMakeLists.txt`).
- **Entry point:** `src/main.cpp` creates the Qt application, `EditorBackend`, update and AI-sprite services, registers an image provider/context properties, parses launch options, and loads `OTEditor.Main`.
- **Presentation:** `qml/Main.qml` wires menus, dialogs, browser panels, inspector, selection, import/export, project operations, server tools, and preferences to `EditorBackend`. Dedicated QML dialogs cover animation, pixel editing, slicing, object imports, and conversions.
- **Application model:** `src/editorbackend.{h,cpp}` owns selection, categories, object editing, undo/redo, image import/export, filtering and dispatch; `src/projectmodel.{h,cpp}` opens and compiles client/server files and tracks dirty state.
- **Formats:** `libs/otformats/` contains independent readers/writers for DAT, SPR, OTB, OTBM, OTFI and `items.xml`, plus binary/node helpers. `src/obdcodec.*` handles ObjectBuilder OBD compression and payloads.
- **External services:** `src/updateservice.*` accesses GitHub releases and launches a Windows updater; `src/aispriteservice.*` sends generation requests to AI Sprite Studio. These are optional application integrations, not local format dependencies.
- **Build dependencies:** Qt Core/Gui/Qml/Quick/QuickControls2/Network/Widgets/Test, CMake, Ninja/compiler, and liblzma (for OBD). Release automation installs Qt and liblzma and packages Windows x64.
- **Memory approach:** the general `BinaryReader` buffers complete files. SPR instead memory-maps its source during bulk access and uses bounded LRU caches (8 MiB sprite cache, 32 MiB composite-image cache). DAT records and OTB attributes retain raw data for preservation. OTBM holds parsed tiles and spatial indexing in memory.
- **Error handling:** format classes expose error strings and mostly validate file lengths before reads; writes use `QSaveFile`. The OTBM node reader caps nesting at 512. The OBD decoder caps output at 128 MiB and uses a 256 MiB LZMA memory limit. The source also includes parsers with format-specific validation; coverage is not uniform.

## Feature inventory

Priority describes the proposed TypeScript roadmap, not a claim that the original offers the feature at a specific quality level. “Observed” entries are confirmed by the named source; requirements with missing data are marked for investigation.

| Priority | Original source | Observed behavior | Main dependency | TypeScript strategy |
|---|---|---|---|---|
| **Required** | `src/projectmodel.cpp`, `libs/otformats/datreader.*`, `sprreader.*`, `src/editorbackend.cpp` | Open a client asset folder by resolving DAT/SPR names, infer legacy feature switches from client version or OTFI, read client categories and sprites, and report errors. | DAT/SPR binaries; selected client version | Implement parsers independently in `packages/formats`; use bounded reads and explicit version profiles. |
| **Required** | `src/editorbackend.cpp`, `qml/ObjectsBrowserPanel.qml`, `qml/ItemInspector.qml` | Browse item/outfit/effect/missile categories; filter, jump/select, view properties and sprite-derived previews; edit properties and sprite IDs. | DAT model, SPR decoder, QML | Keep the model/UI separate; first provide tested format/model APIs, then a real UI over those APIs. |
| **Required** | `libs/otformats/datreader.cpp`, `sprreader.cpp`, `src/projectmodel.cpp` | Compile edited DAT/SPR; preserve unmodified records/flags and use atomic file writes. | DAT/SPR writer | Preserve opaque fields and use temp files/atomic rename; never overwrite sources in compatibility tests. |
| **Required** | `libs/otformats/otbreader.*`, `src/projectmodel.cpp` | Optional server item mapping, groups, flags and known attributes; raw attribute payloads survive save; server IDs map to client IDs. | OTB node format, optionally DAT | Implement loss-aware OTB parse/serialize first and test byte and semantic round trips. |
| **Important** | `libs/otformats/otfireader.*`, `src/projectmodel.cpp` | Read the first `.otfi`; `DatSpr` keys select filenames, extended/transparency/durations/groups and sprite size; values override version defaults. | OTFI text | Preserve unknown lines/keys while parsing supported settings; add explicit version profiles. |
| **Important** | `libs/otformats/itemsxmlreader.*` | Read item names, ID ranges, direct attributes and child `<attribute key value>` entries; update names/attributes while streaming the source XML. | `items.xml` | Use a safe XML parser and preserve unmodified entries/attributes; handle ranges and duplicate IDs explicitly. |
| **Important** | `src/obdcodec.*`, `src/editorbackend_obd.cpp` | Import OBD v1/v2 and export v3; data is LZMA-Alone compressed and includes object properties and 32×32 RGBA sprite data. | liblzma / OBD variants | Add only with versioned fixtures, decompressed-size bounds, and round-trip tests; no client assets bundled. |
| **Important** | `src/editorbackend_slicer.cpp`, `editorbackend_sheet.cpp`, `editorbackend_export.cpp`, `qml/SlicerWindow.qml` | Slice sprite sheets; rotate/mirror/zoom; import/drop graphics; export individual objects, sheets and sprites as image files. | Image codecs and SPR | Build reusable image/sprite services; compare slot ordering to source tests before UI integration. |
| **Important** | `src/editorbackend.cpp`, `editorbackend_convert.cpp`, `editorbackend_merge.cpp`, `qml/AnimationEditorDialog.qml` | Create/duplicate/remove objects; undo/redo; animation/frame-group/duration operations; project conversion/merge and bulk operations. | DAT model and compatibility rules | Implement as model operations with transactional edits and fixtures per supported client profile. |
| **Future** | `libs/otformats/otbmreader.*` | OTBM map, tile/item, town/waypoint, spawn/house and map undo code exists. Repository search found no application or QML reference to `OtbmReader`; it is not part of the discovered main editing flow. | OTBM plus sidecar spawn/house XML | Treat as dormant format code; inspect and test independently before promising map editing. |
| **Future** | `src/aispriteservice.*`, `qml/AiSpriteGeneratorDialog.qml` | Optional AI generation through a user-supplied API key and remote provider; generated images do not automatically create objects. | Network/provider account/credits | Keep out of core; any future adapter must protect credentials and require explicit user action. |
| **Future** | `src/updateservice.*`, `src/updater/main.cpp`, `.github/workflows/release.yml` | Checks GitHub stable releases, verifies a SHA-256 archive, and installs/restarts a Windows application. | GitHub and Windows updater | Distribution concern; omit from reusable format core. |

## Tests, history and known gaps

- Existing tests cover UI/backend edits, DAT and SPR writer behavior, OTB operations, OBD variants, project conversion, and QML workflows (`tests/editor_tests.cpp`, `tests/ai_sprite_tests.cpp`).
- The OTB compatibility report says its external corpus covered 37 files and 765,403 records across major versions 1–3. The report explicitly says the files were external, direct load in TFS/RME/ObjectBuilder was not tested, and binary identity was not required.
- `realOtbCompatibility` skips unless `OTE_TEST_OTB_FILES` is set. OBD and real-client checks likewise rely on external paths; the clone has no corresponding binary fixtures. This implementation therefore cannot truthfully claim original-corpus parity in this environment.
- History includes the original format-parser introduction (`eb703b2`), project editing and later OTB/animation/export features; current release tag `1.0` points at the inspected main snapshot.
- No root-level project license file was found. `assets/ObjectBuilder-LICENSE.txt` is an MIT notice for ObjectBuilder metadata, not a license grant for OTEditor code or the bundled UI/graphics. No original source/assets are copied into this implementation. Confirm OTEditor licensing with its maintainers before distributing a derivative or reusing its code/assets.
- Original client graphics are explicitly not included in its releases. No copyrighted client assets are included here.
- Confirmed but not yet investigated to compatibility level: exact supported DAT client-version ranges, all legacy OBD v1/v2 corner cases, every OTBM fork/version, provider API behavior and all server `items.xml` dialects.

## Priority clarification

The first user clarification prioritizes opening DAT/SPR/OTFI projects, editing and creating objects/sprites, and compiling a new DAT/SPR/OTFI set. The requested interface is a browser UI. The OTB core already implemented in this workspace remains secondary and should not displace the client-project workflow. The user also supplied `Arch-Mina/Assets-Editor`; its review and project-specific findings are in [`assets-editor-review.md`](./assets-editor-review.md).

The next vertical slice is therefore the classic client project lifecycle, served by a local Node process and a browser UI. No remote upload is required. It should begin with a true empty-project creation path and a user-selected version/OTFI configuration, then open/edit/compile. Real client corpus validation remains blocked on user-provided legally usable files.
