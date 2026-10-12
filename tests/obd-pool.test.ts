import assert from "node:assert/strict";
import { test } from "node:test";
import { compressObd, decodeObd } from "../src/formats/obd.js";
import { AbortedError, ObdWorkerPool } from "../src/project/obd-pool.js";

function sample(seed: number): Buffer {
  const raw = Buffer.alloc(40_000);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * seed) % 251;
  return raw;
}

test("pool output equals synchronous compression and handles many jobs", async () => {
  const pool = new ObdWorkerPool(2);
  try {
    const inputs = [1, 2, 3, 4, 5].map(sample);
    const results = await Promise.all(inputs.map((raw) => pool.compress(raw)));
    results.forEach((result, index) => assert.deepEqual(result, compressObd(inputs[index]!)));
  } finally {
    await pool.close();
  }
});

test("pool cancels queued and running jobs without breaking later ones", async () => {
  const pool = new ObdWorkerPool(1);
  try {
    const controller = new AbortController();
    const running = pool.compress(sample(7), controller.signal);
    const queued = pool.compress(sample(8), controller.signal);
    controller.abort();
    await assert.rejects(running, AbortedError);
    await assert.rejects(queued, AbortedError);
    await assert.rejects(pool.compress(sample(9), controller.signal), AbortedError);
    assert.deepEqual(await pool.compress(sample(10)), compressObd(sample(10)));
  } finally {
    await pool.close();
  }
});

test("closed pool rejects new work", async () => {
  const pool = new ObdWorkerPool(1);
  await pool.close();
  await assert.rejects(pool.compress(sample(1)));
});

test("decodeObd is exported for round trips", () => {
  assert.equal(typeof decodeObd, "function");
});
