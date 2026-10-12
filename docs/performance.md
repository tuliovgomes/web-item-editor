# Performance notes

No performance benchmark has been run yet. There are no representative OTB corpus files in the original clone, so a throughput or memory target would be speculative.

The initial OTB parser accepts a configurable maximum file size (default 512 MiB), limits node count and nesting, uses `Buffer` for payloads, and preserves the input for exact no-change output. Parsing necessarily materializes node data as well as the source buffer; peak memory can therefore exceed input size. This is documented rather than hidden.

Before broadening limits or adding workers/caches, benchmark OTB parsing/serialization with legally supplied small, medium and large corpora. DAT/SPR performance work should account for the original's memory-mapped SPR reads and 8/32 MiB LRU budgets.
