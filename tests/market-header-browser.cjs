/* Local React Native Web regression for the fixed market message and empty
 * My Listings screen. Requires a fresh web export; run from the app root with:
 * $env:EXPO_PREVIEW_DIR='.data/release-1.0.56-export'; node tests/market-header-browser.cjs
 * Every API request is intercepted fixture data. No native binary or production
 * behavior is claimed by these browser checks.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect } = require("@playwright/test");
const fixture = require("./browser-smoke.cjs");
const catalog = require("../src/core/market-catalog.json");

const output = path.resolve(__dirname, "../.data/release-1.0.56-header-browser");
const shortMessage = "حياك في سوق حمد";
const longMessage = "حياك في سوق حمد — تصفّح إعلانات منطقتك وتواصل مع المعلن لترتيب المعاينة، وأضف إعلانك بسهولة من أدوات السوق. هذه رسالة اختبار محلية للتأكد من حركة النص الطويل دون تغيير موضع الإعلانات.";
const title = index => `Header fixture ${String(index).padStart(2, "0")}`;
const records = Array.from({ length: 24 }, (_, index) => ({
  ...fixture.listing, id: `header-fixture-${index + 1}`, title: title(index + 1),
  price: 10000 + index, images: [],
}));
const results = [];
const screenshots = [];
const json = (route, body) => route.fulfill({ contentType: "application/json", headers: {
  "Access-Control-Allow-Origin": fixture.origin,
  "Access-Control-Allow-Headers": "Accept,Content-Type,Authorization,Idempotency-Key,X-Souq-Hamad-Commission-Agreement",
  "Access-Control-Allow-Methods": "GET,OPTIONS", "Cache-Control": "no-store",
}, body: JSON.stringify(body) });

async function installFixtures(context, { message, scheme = "light", deferBootstrap = false }) {
  let releaseBootstrap;
  const bootstrapReady = deferBootstrap ? new Promise(resolve => { releaseBootstrap = resolve; }) : Promise.resolve();
  const state = { message, release: () => releaseBootstrap?.(), inventoryReads: 0 };
  await context.addInitScript(scheme => {
    localStorage.setItem("souq-hamad-appearance-v1", scheme);
    // Keep fixture SSE idle and open. The base smoke fixture deliberately emits
    // events/reconnects that would otherwise refresh unrelated list queries.
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname !== "/api/realtime/stream") return originalFetch(input, init);
      let controller;
      const stream = new ReadableStream({ start(value) {
        controller = value; value.enqueue(new TextEncoder().encode(": idle header fixture\n\n"));
      } });
      init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* closed */ } }, { once: true });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    };
  }, scheme);
  await context.route("**/api/mobile/bootstrap*", async route => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    await bootstrapReady;
    return json(route, {
      categories: catalog.categories, cities: catalog.cities, policies: catalog.policies,
      limits: { maxListingImages: 8, maxImageBytes: 12582912, maxProfileImageBytes: 4194304, maxListingsPerSeller: 100 },
      auth: { google: true, apple: false }, policyVersions: {}, attributes: catalog.attributes,
      siteMessage: state.message ? { message: state.message, type: "info", expiresAt: null } : null,
    });
  });
  await context.route("**/api/marketplace/listings**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/marketplace/listings" || request.method() === "OPTIONS") return route.fallback();
    assert.equal(request.method(), "GET");
    state.inventoryReads++;
    return json(route, { listings: records, pagination: { page: 1, limit: 24, hasMore: false, nextPage: null } });
  });
  return state;
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let index = 0; index < 5; index++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
}

