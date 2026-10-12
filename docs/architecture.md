# Architecture

## Implemented core increments

```text
src/
  formats/dat.ts       Version-aware DAT reader, property editor and serializer
  formats/spr.ts       SPR index/RLE parser, image codec and serializer
  formats/otfi.ts      OTFI settings reader, source-preserving writer and project config creator
  formats/otb.ts       OTB binary parser, model, guarded mutations and serializer
  project/project.ts   DAT+SPR+OTFI orchestration and compile validation
  server.ts            Loopback HTTP API and static UI server
  cli.ts               inspect, roundtrip and set-field commands
web/
  index.html app.css app.js   Browser UI for local asset editing
tests/
  *.test.ts            Synthetic format and project/API integration tests
```

- **Runtime:** Node.js 24 in the supplied Docker image.
- **Language:** TypeScript strict mode with unchecked-index and exact-optional-property checks.
- **Core boundary:** format models contain no CLI or filesystem dependencies; callers provide binary/text inputs and receive typed documents or explicit format errors.
- **CLI:** thin filesystem adapter. Read-only inspect never writes. Roundtrip/edit operations write only to a new output path and reject the input path or any already-existing output.
- **Dependencies:** runtime uses only Node built-ins. TypeScript, tsx and Node type declarations are development dependencies.
- **Failure contract:** malformed headers, unsupported version-specific DAT flags, truncated records, invalid dimensions, OTB node structure, attributes and configured size limits throw format-specific errors. No partial parse is returned.
- **DAT preservation boundary:** unchanged input returns its original bytes. Recognized flags/payloads and sprite references can be edited; unknown DAT flags are rejected because their payload lengths cannot safely be inferred. Signed 16-bit offsets are interpreted as signed values.
- **SPR preservation boundary:** sprites are decoded to RGBA and canonically encoded on changes. Legacy/extended IDs and RGB/RGBA payload modes are supported; opaque bytes inside modified sprite payloads are not preserved.
- **OTFI preservation boundary:** no-change save returns exact source text; changed saves update the selected setting while retaining unknown lines and sections. Boolean settings accept only `true`/`false`.
- **OTB preservation boundary:** raw root payload, group/flags and ordered attribute payloads survive parse/serialize. A no-change document returns the original bytes exactly; a changed document is canonically re-escaped.

## Intended evolution

Keep parsers in `src/formats/`, with file-independent data models and no GUI dependencies. Complete version-aware DAT behavior and implement the SPR reader/writer before building project orchestration. Keep commands in `src/cli.ts`. A desktop or web UI must call the same tested core and must not own format rules. Add packages only when independent ownership or build requirements justify them; the original workflow does not currently justify an artificial monorepo.

The OTB CLI is an implemented secondary tool. The local browser UI invokes the same project/core APIs over loopback; files remain in memory and compiled outputs are re-opened before download. The editor currently does not persist projects or offer undo/history. See `IMPLEMENTATION_PLAN.md` for remaining compatibility and performance work.
