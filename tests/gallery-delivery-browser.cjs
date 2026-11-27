/* Isolated React Native Web image-delivery regressions. All APIs and images are
 * fixtures. This does not establish Android/iPhone performance or CDN latency.
 * Run after a web export: node tests/gallery-delivery-browser.cjs
 * Port 8181 is exclusive; do not run another browser harness concurrently.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { chromium, expect } = require("@playwright/test");
const fixture = require("./browser-smoke.cjs");

const output = path.resolve(__dirname, "../.data/gallery-delivery");
const report = { boundary: "Isolated RN Web with generated images and intercepted APIs; no production writes or native-device verification", tests: [], images: [] };
const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const imageOrigin = "https://images.souqhamad.com";

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, color) {
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  };
  const dimensions = Buffer.alloc(13);
  dimensions.writeUInt32BE(width, 0); dimensions.writeUInt32BE(height, 4);
  dimensions[8] = 8; dimensions[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + x * 3 + 1;
    rows[offset] = color[0]; rows[offset + 1] = color[1]; rows[offset + 2] = color[2];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", dimensions), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const colors = [[32, 140, 110], [192, 70, 70], [70, 100, 185], [190, 140, 35], [115, 65, 170], [30, 150, 175], [180, 70, 120], [220, 100, 35]];
const bodies = colors.map(color => ({ thumbnail: png(120, 80, color), display: png(600, 400, color), original: png(1200, 800, color) }));

async function installImages(context, scenario, originalOnly = false) {
  const state = { requests: [], originalMode: "ready", originalGate: deferred(), previewGate: deferred(), blockRepeatedPreviews: false };
  const primaryVariant = originalOnly ? "original" : "display";
  const images = colors.map((_, index) => {
    const url = variant => `${imageOrigin}/test-gallery/${scenario}/${index + 1}/${variant}.png`;
    return { id: `test-gallery-${index + 1}`, listingId: fixture.listingId, status: "approved", isPrimary: index === 0, originalUrl: url("original"), displayUrl: originalOnly ? "" : url("display"), thumbnailUrl: originalOnly ? "" : url("thumbnail") };
  });
  const listing = { ...fixture.listing, images };
  await context.route(`**/api/marketplace/listings/${fixture.listingId}`, route => route.fulfill({ contentType: "application/json", headers, body: JSON.stringify({ listing }) }));
  await context.route(`${imageOrigin}/**`, async route => {
    const match = new URL(route.request().url()).pathname.match(/\/test-gallery\/[^/]+\/(\d+)\/(thumbnail|display|original)\.png$/);
    assert.ok(match, "Every image request must use an explicit local fixture");
    const index = Number(match[1]);
    const variant = match[2];
    const repeated = state.requests.some(request => request.index === index && request.variant === variant);
    const record = { scenario, index, variant };
    state.requests.push(record); report.images.push(record);
    if (variant === primaryVariant) {
      const mode = state.originalMode;
      if (mode === "fail") return route.fulfill({ status: 503, headers, contentType: "text/plain", body: "fixture unavailable" });
      if (mode === "hold") await state.originalGate.promise;
    } else if (state.blockRepeatedPreviews && repeated) await state.previewGate.promise;
    try { await route.fulfill({ status: 200, contentType: "image/png", headers, body: bodies[index - 1][variant] }); }
    catch (error) { if (!/closed|disposed|Target page|Route is already handled/i.test(error.message)) throw error; }
  });
  state.release = () => { state.originalGate.release(); state.previewGate.release(); };
  return state;
}

const modal = page => page.locator('[aria-modal="true"]').last();
const close = page => page.getByRole("button", { name: "إغلاق الصور", exact: true });

async function hasVisibleImage(page, index, galleryOnly = true) {
  return page.evaluate(({ index, galleryOnly }) => {
    const root = galleryOnly ? [...document.querySelectorAll('[aria-modal="true"]')].at(-1) : document;
    if (!root) return false;
    const label = `صورة الإعلان ${index} من 8`;
    return [...root.querySelectorAll("img")].some(node => {
      if ((node.alt || node.closest("[aria-label]")?.getAttribute("aria-label")) !== label || !node.complete || !node.naturalWidth) return false;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height || (galleryOnly && (box.right <= 0 || box.left >= innerWidth))) return false;
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.opacity === "0" || style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    });
  }, { index, galleryOnly });
}

async function enterListing(page) {
  await page.goto(`${fixture.origin}/listings/${fixture.listingId}`);
  await expect(page.getByRole("button", { name: "فتح صورة الإعلان 1 من 8", exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "جارٍ تشغيل التطبيق", exact: true })).toHaveCount(0);
}

async function openImage(page, index) {
  const button = page.getByRole("button", { name: `فتح صورة الإعلان ${index} من 8`, exact: true });
  await button.scrollIntoViewIfNeeded();
  await expect.poll(() => hasVisibleImage(page, index, false)).toBe(true);
  await button.click();
  await expect(close(page)).toBeVisible();
  await expect(modal(page).getByText(`${index} من 8`, { exact: true })).toBeVisible();
  await expect.poll(() => hasVisibleImage(page, index)).toBe(true);
  // Wait for the existing modal fade before taking evidence screenshots. The
  // image may load earlier; this is visual settling, not a latency measurement.
  await expect.poll(() => modal(page).evaluate(element => {
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (Number(getComputedStyle(ancestor).opacity) < 0.99) return false;
    }
    return true;
  })).toBe(true);
}

async function closeImage(page) {
  await close(page).click();
  await expect(close(page)).toHaveCount(0);
}

async function assertGalleryGeometry(page, index, stage) {
  await expect(close(page)).toBeInViewport({ ratio: 1 });
  const geometry = await page.evaluate(index => {
    const root = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
    const rect = node => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right };
    };
    const images = [...root.querySelectorAll("img")].filter(node => {
      if ((node.alt || node.closest("[aria-label]")?.getAttribute("aria-label")) !== `صورة الإعلان ${index} من 8` || !node.complete || !node.naturalWidth) return false;
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (Number(style.opacity) < 0.99 || style.display === "none" || style.visibility === "hidden") return false;
      }
      const box = node.getBoundingClientRect();
      return box.right > 0 && box.x < innerWidth;
    }).map(node => ({ ...rect(node), fit: getComputedStyle(node).objectFit, naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight }));
    return { viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, modal: rect(root), images };
  }, index);
  assert.ok(Math.abs(geometry.modal.x) < 1 && Math.abs(geometry.modal.y) < 1, "The gallery modal must start at the viewport origin");
  assert.ok(Math.abs(geometry.modal.width - geometry.viewport.width) < 1 && Math.abs(geometry.modal.height - geometry.viewport.height) < 1, "The modal must fill the viewport after opening an offscreen photo");
  assert.ok(geometry.images.length > 0, "A decoded image must be visible in the measured gallery page");
  for (const image of geometry.images) {
    assert.equal(image.fit, "contain", "Gallery images must retain their aspect ratio");
    assert.ok(Math.abs(image.x) < 1 && Math.abs(image.width - geometry.viewport.width) < 1, "The selected gallery page must align horizontally with the viewport");
    assert.ok(image.y >= 0 && image.bottom <= geometry.viewport.height + 1, "The image page must remain inside the viewport");
    assert.ok(Math.abs(image.y + image.height / 2 - geometry.viewport.height / 2) <= 16, "The image page must remain centered between the close control and footer");
  }
  report.geometry ??= [];
  report.geometry.push({ index, stage, ...geometry });
}

async function scenario(browser, name, callback, options = {}) {
  const selected = process.argv.find(value => value.startsWith("--scenario="))?.slice(11);
  if (selected && selected !== name) return;
  const started = Date.now();
  const { context, page } = await fixture.fixtureContext(browser, false, name);
  const state = await installImages(context, name, options.originalOnly);
  try {
    await callback({ page, state });
    report.tests.push({ name, passed: true, durationMs: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => undefined);
    report.tests.push({ name, passed: false, durationMs: Date.now() - started, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    state.release();
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = fixture.createStaticServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(8181, "127.0.0.1", resolve); });
  const browser = await chromium.launch({ headless: true });
  try {
    await scenario(browser, "eight-display-images-open-and-swipe-without-requesting-masters", async ({ page, state }) => {
      await enterListing(page);
      await expect.poll(() => state.requests.length).toBeGreaterThan(0);
      assert.ok(new Set(state.requests.map(request => request.index)).size < 8, "Initial details entry keeps offscreen photos lazy");
      for (const index of [4, 8, 1, 2, 3, 5, 6, 7]) {
        await openImage(page, index);
        await assertGalleryGeometry(page, index, "display-settled");
        await page.screenshot({ path: path.join(output, `selected-${index}.png`) });
        await closeImage(page);
      }
      await openImage(page, 1);
      for (const index of [2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1]) {
        // Native swipe physics needs a device. This exercises the web pager's
        // real scroll and viewability events without invoking React handlers.
        const scrollEvidence = await page.evaluate(index => {
          const root = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
          const pager = [...root.querySelectorAll('div')].find(node => node.scrollWidth > node.clientWidth * 2 && node.clientWidth > 300 && getComputedStyle(node).overflowX === 'auto');
          if (!pager) throw new Error('Gallery horizontal scroll container not found');
          Element.prototype.scrollTo.call(pager, { left: pager.clientWidth * (index - 1), behavior: 'instant' });
          return [...root.querySelectorAll('div')].filter(node => node.scrollWidth > node.clientWidth * 2 && node.clientWidth > 300)
            .map(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, scrollLeft: node.scrollLeft, overflow: getComputedStyle(node).overflowX }));
        }, index);
        report.scrollEvidence ??= []; report.scrollEvidence.push({ index, candidates: scrollEvidence });
        await expect(modal(page).getByText(`${index} من 8`, { exact: true })).toBeVisible();
        await expect.poll(() => hasVisibleImage(page, index)).toBe(true);
      }
      assert.equal(state.requests.filter(request => request.variant === "original").length, 0, "The viewer uses processed display files even when an old master URL exists");
      assert.deepEqual([...new Set(state.requests.filter(request => request.variant === "display").map(request => request.index))].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
      await closeImage(page);
    });

    await scenario(browser, "thumbnail-stays-visible-while-display-is-held", async ({ page, state }) => {
      state.originalMode = "hold";
      await enterListing(page);
      await openImage(page, 4);
      assert.equal(await hasVisibleImage(page, 4), true);
      state.originalMode = "ready"; state.originalGate.release();
      await expect.poll(() => modal(page).locator('img[src$="/4/display.png"]').evaluateAll(nodes => nodes.some(node => node.complete && node.naturalWidth > 0))).toBe(true);
      await assertGalleryGeometry(page, 4, "display-recovered");
      assert.equal(state.requests.filter(request => request.variant === "original").length, 0);
      await closeImage(page);
    });

    await scenario(browser, "stalled-display-retains-thumbnail-and-recovers-without-app-restart", async ({ page, state }) => {
      await page.clock.install();
      state.originalMode = "hold";
      await enterListing(page);
      await openImage(page, 1);
      await page.clock.fastForward(15001);
      const retry = modal(page).getByRole("button", { name: "إعادة المحاولة", exact: true });
      await expect(retry).toBeVisible();
      assert.equal(await hasVisibleImage(page, 1), true);
      state.originalMode = "ready";
      await retry.click();
      state.originalGate.release();
      await expect(retry).toHaveCount(0);
      await expect.poll(() => modal(page).locator('img[src$="/1/display.png"]').evaluateAll(nodes => nodes.some(node => node.complete && node.naturalWidth > 0))).toBe(true);
      await closeImage(page);
    });

    await scenario(browser, "failed-display-retry-retains-the-same-thumbnail-view", async ({ page, state }) => {
      state.originalMode = "fail";
      await enterListing(page);
      await openImage(page, 1);
      const retry = modal(page).getByRole("button", { name: "إعادة المحاولة", exact: true });
      await expect(retry).toBeVisible();
      assert.equal(await hasVisibleImage(page, 1), true);
      const thumbnail = await modal(page).locator('img[src$="/1/thumbnail.png"]').elementHandle();
      const count = state.requests.filter(request => request.index === 1 && request.variant === "thumbnail").length;
      state.originalMode = "hold"; state.blockRepeatedPreviews = true;
      await retry.click();
      await expect.poll(() => state.requests.filter(request => request.index === 1 && request.variant === "display").length).toBeGreaterThan(1);
      assert.equal(await thumbnail.evaluate(node => node.isConnected), true, "Retrying the failed display preserves the same successful thumbnail view");
      assert.equal(state.requests.filter(request => request.index === 1 && request.variant === "thumbnail").length, count);
      await page.screenshot({ path: path.join(output, "retry-keeps-thumbnail.png") });
      state.originalGate.release();
      await expect(retry).toHaveCount(0);
      await thumbnail.dispose();
      await closeImage(page);
    });

    await scenario(browser, "legacy-original-only-and-double-tap-zoom", async ({ page }) => {
      await enterListing(page);
      for (const index of [1, 8]) {
        await openImage(page, index);
        if (index === 1) {
          const bounds = await modal(page).boundingBox();
          await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { delay: 70 });
          await expect.poll(() => modal(page).evaluate(element => [...element.querySelectorAll("div")].some(node => {
            const transform = getComputedStyle(node).transform;
            return transform && transform !== "none" && new DOMMatrix(transform).a > 1.1;
          }))).toBe(true);
        }
        await closeImage(page);
      }
    }, { originalOnly: true });
    assert.deepEqual(fixture.report.browserErrors, [], "No browser exception may escape the fixture");
    assert.deepEqual(fixture.report.unexpectedApi, [], "All API access must be intercepted");
    assert.deepEqual(fixture.report.blockedRemote, [], "No unexpected remote request may escape the fixture");
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    report.browserErrors = fixture.report.browserErrors;
    report.passed = report.tests.filter(test => test.passed).length;
    report.failed = report.tests.filter(test => !test.passed).length;
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ boundary: report.boundary, passed: report.passed, failed: report.failed, report: path.join(output, "report.json") }, null, 2));
    if (report.failed) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