async function geometry(page) {
  return page.evaluate(firstTitle => {
    const byId = id => document.querySelector(`[data-testid="${id}"]`);
    const rectangle = element => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const header = byId("market-header");
    const message = byId("market-header-message");
    const track = byId("market-header-message-track");
    const first = [...document.querySelectorAll('[role="button"]')].find(element => element.getAttribute("aria-label") === firstTitle);
    const feed = byId("market-feed");
    const port = feed && [feed, ...feed.querySelectorAll("div")].find(element => {
      const style = getComputedStyle(element);
      return /auto|scroll/.test(style.overflowY) && element.clientHeight > 100 && element.scrollHeight > element.clientHeight + 5;
    });
    return {
      time: performance.now(), header: rectangle(header), message: rectangle(message),
      logo: rectangle(byId("market-header-logo")),
      notifications: rectangle(header?.querySelector('[aria-label="الإشعارات"]')),
      account: rectangle(header?.querySelector('[aria-label="حسابي"], [aria-label="تسجيل الدخول"]')),
      toolbar: rectangle(byId("market-toolbar")), categories: rectangle(byId("market-categories")),
      feed: rectangle(feed), first: rectangle(first), offset: port?.scrollTop ?? 0,
      contentHeight: port?.scrollHeight ?? null,
      translation: track ? new DOMMatrixReadOnly(getComputedStyle(track).transform).m41 : null,
      copies: track?.children.length ?? 0, textWidth: track?.children[0]?.getBoundingClientRect().width ?? null,
      scheme: document.documentElement.style.colorScheme,
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  }, title(1));
}

async function sample(page, milliseconds = 850) {
  // Capture presented frames with the same DOM geometry reader used by the
  // assertions; application state and React internals are never inspected.
  const frames = [];
  const start = Date.now();
  do {
    frames.push(await geometry(page));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  } while (Date.now() - start < milliseconds);
  assert.ok(frames.length > 8, "Motion evidence requires multiple presented frames");
  return frames;
}

function fixed(frames, key, description) {
  for (const field of ["x", "y", "width", "height"]) {
    const values = frames.map(frame => frame[key]?.[field]);
    assert.ok(values.every(Number.isFinite), `${description}: ${key}.${field} must exist`);
    assert.ok(Math.max(...values) - Math.min(...values) <= 1, `${description}: ${key}.${field} shifted`);
  }
}

function assertSlot(current, width) {
  assert.ok(current.header && current.logo && current.notifications && current.account && current.message);
  assert.equal(Math.round(current.header.height), 56);
  assert.ok(current.message.width >= 60, "Message keeps a readable slot on narrow screens");
  assert.ok(current.message.x >= Math.max(current.notifications.right, current.account.right), "Message must sit between account/notification controls and the logo");
  assert.ok(current.message.right <= current.logo.x, "Message must not overlap the logo");
  assert.ok(current.message.y >= current.header.y && current.message.bottom <= current.header.bottom);
  assert.ok(current.documentWidth <= width + 1, "Long text must not create page overflow");
  assert.ok(current.toolbar.y >= current.header.bottom - 1, "Message belongs above the toolbar");
}

function assertMotion(frames, moving) {
  const values = frames.map(frame => frame.translation);
  assert.ok(values.every(Number.isFinite), "The message track must be mounted");
  const delta = values.at(-1) - values[0];
  if (!moving) {
    assert.ok(Math.max(...values) - Math.min(...values) < 0.5, "A short/reduced-motion message must stay still");
    assert.ok(frames.every(frame => frame.copies === 1), "Static messages should render one copy");
    return { delta, samples: frames.length };
  }
  assert.ok(frames.every(frame => frame.copies === 2), "Overflow animation needs a continuous pair of text copies");
  assert.ok(delta > 8, `Long text must visibly move left-to-right; observed ${delta}px`);
  for (let index = 1; index < values.length; index++) assert.ok(values[index] >= values[index - 1] - 0.5, "Text must consistently travel left-to-right");
  const speed = delta / ((frames.at(-1).time - frames[0].time) / 1000);
  assert.ok(speed > 10 && speed < 40, `The message speed should be gentle; observed ${speed}px/s`);
  return { delta, speed, samples: frames.length };
}

async function screenshot(page, name) {
  const filename = path.join(output, `${name}.png`);
  await page.screenshot({ path: filename, fullPage: true });
  screenshots.push(filename);
}

async function scenario(browser, name, options, callback) {
  const started = Date.now();
  const { context, page } = await fixture.fixtureContext(browser, Boolean(options.authenticated), name);
  const record = { name, passed: false, viewport: options.viewport, scheme: options.scheme || "light" };
  let state;
  try {
    await page.setViewportSize(options.viewport || { width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: options.scheme || "light", reducedMotion: options.reducedMotion || "no-preference" });
    state = await installFixtures(context, options);
    await callback({ page, context, state, record });
    record.passed = true;
    console.log(`PASS ${name}`);
  } catch (error) {
    record.error = error.stack || String(error);
    console.error(`FAIL ${name}: ${error.message}`);
    await screenshot(page, `${name}-failure`).catch(() => {});
  } finally {
    state?.release();
    record.durationMs = Date.now() - started;
    results.push(record);
    await context.close();
  }
}

async function home(page) {
  await page.goto(fixture.origin);
  await expect(page.getByRole("button", { name: title(1), exact: true })).toBeVisible();
  await settle(page);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = fixture.createStaticServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(8181, "127.0.0.1", resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const config of [
      { name: "short-phone-light", viewport: { width: 390, height: 844 }, scheme: "light", message: shortMessage, moving: false },
      { name: "long-phone-light", viewport: { width: 390, height: 844 }, scheme: "light", message: longMessage, moving: true },
      { name: "long-narrow-dark", viewport: { width: 320, height: 740 }, scheme: "dark", message: longMessage, moving: true },
      { name: "long-tablet-light", viewport: { width: 820, height: 1180 }, scheme: "light", message: longMessage, moving: true },
      { name: "long-reduced-motion", viewport: { width: 390, height: 844 }, scheme: "dark", message: longMessage, moving: false, reducedMotion: "reduce" },
    ]) await scenario(browser, config.name, config, async ({ page, record }) => {
      await home(page);
      await expect(page.getByTestId("market-header-message")).toBeVisible();
      await expect(page.getByTestId("market-header-message")).toHaveAttribute("aria-label", config.message);
      await expect.poll(async () => (await geometry(page)).copies).toBe(config.moving ? 2 : 1);
      await settle(page);
      const frames = await sample(page);
      record.geometry = frames[0];
      record.motion = assertMotion(frames, config.moving);
      assertSlot(frames[0], config.viewport.width);
      assert.equal(frames[0].scheme, config.scheme);
      for (const key of ["header", "message", "toolbar", "feed", "first"]) fixed(frames, key, "Text animation alone");
      await screenshot(page, config.name);
      if (config.name === "long-phone-light") {
        // Drive the real React Native Web scroll container. Headless Chromium's
        // desktop wheel input does not reliably target mobile FlatList scrolling.
        await page.evaluate(() => {
          const feed = document.querySelector('[data-testid="market-feed"]');
          const port = feed && [feed, ...feed.querySelectorAll("div")].find(element => {
            const style = getComputedStyle(element);
            return /auto|scroll/.test(style.overflowY) && element.clientHeight > 100 && element.scrollHeight > element.clientHeight + 5;
          });
          if (!port) throw new Error("The market feed scroll container was not found");
          port.scrollTop = 260;
        });
        await expect.poll(async () => (await geometry(page)).offset).toBeGreaterThan(100);
        await expect.poll(async () => (await geometry(page)).toolbar.y).toBeLessThan(frames[0].toolbar.y - 30);
        const scrolled = await geometry(page);
        fixed([frames[0], scrolled], "header", "Feed scroll"); fixed([frames[0], scrolled], "message", "Feed scroll");
        record.scrolled = scrolled;
        await screenshot(page, "long-phone-light-scrolled");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect.poll(async () => (await geometry(page)).copies).toBe(1);
        record.reducedMotionChange = assertMotion(await sample(page, 500), false);
      }
    });

    await scenario(browser, "late-message-keeps-layout", { viewport: { width: 390, height: 844 }, message: longMessage, deferBootstrap: true }, async ({ page, state, record }) => {
      await home(page);
      await expect(page.getByTestId("market-header-message")).toHaveCount(0);
      const before = await sample(page, 250);
      const [changing] = await Promise.all([
        sample(page, 1200),
        (async () => {
          state.release();
          await expect(page.getByTestId("market-header-message")).toBeVisible();
          await expect.poll(async () => (await geometry(page)).copies).toBe(2);
        })(),
      ]);
      const after = await sample(page, 500);
      const frames = [...before, ...changing, ...after];
      for (const key of ["header", "toolbar", "feed", "first"]) fixed(frames, key, "Late bootstrap message");
      record.before = before[0]; record.after = after.at(-1);
      await screenshot(page, "late-message-keeps-layout");
    });

    await scenario(browser, "empty-my-listings-one-create-action", { viewport: { width: 390, height: 844 }, authenticated: true, scheme: "light", message: shortMessage }, async ({ page, record }) => {
      await page.goto(`${fixture.origin}/listings`);
      await expect(page.getByText("لا توجد إعلانات", { exact: true })).toBeVisible();
      const create = page.getByRole("button", { name: "إنشاء إعلان", exact: true });
      await expect(create).toHaveCount(1);
      await expect(create).toBeVisible();
      record.createAction = await create.boundingBox();
      assert.ok(record.createAction.y < 100, "The retained create action belongs to the page header");
      await screenshot(page, "empty-my-listings-one-create-action");
      await page.getByRole("button", { name: "المنشورة", exact: true }).click();
      await expect(page.getByText("لا توجد إعلانات بهذه الحالة", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "عرض الكل", exact: true })).toBeVisible();
      await expect(create).toHaveCount(1);
      await page.getByRole("button", { name: "عرض الكل", exact: true }).click();
      await expect(page.getByText("لا توجد إعلانات", { exact: true })).toBeVisible();
      await create.click();
      await expect(page).toHaveURL(/\/create$/);
    });
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    const report = {
      boundary: "Local React Native Web with intercepted fixtures; no native-device or production verification",
      previewDirectory: process.env.EXPO_PREVIEW_DIR || "dist", finishedAt: new Date().toISOString(),
      passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length,
      results, screenshots, browserErrors: fixture.report.browserErrors,
      blockedRemote: fixture.report.blockedRemote, unexpectedApi: fixture.report.unexpectedApi,
    };
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed, browserErrors: report.browserErrors.length, blockedRemote: report.blockedRemote.length, unexpectedApi: report.unexpectedApi.length, output }, null, 2));
    if (report.failed || report.browserErrors.length || report.blockedRemote.length || report.unexpectedApi.length) process.exitCode = 1;
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
