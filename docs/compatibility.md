# Compatibility and integrity

## Evidence so far

- Original repository snapshot: commit `1aab0513c63e1248b4cea0226ffc6e56fd6347f4`, tag `1.0`.
- Additional reference snapshot: Arch-Mina/Assets-Editor commit `d673c33899b48641f44b7494df7ee29824dee502`; its profile guide describes separate 8.60, 10.98 and client 11/15.x legacy-export contracts and post-write DAT validation.
- Original OTB compatibility report: 37 external files / 765,403 records / major versions 1–3, as recorded by the source repository. Those files are not in this workspace.
- New implementation: synthetic OTB node fixtures exercise escaping, unknown attribute retention, root version reading, strict malformed-file rejection, no-change binary identity and edited semantic re-opening.
- New implementation: synthetic DAT fixtures exercise recognized property edits, signed offsets, classic and extended sprite IDs, OTFI frame-group layout, exact no-change output, record create/remove and malformed/version-mismatched input rejection.
- New implementation: synthetic SPR fixtures exercise RGB/RGBA RLE, alpha, extended counts, image operations, stable sprite IDs and malformed inputs.
- New implementation: project integration fixtures open, edit, compile and reopen all three files, checking signatures and dangling sprite references.
- New implementation: HTTP integration test exercises the local UI route, record creation, property editing, compile and downloads for DAT, SPR and OTFI.
- New implementation: OTFI fixtures exercise exact no-change preservation, unknown setting/section retention, new-project generation, unsafe path rejection and invalid boolean rejection.
- Real client/server corpus comparison: **not run**. No proprietary or third-party client files are bundled.
- TFS, RME and ObjectBuilder loading of generated files: **not tested**.
- DAT/SPR/OTFI coverage remains synthetic; client-version coverage and consumer compatibility are not established.

## Integrity behavior

An unchanged OTB document serializes to an exact copy of the original input. A changed document preserves root bytes, item group/flag fields except for explicitly edited fields, and opaque attributes in their original order. The serializer may normalize escaped marker bytes in changed output. Inputs are never overwritten by test commands or CLI write commands; outputs must be new paths.

No claim of full Open Tibia compatibility is made. Current DAT parsing rejects unknown flags rather than guessing their payload lengths. The error includes the raw flag, canonical flag, record category/ID, byte offset and selected client version so version/layout mismatches can be diagnosed. Unknown variants and future formats require real, legally supplied fixtures and comparison against their intended consumers.

The web workflow holds selected files in process memory and does not write over source files. Compile reopens the generated DAT and SPR, validates signatures and every nonzero sprite reference, then exposes the DAT, SPR and OTFI outputs for separate download.
