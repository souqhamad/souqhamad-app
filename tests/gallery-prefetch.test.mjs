import assert from 'node:assert/strict';
import test from 'node:test';
import { createGalleryPrefetcher } from '../src/ui/gallery-prefetch.ts';

test('a false or rejected warm-up is retried, while a successful one is reused', async () => {
  let calls = 0;
  const warm = createGalleryPrefetcher(async () => {
    calls++;
    if (calls === 1) return false;
    if (calls === 2) throw new Error('offline');
    return true;
  });
  assert.deepEqual(await warm(['preview']), [false]);
  assert.deepEqual(await warm(['preview']), [false]);
  assert.deepEqual(await warm(['preview']), [true]);
  assert.deepEqual(await warm(['preview']), [true]);
  assert.equal(calls, 3);
});

test('multiple consumers share one pending preview request', async () => {
  let finish;
  let calls = 0;
  const warm = createGalleryPrefetcher(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const first = warm(['same', 'same']);
  const second = warm(['same']);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(true);
  assert.deepEqual(await first, [true, true]);
  assert.deepEqual(await second, [true]);
});
