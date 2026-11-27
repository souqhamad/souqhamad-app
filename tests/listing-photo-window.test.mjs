import assert from 'node:assert/strict';
import test from 'node:test';
import { getListingPhotoWindow } from '../src/ui/listing-photo-window.ts';
import { getListingImageSources, getListingCardImageSources } from '../src/core/listing-image-sources.ts';

test('eight photos do not all start loading before or outside the viewport', () => {
  assert.deepEqual(getListingPhotoWindow(8, null, 0, 0), { first: 0, last: 0 });
  assert.deepEqual(getListingPhotoWindow(8, 1500, 0, 600), { first: 0, last: -1 });
  assert.deepEqual(getListingPhotoWindow(8, 400, 0, 600), { first: 0, last: 1 });
});

test('scrolling prepares the visible rows and one row before and after', () => {
  assert.deepEqual(getListingPhotoWindow(8, 400, 1060, 400), { first: 2, last: 5 });
  assert.deepEqual(getListingPhotoWindow(8, 400, 1940, 600), { first: 6, last: 7 });
  assert.deepEqual(getListingPhotoWindow(8, 400, 2600, 600), { first: 0, last: -1 });
});

test('rotation, overscroll and empty photos cannot produce invalid indexes', () => {
  assert.deepEqual(getListingPhotoWindow(0, 400, 0, 600), { first: 0, last: -1 });
  assert.deepEqual(getListingPhotoWindow(1, 0, -80, 600), { first: 0, last: 0 });
  const portrait = getListingPhotoWindow(8, 400, 620, 800);
  const landscape = getListingPhotoWindow(8, 400, 620, 400);
  assert.ok(portrait.last > landscape.last);
});

const resolve = url => typeof url === 'string' && url.startsWith('https://') ? url : undefined;
test('details and gallery share exact CDN URLs and original-only images have a preview', () => {
  const original = 'https://images.souqhamad.com/old.jpg';
  assert.deepEqual(getListingImageSources({ originalUrl: original }, resolve), {
    source: original, previewSource: original, thumbnailSource: undefined,
  });
  const preview = 'https://images.souqhamad.com/display.webp';
  assert.equal(getListingImageSources({ originalUrl: original, displayUrl: preview }, resolve).previewSource, preview);
});

test('an invalid URL does not suppress a valid fallback from the server', () => {
  const original = 'https://images.souqhamad.com/original.jpg';
  assert.equal(getListingImageSources({ originalUrl: original, thumbnailUrl: 'ftp://invalid.test/thumb' }, resolve).previewSource, original);
});

test('processed WebP delivery is shared by details and zoom without requesting a legacy master', () => {
  const image = {
    originalUrl: 'https://images.souqhamad.com/listings/old.jpg',
    displayUrl: 'https://images.souqhamad.com/listings/current-display.webp',
    thumbnailUrl: 'https://images.souqhamad.com/listings/current-thumbnail.webp',
  };
  const viewing = getListingImageSources(image, resolve);
  assert.equal(viewing.source, image.displayUrl);
  assert.equal(viewing.previewSource, image.displayUrl);
  assert.deepEqual(getListingCardImageSources(image, resolve), [image.thumbnailUrl, image.displayUrl, image.originalUrl]);
});

test('eight new direct-upload aliases retain eight independently selectable delivery images', () => {
  const images = Array.from({ length: 8 }, (_, index) => {
    const displayUrl = `https://images.souqhamad.com/listings/2026/10/image-${index}-display.webp`;
    return { originalUrl: displayUrl, displayUrl, thumbnailUrl: displayUrl.replace('-display.webp', '-thumbnail.webp') };
  });
  const sources = images.map(image => getListingImageSources(image, resolve));
  assert.equal(new Set(sources.map(item => item.source)).size, 8);
  assert.ok(sources.every(item => item.source === item.previewSource));
  assert.ok(images.every(image => getListingCardImageSources(image, resolve).length === 2));
});

test('empty and partial server image rows have safe distinct fallbacks', () => {
  assert.deepEqual(getListingImageSources(undefined, resolve), { source: undefined, previewSource: undefined, thumbnailSource: undefined });
  assert.deepEqual(getListingCardImageSources(undefined, resolve), []);
  const url = 'https://images.souqhamad.com/legacy.jpg';
  assert.deepEqual(getListingCardImageSources({ originalUrl: url, displayUrl: url, thumbnailUrl: url }, resolve), [url]);
  assert.deepEqual(getListingCardImageSources({ thumbnailUrl: 'ftp://bad/thumb', displayUrl: url }, resolve), [url]);
});
