import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { syncListingImageCaches } from '../src/core/listing-image-cache.ts';

const photo = (id, primary = false, status = 'approved') => ({ id, isPrimary: primary, status });
const listing = images => ({ id: 'listing-image-test', sellerId: 'owner-test', status: 'published', images });

test('publication progress updates authoritative detail without refetching the active list after every photo', async () => {
  const client = new QueryClient();
  let reads = 0;
  const key = ['my-listings', 'owner-test'];
  const observer = new QueryObserver(client, { queryKey: key, initialData: { listings: [] }, staleTime: Infinity,
    queryFn: async () => { reads++; return { listings: [listing([photo('confirmed')])] }; } });
  const stop = observer.subscribe(() => {});
  for (let index = 0; index < 8; index++) {
    const saved = listing([photo(`confirmed-${index}`)]);
    syncListingImageCaches(client, saved, { refetch: false });
    assert.deepEqual(client.getQueryData(['owned-listing', saved.sellerId, saved.id]).listing.images, saved.images);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
  assert.equal(client.getQueryState(key).isInvalidated, true);
  syncListingImageCaches(client, listing([photo('confirmed')]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  stop(); client.clear();
});

test('deleting the primary photo immediately updates cached detail and server-selected replacement', () => {
  const client = new QueryClient();
  const old = listing([photo('removed', true), photo('remaining')]);
  client.setQueryData(['listing', old.id], { listing: old });
  client.setQueryData(['listing', old.id, 'screen-open-1'], { listing: old });
  for (const key of [['marketplace', 'cars'], ['my-listings'], ['seller', old.sellerId], ['account', old.sellerId, 'favorites']])
    client.setQueryData(key, { listings: [old] });
  const updated = listing([photo('remaining', true)]);
  syncListingImageCaches(client, updated);
  assert.deepEqual(client.getQueryData(['listing', old.id]).listing.images, updated.images);
  assert.deepEqual(client.getQueryData(['listing', old.id, 'screen-open-1']).listing.images, updated.images);
  assert.deepEqual(client.getQueryData(['owned-listing', old.sellerId, old.id]).listing.images, updated.images);
  for (const key of [['marketplace', 'cars'], ['my-listings'], ['seller', old.sellerId], ['account', old.sellerId, 'favorites']])
    assert.equal(client.getQueryState(key).isInvalidated, true);
  client.clear();
});

test('an older in-flight detail response cannot restore the deleted photo', async () => {
  const client = new QueryClient();
  const old = listing([photo('removed', true)]);
  const detailKeys = [['listing', old.id], ['listing', old.id, 'screen-open-1'], ['listing', old.id, 'screen-open-2']];
  const releases = [];
  let releaseOwned;
  const requests = detailKeys.map(queryKey => client.fetchQuery({
    queryKey, queryFn: () => new Promise(resolve => { releases.push(resolve); }),
  }).catch(() => {}));
  const ownedKey = ['owned-listing', old.sellerId, old.id];
  const ownedRequest = client.fetchQuery({ queryKey: ownedKey, queryFn: () => new Promise(resolve => { releaseOwned = resolve; }) }).catch(() => {});
  syncListingImageCaches(client, listing([]));
  for (const release of releases) release({ listing: old });
  releaseOwned({ listing: old });
  await Promise.all([...requests, ownedRequest]);
  for (const key of detailKeys) assert.deepEqual(client.getQueryData(key).listing.images, []);
  assert.deepEqual(client.getQueryData(ownedKey).listing.images, []);
  client.clear();
});

test('owned-only photos and unpublished listings do not enter public detail cache', () => {
  const client = new QueryClient();
  const updated = listing([photo('visible', true), photo('pending', false, 'pending_review')]);
  syncListingImageCaches(client, updated);
  assert.equal(client.getQueryData(['listing', updated.id]).listing.images.length, 1);
  assert.equal(client.getQueryData(['owned-listing', updated.sellerId, updated.id]).listing.images.length, 2);
  syncListingImageCaches(client, { ...updated, status: 'draft' });
  assert.equal(client.getQueryData(['listing', updated.id]), undefined);
  client.clear();
});

for (const status of ['published', 'draft']) {
  test('image cache sync preserves similar arrays while updating ' + status + ' detail queries', () => {
    const client = new QueryClient();
    const old = listing([photo('removed', true)]);
    const updated = { ...listing([photo('remaining', true)]), status };
    const detailKeys = [['listing', old.id], ['listing', old.id, 'screen-open-1'], ['listing', old.id, 'screen-open-2']];
    for (const key of detailKeys) client.setQueryData(key, { listing: old });
    const otherKey = ['listing', 'other-listing', 'screen-open-1'];
    const otherData = { listing: { ...old, id: 'other-listing' } };
    client.setQueryData(otherKey, otherData);

    const similar = [{ ...listing([photo('similar-photo')]), id: 'similar-listing' }];
    const similarKey = ['listing', old.id, 'similar'];
    const similarVariantKey = [...similarKey, { category: 'cars' }];
    client.setQueryData(similarVariantKey, similar);
    const observer = new QueryObserver(client, {
      queryKey: similarKey, initialData: similar, staleTime: Infinity,
      queryFn: async () => { throw new Error('Image edits must not refetch similar listings'); },
    });
    const stop = observer.subscribe(() => {});
    const similarQuery = client.getQueryCache().find({ queryKey: similarKey, exact: true });
    try {
      syncListingImageCaches(client, updated, { refetch: false });
      for (const key of detailKeys) {
        if (status === 'published') assert.deepEqual(client.getQueryData(key), { listing: updated });
        else assert.equal(client.getQueryData(key), undefined);
      }
      assert.strictEqual(client.getQueryData(similarKey), similar);
      assert.strictEqual(client.getQueryData(similarVariantKey), similar);
      assert.strictEqual(observer.getCurrentResult().data, similar);
      assert.strictEqual(client.getQueryCache().find({ queryKey: similarKey, exact: true }), similarQuery);
      assert.strictEqual(client.getQueryData(otherKey), otherData);
    } finally {
      stop();
      client.clear();
    }
  });

  test('image cache sync leaves an active similar request running for ' + status + ' listings', async () => {
    const client = new QueryClient();
    const updated = { ...listing([]), status };
    const similarKey = ['listing', updated.id, 'similar'];
    const similar = [{ ...listing([photo('similar-photo')]), id: 'similar-listing' }];
    let release, requestSignal, reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: similarKey,
      queryFn: ({ signal }) => {
        requestSignal = signal;
        reads++;
        return new Promise(resolve => { release = resolve; });
      },
    });
    const stop = observer.subscribe(() => {});
    const request = observer.refetch({ cancelRefetch: false });
    try {
      assert.equal(reads, 1);
      assert.equal(observer.getCurrentResult().fetchStatus, 'fetching');
      syncListingImageCaches(client, updated, { refetch: false });
      assert.equal(requestSignal.aborted, false);
      assert.equal(client.getQueryState(similarKey).fetchStatus, 'fetching');
      release(similar);
      const result = await request;
      assert.equal(reads, 1);
      assert.strictEqual(result.data, similar);
      assert.strictEqual(observer.getCurrentResult().data, similar);
      assert.strictEqual(client.getQueryData(similarKey), similar);
    } finally {
      release(similar);
      stop();
      client.clear();
    }
  });
}
