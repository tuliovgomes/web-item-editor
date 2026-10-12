# Review of Arch-Mina/Assets-Editor

## Snapshot and licensing

The repository was cloned from `https://github.com/Arch-Mina/Assets-Editor` at commit `d673c33899b48641f44b7494df7ee29824dee502` (2026-07-10). The current main branch describes Assets Editor V2 and targets `net10.0-windows` with WPF. No root `LICENSE` or `COPYING` file was found. Its documentation and code are used here as behavioral evidence only: this implementation does not copy its code, UI, resources, or data definitions. Obtain licensing permission before redistributing its source or assets.

## Architecture and relevant features

- `Assets Editor/DatEditor.xaml.cs` and `DatStructure.cs` implement a WPF editor for appearances, with version-dependent DAT structures and protobuf-backed modern asset definitions.
- `ModernAssetSet.cs` reads `catalog-content.json`, a protobuf appearances file, and compressed sprite sheets; it can slice modern sheet images into individual sprites.
- `LegacyAssetExporter.cs` maps modern appearances/sprites into legacy DAT/SPR outputs, and `LegacyDatValidator.cs` reparses the generated DAT to check parser alignment, supported attributes, animation/frame-group structure and sprite references.
- `LegacyAssetExportProfile.cs` defines explicit client contracts. Documented profiles include CipSoft 8.60 with extended u32 sprite IDs (but no unsupported modern DAT flags), legacy 10.98, and client 11/15.x (including a 29-character Market-name cap).
- The command line offers `export-legacy` and `validate-legacy`; the UI provides object editing, copy/create/delete, import/export, sheet editing, OTB tools and Lua scripting.
- The legacy export guide documents an optional `itemFlag.otml` sidecar for flags that legacy DAT cannot express. It is not part of the core DAT/SPR/OTFI triple.
- The repository describes modern assets as Tibia 12+ and Tibia 10.98 capable; legacy export is a separate transform, not direct editing of arbitrary classic DAT/SPR/OTFI folders.
- No test project or real client fixtures were found in the cloned tree; the legacy export guide describes validation commands but does not supply redistributable client corpora.

## How it affects this implementation

1. Prioritize native project flow from OTEditor: select a DAT/SPR/optional OTFI set, resolve OTFI before parsing version-dependent binary records, edit real object/sprite data, and compile DAT/SPR/OTFI together.
2. Treat format profile as explicit project metadata. A modern client export profile is not interchangeable with a legacy DAT file's own structure settings.
3. Reparse the generated DAT and SPR before exposing compiled output; validate counts, animation/frame data, sprite references, signatures and offsets.
4. Preserve unmodified binary records/sprite blocks and unknown fields. When a target profile cannot encode a value, report that incompatibility rather than silently dropping it.
5. Keep modern appearances protobuf and legacy export as a later optional adapter. The current priority is editing classic DAT/SPR/OTFI projects, not converting modern Tibia assets.
