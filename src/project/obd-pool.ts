import { Buffer } from "node:buffer";
import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { compressObd, OBD_COMPRESSION_LEVEL } from "../formats/obd.js";

const requireLzma = require.resolve("lzma");

// Plain CommonJS so it runs unchanged under tsx, compiled dist and tests.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const LZMA = require(${JSON.stringify(requireLzma)});
parentPort.on("message", ({ id, raw, level }) => {
  try {
    const out = LZMA.compress(raw, level);
    const bytes = new Uint8Array(Int8Array.from(out).buffer);
    parentPort.postMessage({ id, data: bytes }, [bytes.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

interface Job {
  readonly id: number;
  readonly raw: Buffer;
  readonly level: number;
  readonly resolve: (data: Buffer) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  onAbort?: () => void;
}

interface Slot {
  readonly worker: Worker;
  job: Job | undefined;
}

export class AbortedError extends Error {
  constructor() {
    super("OBD compression aborted");
    this.name = "AbortedError";
  }
}

/** Runs the blocking pure-JS LZMA compression off the main thread. */
export class ObdWorkerPool {
  readonly #size: number;
  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  #nextId = 1;
  #closed = false;

  constructor(size = Math.max(1, Math.min(4, cpus().length - 1))) {
    this.#size = size;
  }

  get size(): number {
    return this.#size;
  }

  compress(raw: Buffer, signal?: AbortSignal, level = OBD_COMPRESSION_LEVEL): Promise<Buffer> {
    if (this.#closed) return Promise.reject(new Error("OBD pool is closed"));
    if (signal?.aborted === true) return Promise.reject(new AbortedError());
    return new Promise<Buffer>((resolve, reject) => {
      const job: Job = { id: this.#nextId++, raw, level, resolve, reject, signal };
      if (signal !== undefined) {
        job.onAbort = (): void => this.#abort(job);
        signal.addEventListener("abort", job.onAbort, { once: true });
      }
      this.#queue.push(job);
      this.#pump();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) this.#finish(job, new Error("OBD pool is closed"));
    await Promise.all(this.#slots.splice(0).map(async (slot) => {
      if (slot.job !== undefined) this.#finish(slot.job, new Error("OBD pool is closed"));
      await slot.worker.terminate();
    }));
  }

  #finish(job: Job, error: Error | undefined, data?: Buffer): void {
    if (job.onAbort !== undefined) job.signal?.removeEventListener("abort", job.onAbort);
    if (error !== undefined) job.reject(error);
    else job.resolve(data ?? Buffer.alloc(0));
  }

  #abort(job: Job): void {
    const queued = this.#queue.indexOf(job);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      this.#finish(job, new AbortedError());
      return;
    }
    const slot = this.#slots.find((candidate) => candidate.job === job);
    if (slot === undefined) return;
    // A running LZMA cannot be interrupted; discard the worker and replace it lazily.
    slot.job = undefined;
    this.#slots.splice(this.#slots.indexOf(slot), 1);
    void slot.worker.terminate();
    this.#finish(job, new AbortedError());
    this.#pump();
  }

  #spawn(): Slot {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    const slot: Slot = { worker, job: undefined };
    worker.on("message", (message: { id: number; data?: Uint8Array; error?: string }) => {
      const job = slot.job;
      if (job === undefined || job.id !== message.id) return;
      slot.job = undefined;
      worker.unref();
      if (message.error !== undefined) this.#finish(job, new Error(message.error));
      else this.#finish(job, undefined, Buffer.from(message.data ?? new Uint8Array()));
      this.#pump();
    });
    const fail = (error: Error): void => {
      const job = slot.job;
      slot.job = undefined;
      const index = this.#slots.indexOf(slot);
      if (index >= 0) this.#slots.splice(index, 1);
      if (job !== undefined) {
        // Fall back to in-thread compression so a broken worker never loses an export.
        try {
          this.#finish(job, undefined, compressObd(job.raw, job.level));
        } catch (fallbackError) {
          this.#finish(job, fallbackError instanceof Error ? fallbackError : error);
        }
      }
      this.#pump();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (slot.job !== undefined) fail(new Error(`OBD worker exited with code ${code}`));
    });
    worker.unref();
    this.#slots.push(slot);
    return slot;
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      let slot = this.#slots.find((candidate) => candidate.job === undefined);
      if (slot === undefined && this.#slots.length < this.#size) slot = this.#spawn();
      if (slot === undefined) return;
      const job = this.#queue.shift();
      if (job === undefined) return;
      slot.job = job;
      slot.worker.ref();
      slot.worker.postMessage({ id: job.id, raw: new Uint8Array(job.raw), level: job.level });
    }
  }
}
