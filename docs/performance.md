# Performance notes

No performance benchmark has been run yet. There are no representative OTB corpus files in the original clone, so a throughput or memory target would be speculative.

The initial OTB parser accepts a configurable maximum file size (default 512 MiB), limits node count and nesting, uses `Buffer` for payloads, and preserves the input for exact no-change output. Parsing necessarily materializes node data as well as the source buffer; peak memory can therefore exceed input size. This is documented rather than hidden.

Before broadening limits or adding workers/caches, benchmark OTB parsing/serialization with legally supplied small, medium and large corpora. DAT/SPR performance work should account for the original's memory-mapped SPR reads and 8/32 MiB LRU budgets.

## Exportação de outfits `.obd`

**Causa raiz (medida):** o OBD v2 exige LZMA e o encoder usado (`lzma`, JavaScript puro) é síncrono. Em `GET /api/project/obd` ele rodava no event loop do servidor, bloqueando também miniaturas e demais requisições. Montar o payload (RGBA→ARGB) custa < 2% do tempo; a compressão custa > 98%.

**Correções:** nível LZMA 1 (`OBD_COMPRESSION_LEVEL`), compressão em um pool de `worker_threads` (`src/project/obd-pool.ts`, até `min(4, CPUs-1)` workers, fila, cancelamento ao fechar a conexão, fallback síncrono se um worker falhar), cabeçalho `Server-Timing` (build/compress) e, no cliente, 4 requisições simultâneas com progresso real, botão Cancelar e bloqueio de exportações duplicadas. O formato do arquivo não mudou.

**Benchmark** (`tests/bench/obd-bench.ts`; outfits reais de um cliente 8.54 com SPR de 857 MB; Docker, 8 CPUs; uma execução por cenário, valores variam entre execuções):

| Cenário | Antes (nível 5, síncrono) | Nível 1, síncrono | Nível 1 + pool de 4 |
|---|---|---|---|
| 1 outfit, 4 sprites | 0,19–0,23 s | 0,05 s | 0,10 s |
| 1 outfit, 16 sprites | 1,8–2,0 s | 0,3–0,4 s | 0,28 s |
| 1 outfit, 720 sprites | 19,7–21,6 s | 4,1 s | 3,6 s |
| Lote de 36 outfits (576 sprites) | 48,6–51,5 s | 6,4–7,3 s | 3,5–4,2 s |

O nível 1 gera arquivos maiores em outfits grandes (46 KB contra 27 KB no de 720 sprites). Com o pool, o servidor permanece responsivo durante a exportação. Um único outfit enorme continua limitado pela velocidade do LZMA em JS. A descompressão na importação (`decodeObd`) ainda é síncrona.
