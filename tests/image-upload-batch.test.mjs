import assert from "node:assert/strict";
import test from "node:test";
import { runImageUploadBatch } from "../src/core/image-upload-batch.ts";
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("image batch overlaps two transfers and starts each asset exactly once", async () => {
  const gates = Array.from({ length: 5 }, gate);
  const started = [], finished = [];
  let active = 0, peak = 0;
  const pending = runImageUploadBatch([0, 1, 2, 3, 4], async value => {
    started.push(value); active++; peak = Math.max(peak, active);
    await gates[value].promise; active--; finished.push(value);
  });
  await flush(); assert.deepEqual(started, [0, 1]);
  gates[1].resolve(); await flush(); assert.deepEqual(started, [0, 1, 2]);
  gates[0].resolve(); await flush(); assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2].resolve(); gates[3].resolve(); await flush(); gates[4].resolve();
  await pending;
  assert.equal(peak, 2); assert.deepEqual([...finished].sort(), [0, 1, 2, 3, 4]);
});

test("batch stops new scheduling on failure, preserves first error and settles started success", async () => {
  const running = gate(), started = [], finished = [];
  const failure = new Error("transfer failed");
  let settled = false;
  const pending = runImageUploadBatch([0, 1, 2, 3], async value => {
    started.push(value); if (value === 1) throw failure;
    await running.promise; finished.push(value);
  });
  const observed = pending.catch(error => { settled = true; return error; });
  await flush(); assert.deepEqual(started, [0, 1]); assert.equal(settled, false);
  running.resolve(); assert.equal(await observed, failure);
  assert.deepEqual(finished, [0]); assert.deepEqual(started, [0, 1]);
});

test("legacy uploads remain sequential and the pool never exceeds two", async () => {
  for (const concurrency of [1, 100]) {
    let active = 0, peak = 0;
    await runImageUploadBatch([1, 2, 3], async () => {
      active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
    }, concurrency);
    assert.equal(peak, Math.min(concurrency, 2));
  }
  await runImageUploadBatch([], async () => { throw new Error("must not run"); });
});


test("eight direct transfers advance while server processing remains pending, and completion still waits for all photos", async () => {
  const transfers = Array.from({ length: 8 }, gate);
  const ready = Array.from({ length: 8 }, gate);
  const started = [], finished = [];
  let network = 0, peak = 0, settled = false;
  const pending = runImageUploadBatch([...Array(8).keys()], async (index, _position, transferred) => {
    started.push(index); network++; peak = Math.max(peak, network);
    await transfers[index].promise;
    network--; transferred(); transferred();
    await ready[index].promise;
    finished.push(index);
  }).then(() => { settled = true; });
  await flush();
  assert.deepEqual(started, [0, 1]);
  for (let index = 0; index < 8; index++) { transfers[index].resolve(); await flush(); }
  assert.equal(peak, 2);
  assert.deepEqual(started, [...Array(8).keys()]);
  assert.deepEqual(finished, []);
  assert.equal(settled, false);
  for (const item of ready) item.resolve();
  await pending;
  assert.equal(finished.length, 8);
});

test("a processing failure stops queued transfers and waits for all already-started jobs", async () => {
  const ready = Array.from({ length: 4 }, gate), started = [];
  const releases = [];
  const failure = new Error("processing failed");
  let settled = false;
  const pending = runImageUploadBatch([0, 1, 2, 3, 4, 5], async (index, _position, transferred) => {
    started.push(index); releases[index] = transferred;
    await ready[index].promise;
    if (index === 0) throw failure;
  }).catch(error => { settled = true; return error; });
  await flush(); releases[0](); releases[1](); await flush();
  assert.deepEqual(started, [0, 1, 2, 3]);
  ready[0].resolve(); await flush();
  assert.equal(settled, false);
  ready[1].resolve(); ready[2].resolve(); ready[3].resolve();
  assert.equal(await pending, failure);
  assert.deepEqual(started, [0, 1, 2, 3]);
});
