# OTEditor TypeScript

An independent Node.js + TypeScript implementation for Open Tibia assets, with a local browser editor for the DAT+SPR+OTFI workflow. The editor opens or creates projects, edits the supported DAT properties and sprite references, previews/replaces/adds sprites, and validates/compiles output files for download.

## Status

- Implemented: strict TypeScript setup; OTFI parsing and creation; initial version-aware DAT parsing for all four categories and supported property edits; SPR read/edit/write; coordinated project open/create/compile; local HTTP API and browser UI; OTB reader/writer and CLI.
- Supported editor operations: browse/create/remove DAT records, edit recognized properties and flags, edit sprite references, preview/replace/add sprites, and compile/download the DAT+SPR+OTFI triplet.
- Not implemented: complete client-version and DAT flag coverage, preservation/editing of unknown DAT flags, image import beyond exact-size raster files, undo/history, OBD, `items.xml`, OTBM, updater and AI service.
- No real proprietary client files are included. See [the original audit](./docs/original-audit.md), [Assets-Editor review](./docs/assets-editor-review.md), [format notes](./docs/formats.md), [compatibility evidence](./docs/compatibility.md), [architecture](./docs/architecture.md), [performance notes](./docs/performance.md), and [implementation plan](./IMPLEMENTATION_PLAN.md).

## Run with Docker

Docker Engine and Compose plugin are required. The commands below run Node inside Docker; Node/npm do not need to be installed on the host. Build from the project root:

```bash
docker build -t oteditor-ts .
docker run --rm oteditor-ts npm run typecheck
docker run --rm oteditor-ts npm test
docker run --rm oteditor-ts npm run lint
docker run --rm oteditor-ts npm run build
```

Run the browser editor from the project root with:

```bash
npm run dev
```

The project npm proxy sends this command to Docker, so host Node.js is not needed. It builds the image, uses `http://127.0.0.1:4173` when available, or chooses and prints another localhost port if 4173 is occupied, and stops the container when you press Ctrl+C. Open the exact URL printed by the command. Select a folder containing one DAT/SPR/OTFI set, then click **Abrir pasta selecionada**. Leave client version at `0` to infer a minimum version from OTFI (`frame-groups` => 10.57, `frame-durations` => 10.50, `extended` => 9.60); without OTFI the fallback is 7.72. Enter the exact version manually if known. OTFI is optional. Uploads are sent one at a time and held in memory, with a 2 GiB per-file limit. Increase Docker memory appropriately for large SPR files. Source files are never overwritten. Supported format operations and explicit limits are documented in [format notes](./docs/formats.md).

To launch the same editor without the npm wrapper, use:

```bash
docker run --rm -p 127.0.0.1:4173:4173 -e HOST=0.0.0.0 -e PORT=4173 oteditor-ts npm run start
```

To run the CLI's development command in Docker, mount the project directory and data directory:

```bash
docker run --rm -v "$PWD/data:/data" oteditor-ts npm run dev:cli -- inspect /data/items.otb
docker run --rm -v "$PWD/data:/data" oteditor-ts npm run dev:cli -- roundtrip /data/items.otb /data/items-copy.otb
docker run --rm -v "$PWD/data:/data" oteditor-ts npm run dev:cli -- set /data/items.otb /data/items-edited.otb 100 name "Example item"
```

The CLI refuses an existing output and refuses to overwrite its input. `set` addresses an item by its server ID and accepts the writable fields shown by `npm run dev:cli -- help`. The data directory must exist on the host, and be writable if the command creates output files.

## Local development (with Node.js installed)

```bash
npm ci
npm run dev -- help
npm test
npm run typecheck
npm run lint
npm run build
npm run dev:web
```

## Compatibility and licensing

OTB support is intentionally not advertised as complete: real external corpora and application-consumer tests have not been run here. The original OTEditor clone has no root-level license file. This implementation does not copy original code or assets; confirm licensing before distributing a derivative project.

### Conjuntos sem OTFI

Com a versão em automático e sem OTFI, o editor detecta o layout do SPR (contagem de 16/32 bits, pixels RGB/RGBA) e testa as versões de DAT 1100, 1057, 1050, 1010, 960, 860, 780 e 772 até uma abrir por completo. Validado com `Archlight_2026`: versão 1100, SPR estendido com alpha. O OTFI gerado é incluído na compilação.

## OTFI inconsistente com o SPR

Se o OTFI declara `transparency` de forma contrária aos pixels reais do SPR (ex.: `transparency: false` com sprites RGBA, como em alguns conjuntos Object Builder), o editor tenta o formato oposto, usa o que parseia, exibe um aviso e corrige o OTFI na compilação.

## Sprites: importação e exportação

Botão direito em sprites: exportar PNG/ZIP, importar imagens ou spritesheets (sempre anexa novas sprites; limites de 50 arquivos, 32 MiB e 8192×8192 px por arquivo). Spritesheets também podem ser importadas por arrastar e soltar.

### OBD (Object Builder Data)

- **Seleção múltipla de registros:** Ctrl/⌘+clique, Shift+clique (intervalo), Ctrl+A sobre a grade; Esc limpa. Com seleção ativa, o clique simples apenas alterna a seleção.
- **Exportar:** botão direito nos registros → "Exportar .obd" (1 arquivo) ou ZIP com um `.obd` por objeto.
- **Importar:** somente arrastando e soltando arquivos `.obd` na janela. Cada arquivo cria um **novo** registro (nunca sobrescreve) e anexa as sprites ao SPR.
- Formato: OBD v2 (LZMA, pixels ARGB 32×32). Limitações: OBD v1 não é suportado; só um grupo de frames (outfits com vários grupos exportam o grupo 0, com aviso); sem bones/npcSaleData/changer/podium; a versão do cliente gravada é a inferida do projeto; flags não suportadas pela versão do projeto são ignoradas com aviso.
