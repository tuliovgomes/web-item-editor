# Implementation plan

## Completed

- [x] Audit OTEditor and Assets-Editor references; document confirmed architecture, formats, limits, licensing and evidence gaps.
- [x] Configure a strict Node.js + TypeScript foundation and Docker workflow.
- [x] Implement OTB inspection/editing as secondary scope.
- [x] Implement OTFI settings parsing, source-preserving edits and new-project generation.
- [x] Implement initial DAT parsing, recognized property/flag edits, sprite-reference edits, record create/remove and synthetic round-trip tests.
- [x] Implement SPR parsing/encoding, RGBA preview data, replacement/add/removal and synthetic malformed-input tests.
- [x] Implement coordinated DAT+SPR+OTFI open/create/compile with output re-open and sprite-reference validation.
- [x] Implement local HTTP API and browser UI for project editing, image sprite operations and compile/download.
- [x] Add API integration coverage for serving the UI, DAT editing and downloading all three compiled files.
- [x] Verify typecheck, lint, 31 unit/integration tests and production build in Docker.

## Pending / limitations

- Obtain legally supplied real DAT/SPR/OTFI fixtures and run differential tests against relevant client/server consumers before claiming version-specific compatibility.
- Expand DAT flag/property support and version schemas; unknown flags are rejected rather than guessed.
- Verify image editing against additional sprite dimensions, transparency settings and real SPR consumers.
- Add browser-based visual automation and user-provided corpus testing.
- Expand OTB against real corpora; investigate OBD, `items.xml` and OTBM only after the primary DAT/SPR/OTFI workflow.
- Add representative performance benchmarks and measure peak memory on large real projects.

## Decisions

- The user selected a browser UI; the Node server should run locally so client files remain on the user's machine.
- DAT/SPR/OTFI project lifecycle now takes priority. The existing OTB CLI is retained as secondary scope.
- The browser editor is local-only and has no persistence/undo; source files are never overwritten.
- Every write operation must preserve source files until a validated output set has been produced.
- Docker is the execution environment for dependency installation, type-check, tests and build.
- Original OTEditor code/assets are not copied: the repository has no root license grant. ObjectBuilder metadata's included MIT notice does not license OTEditor code.

## Acceptance criteria for this increment

- Existing OTB increment: strict type-check, lint, production build and 9 synthetic/CLI tests pass in Docker; npm audit reported 0 vulnerabilities.
- Current validation is synthetic; compatibility with real client assets and client/server consumers remains unverified.
- Documentation identifies the unsupported formats/UI and lack of real-corpus validation.
