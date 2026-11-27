/* Local React Native Web evidence for the marketplace toolbar.
 * Prerequisite: root's completed web export in dist. Run with:
 * node tests/market-toolbar-browser.cjs
 * All inventory is intercepted fixture data; this never writes to production.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect } = require("@playwright/test");
const fixture = require("./browser-smoke.cjs");
const catalog = require("../src/core/market-catalog.json");

const inputMode = process.env.TOOLBAR_TOUCH === "1" ? "touch" : "mouse";
const output = path.resolve(__dirname, process.env.TOOLBAR_OUTPUT_DIR || `../.data/toolbar-review${inputMode === "touch" ? "-touch" : ""}`);
const results = [];
const evidence = [];
const cars = catalog.categories.find(category => category.id === "cars");
const toyota = cars.options.find(option => option.id === "toyota");
const camry = cars.carModels.toyota.find(model => model.id === "camry");
const rowLabels = ["تصنيفات السوق", "التصنيفات الفرعية", "تفريعات التصنيف", "تفريعات الخيار"];
const cardTitle = index => `Toolbar fixture ${String(index).padStart(2, "0")}`;
const records = Array.from({ length: 40 }, (_, index) => ({
  ...fixture.listing,
  id: `toolbar-fixture-${index + 1}`,
  title: cardTitle(index + 1),
  price: 10000 + index,
  images: [],
}));

const json = (route, body) => route.fulfill({
  contentType: "application/json",
  headers: {
    "Access-Control-Allow-Origin": fixture.origin,
    "Access-Control-Allow-Headers": "Accept,Content-Type,Authorization,Idempotency-Key,X-Souq-Hamad-Commission-Agreement",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Cache-Control": "no-store",
  },
  body: JSON.stringify(body),
});

async function inventory(context, { holdPage2 = false, shortFeed = false, deferBootstrap = false } = {}) {
  const state = { requests: [], active: 0, maxActive: 0, holdPage2, pendingRelease: null };
  let releaseBootstrap;
  state.releaseBootstrap = message => { state.siteMessage = message; releaseBootstrap?.(); };
  if (deferBootstrap) await context.route("**/api/mobile/bootstrap*", async route => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    if (!state.siteMessage) await new Promise(resolve => { releaseBootstrap = resolve; });
    return json(route, {
      categories: catalog.categories, cities: catalog.cities, policies: catalog.policies,
      limits: { maxListingImages: 8, maxImageBytes: 12582912, maxProfileImageBytes: 4194304, maxListingsPerSeller: 100 },
      auth: { google: true, apple: false }, policyVersions: {}, attributes: catalog.attributes,
      siteMessage: { message: state.siteMessage, type: "info", expiresAt: null },
    });
  });
  // The general smoke fixture emits ad_updated on every reconnect. Those
  // synthetic invalidations are unrelated to toolbar/pagination interactions.
  await context.route("**/api/realtime/stream*", route => route.request().method() === "OPTIONS"
    ? route.fallback()
    : route.fulfill({ contentType: "text/event-stream", headers: { "Access-Control-Allow-Origin": fixture.origin }, body: ": toolbar fixture has no realtime updates\n\n" }));
  // route.fulfill closes its response, which would itself force the app's
  // reconnect reconciliation every two seconds. Keep the browser-only fixture
  // stream open without events, as an idle healthy SSE connection would be.
  await context.addInitScript(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname !== "/api/realtime/stream") return originalFetch(input, init);
      let streamController;
      const stream = new ReadableStream({ start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode(": idle toolbar fixture\n\n"));
      } });
      init?.signal?.addEventListener("abort", () => { try { streamController.close(); } catch { /* already closed */ } }, { once: true });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    };
  });
  await context.route("**/api/marketplace/listings**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/marketplace/listings" || request.method() === "OPTIONS") return route.fallback();
    assert.equal(request.method(), "GET", "Toolbar fixture inventory must remain read-only");
    const page = Number(url.searchParams.get("page"));
    const entry = { params: Object.fromEntries(url.searchParams), startedAt: Date.now(), page };
    state.requests.push(entry);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      assert.ok(page === 1 || page === 2, `Unexpected inventory page ${page}`);
      if (page === 2 && state.holdPage2) await new Promise(resolve => { state.pendingRelease = resolve; });
      // Page two deliberately repeats page one's last ID. The public feed must
      // keep one card for it while retaining all sixteen new records.
      await json(route, {
        listings: shortFeed ? records.slice(0, 1) : page === 1 ? records.slice(0, 24) : [records[23], ...records.slice(24)],
        pagination: { page, limit: 24, hasMore: !shortFeed && page === 1, nextPage: !shortFeed && page === 1 ? 2 : null },
      });
      entry.finishedAt = Date.now();
    } finally { state.active--; }
  });
  state.release = () => {
    state.holdPage2 = false;
    state.pendingRelease?.();
    state.pendingRelease = null;
  };
  return state;
}

// Find the actual DOM scroll port even when RN places the test ID on an
// enclosing FlatList host. No React internals or application state are read.
async function scrollPort(page, action, value) {
  return page.getByTestId("market-feed").evaluate((root, { action, value }) => {
    const nodes = [root, ...root.querySelectorAll("div")];
    const node = nodes.find(element => {
      const style = getComputedStyle(element);
      return /auto|scroll/.test(style.overflowY) && element.clientHeight > 100 && element.scrollHeight > element.clientHeight + 5;
    });
    if (!node) throw new Error("market-feed has no vertical DOM scroll port");
    if (action === "set") node.scrollTop = value;
    if (action === "bottom") node.scrollTop = node.scrollHeight;
    return { offset: node.scrollTop, height: node.clientHeight, contentHeight: node.scrollHeight };
  }, { action, value });
}

async function advanceFeed(page, targetOffset) {
  // FlatList discovers further cells in batches. Revisit the requested offset
  // as its content extent grows rather than assuming the initial DOM contains
  // the complete first page.
  await expect.poll(async () => {
    const current = await scrollPort(page, "set", targetOffset);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return current.offset;
  }, { timeout: 10000, intervals: [48, 80, 120] }).toBeGreaterThanOrEqual(targetOffset - 3);
  await settle(page);
}

async function reachPageTwo(page, state) {
  await expect.poll(async () => {
    await scrollPort(page, "bottom");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return state.requests.filter(request => request.page === 2).length;
  }, { timeout: 10000, intervals: [64, 100, 160] }).toBe(1);
}

async function geometry(page) {
  return page.evaluate(labels => {
    const panel = document.querySelector('[data-testid="market-panel"]');
    const panelBox = panel.getBoundingClientRect();
    const panelTop = panelBox.top + parseFloat(getComputedStyle(panel).borderTopWidth);
    const rectangle = (element, clipTop = -Infinity) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const top = Math.max(box.y, clipTop);
      return { x: box.x, y: top, width: box.width, height: Math.max(0, box.bottom - top), bottom: box.bottom };
    };
    const toolbar = document.querySelector('[data-testid="market-toolbar"]');
    const tools = document.querySelector('[data-testid="market-toolbar-tools"]');
    const categories = document.querySelector('[data-testid="market-categories"]');
    const first = document.querySelector('[role="button"][aria-label="Toolbar fixture 01"]');
    const clip = categories?.getBoundingClientRect();
    const visibleRows = labels.filter(label => {
      const row = categories?.querySelector(`[aria-label="${label}"]`);
      if (!row || row.closest('[aria-hidden="true"]')) return false;
      const box = row.getBoundingClientRect();
      return box.height > 0 && box.bottom > clip.top + 2 && box.top < clip.bottom - 2;
    });
    const toolbarStyle = getComputedStyle(toolbar);
    const toolsTop = panelTop + parseFloat(toolbarStyle.borderTopWidth) + parseFloat(toolbarStyle.paddingTop);
    return { toolbar: rectangle(toolbar, panelTop), tools: rectangle(tools, toolsTop), categories: rectangle(categories), first: rectangle(first), visibleRows };
  }, rowLabels);
}

// Capture every presented frame in the page, rather than sampling only after
// Playwright input calls. A toolbar can end in the right place while still
// resizing the scroll content, clamping it, or moving cards during the drag.
async function beginMotion(page, anchorTitle) {
  await page.evaluate(anchorTitle => {
    const feed = document.querySelector('[data-testid="market-feed"]');
    const port = [feed, ...feed.querySelectorAll("div")].find(element => {
      const style = getComputedStyle(element);
      return /auto|scroll/.test(style.overflowY) && element.clientHeight > 100 && element.scrollHeight > element.clientHeight + 5;
    });
    if (!port) throw new Error("No market scroll port for frame capture");
    const toolbar = document.querySelector('[data-testid="market-toolbar"]');
    const tools = document.querySelector('[data-testid="market-toolbar-tools"]');
    const panel = document.querySelector('[data-testid="market-panel"]');
    const first = feed.querySelector('[role="button"][aria-label="Toolbar fixture 01"]');
    const anchor = anchorTitle && [...feed.querySelectorAll('[role="button"]')].find(element => element.getAttribute("aria-label") === anchorTitle);
    const motion = { active: true, frames: [] };
    globalThis.__marketMotion = motion;
    globalThis.__marketScrollCommands = [];
    if (!port.__marketScrollAudit) {
      port.__marketScrollAudit = true;
      for (const name of ["scroll", "scrollTo"]) {
        const original = port[name].bind(port);
        port[name] = (...args) => {
          if (globalThis.__marketMotion?.active) globalThis.__marketScrollCommands.push({ command: name, args, time: performance.now() });
          return original(...args);
        };
      }
      let prototype = port;
      let descriptor;
      while (prototype && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
        prototype = Object.getPrototypeOf(prototype);
      }
      if (!descriptor?.get || !descriptor?.set) throw new Error("No native DOM scrollTop accessor for scroll-command audit");
      Object.defineProperty(port, "scrollTop", {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) {
          if (globalThis.__marketMotion?.active) globalThis.__marketScrollCommands.push({ command: "scrollTop", value, time: performance.now() });
          descriptor.set.call(this, value);
        },
      });
    }
    const capture = time => {
      if (!motion.active) return;
      const panelTop = panel.getBoundingClientRect().top + parseFloat(getComputedStyle(panel).borderTopWidth);
      const toolbarStyle = getComputedStyle(toolbar);
      const toolsTop = panelTop + parseFloat(toolbarStyle.borderTopWidth) + parseFloat(toolbarStyle.paddingTop);
      const toolsBox = tools.getBoundingClientRect();
      motion.frames.push({
        time,
        toolbarBottom: toolbar.getBoundingClientRect().bottom,
        toolsHeight: Math.max(0, toolsBox.bottom - Math.max(toolsBox.top, toolsTop)),
        toolbarLayoutHeight: toolbar.clientHeight,
        toolsLayoutHeight: tools.clientHeight,
        firstY: first?.isConnected ? first.getBoundingClientRect().y : null,
        anchorY: anchor?.isConnected ? anchor.getBoundingClientRect().y : null,
        offset: port.scrollTop,
        contentHeight: port.scrollHeight,
        viewportHeight: port.clientHeight,
      });
      requestAnimationFrame(capture);
    };
    requestAnimationFrame(capture);
  }, anchorTitle);
}

async function endMotion(page) {
  return page.evaluate(() => {
    globalThis.__marketMotion.active = false;
    return globalThis.__marketMotion.frames;
  });
}

async function scrollCommands(page) {
  return page.evaluate(() => globalThis.__marketScrollCommands);
}

function assertNativeCardMotion(frames, description) {
  const visible = frames.filter(frame => frame.firstY != null);
  assert.ok(visible.length > 8, `${description}: need continuous first-card/native-offset evidence`);
  const initial = visible[0].firstY + visible[0].offset;
  for (const frame of visible) {
    assert.ok(Math.abs(frame.firstY + frame.offset - initial) <= 3,
      `${description}: toolbar motion must not add displacement to native card scrolling`);
  }
  return { frames: visible.length, maximumExtraDisplacement: Math.max(...visible.map(frame => Math.abs(frame.firstY + frame.offset - initial))) };
}

function spread(frames, field) {
  const values = frames.map(frame => frame[field]).filter(value => typeof value === "number");
  assert.ok(values.length > 8, `Need continuous frame evidence for ${field}`);
  return Math.max(...values) - Math.min(...values);
}

function assertFixedContent(frames, description) {
  assert.ok(spread(frames, "toolsHeight") > 30, `${description}: toolbar must actually move`);
  assert.ok(spread(frames, "contentHeight") <= 2, `${description}: toolbar motion must not resize feed content (${spread(frames, "contentHeight")}px)`);
  assert.ok(spread(frames, "viewportHeight") <= 1, `${description}: toolbar motion must not resize the feed viewport`);
  assert.ok(spread(frames, "toolbarLayoutHeight") <= 1, `${description}: the floating toolbar must slide without relaying out its native height`);
  assert.ok(spread(frames, "toolsLayoutHeight") <= 1, `${description}: the upper tools must keep a fixed native layout height while sliding`);
}

function assertCalmAutomaticMotion(frames, description, expandedHeight, firstCardGap) {
  assert.ok(frames.length > 8, `${description}: need continuous automatic-motion samples`);
  let movingFrames = 0;
  let maximumObservedSpeed = 0;
  let geometryCatchups = 0;
  for (const frame of frames.filter(frame => frame.firstY != null)) {
    assert.ok(frame.firstY - frame.toolbarBottom <= firstCardGap + 5,
      `${description}: returning to the first result must not leave an extra gap above it`);
  }
  for (let index = 1; index < frames.length; index++) {
    const elapsed = frames[index].time - frames[index - 1].time;
    if (elapsed <= 0) continue;
    const distance = Math.abs(frames[index].toolsHeight - frames[index - 1].toolsHeight);
    if (distance < 0.25) continue;
    movingFrames++;
    const previousCollapse = expandedHeight - frames[index - 1].toolsHeight;
    const currentCollapse = expandedHeight - frames[index].toolsHeight;
    const geometryCatchup = frames[index].toolsHeight > frames[index - 1].toolsHeight &&
      previousCollapse > frames[index].offset + 1 &&
      currentCollapse <= frames[index].offset + 1 &&
      frames[index].offset <= expandedHeight + 1;
    // Allow a little DOM rounding/commit timing noise while still rejecting
    // the old one-frame jumps from directly following every scroll delta.
    // When a fast reverse reaches the first result, the visible tools cannot
    // stay behind its scroll offset: that would leave a gap above the card.
    // This exception only permits that opening correction near the feed start.
    if (distance > 450 * elapsed / 1000 + 2 && geometryCatchup) {
      geometryCatchups++;
      continue;
    }
    const speed = Math.max(0, distance - 2) * 1000 / elapsed;
    maximumObservedSpeed = Math.max(maximumObservedSpeed, speed);
    assert.ok(distance <= 450 * elapsed / 1000 + 2,
      `${description}: automatic tools must descend/ascend calmly (${distance.toFixed(2)}px in ${elapsed.toFixed(2)}ms)`);
  }
  assert.ok(movingFrames > 4, `${description}: must show a gradual transition across several frames`);
  return { movingFrames, maximumObservedSpeed, geometryCatchups };
}

async function settle(page) {
  // Wait for geometry to stop changing, independently of animation duration.
  let previous;
  let consecutive = 0;
  await expect.poll(async () => {
    const current = await geometry(page);
    const position = [current.toolbar?.height, current.tools?.height, current.categories?.y, current.first?.y];
    const stable = previous && position.every((value, index) => value == null && previous[index] == null || Math.abs(value - previous[index]) < 0.5);
    consecutive = stable ? consecutive + 1 : 0;
    previous = position;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    return consecutive;
  }, { timeout: 7000, intervals: [32, 48, 64] }).toBeGreaterThanOrEqual(3);
}

async function toolbarGutters(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="market-panel"]');
    const toolbar = document.querySelector('[data-testid="market-toolbar"]');
    if (!panel || !toolbar) throw new Error("Marketplace panel/toolbar missing for gutter regression");
    const outer = panel.getBoundingClientRect();
    const naturalBox = toolbar.getBoundingClientRect();
    const panelStyle = getComputedStyle(panel);
    const chromeStyle = getComputedStyle(toolbar);
    const left = Math.ceil(outer.left + parseFloat(panelStyle.borderLeftWidth));
    const right = Math.floor(outer.right - parseFloat(panelStyle.borderRightWidth));
    const top = Math.ceil(outer.top + parseFloat(panelStyle.borderTopWidth));
    const box = { ...naturalBox.toJSON(), top: Math.max(naturalBox.top, top) };
    const bottom = Math.ceil(box.bottom);
    const radius = Math.ceil(parseFloat(chromeStyle.borderTopLeftRadius));
    const regions = [];
    const add = (name, x, y, width, height) => { if (width > 0 && height > 0) regions.push({ name, x, y, width, height }); };
    add("above-toolbar", left, top, right - left, Math.floor(box.top) - top);
    add("left-gutter", left, Math.floor(box.top), Math.floor(box.left) - left, bottom - Math.floor(box.top));
    add("right-gutter", Math.ceil(box.right), Math.floor(box.top), right - Math.ceil(box.right), bottom - Math.floor(box.top));
    add("upper-left-corner", Math.floor(box.left), Math.floor(box.top), radius, radius);
    add("upper-right-corner", Math.ceil(box.right) - radius, Math.floor(box.top), radius, radius);
    const hits = [];
    let sampledPoints = 0;
    for (const region of regions) {
      for (let y = region.y + 0.5; y < region.y + region.height; y += 2) {
        for (let x = region.x + 0.5; x < region.x + region.width; x += 3) {
          sampledPoints++;
          const hit = document.elementFromPoint(x, y)?.closest('[role="button"][aria-label^="Toolbar fixture "]');
          if (hit) hits.push({ region: region.name, x, y, title: hit.getAttribute("aria-label") });
        }
      }
    }
    return { regions, hits, sampledPoints, clip: { x: Math.floor(outer.x), y: Math.floor(outer.y), width: Math.ceil(outer.right) - Math.floor(outer.x), height: bottom - Math.floor(outer.y) } };
  });
}

async function gutterPixels(page, geometry) {
  // Repaint only fixture cards in two strongly contrasting colors. An opaque
  // toolbar surround must paint identical protected pixels in both captures,
  // even if it intercepts pointer events while remaining visually transparent.
  const selector = '[data-testid="market-feed"] [role="button"][aria-label^="Toolbar fixture "]';
  const css = color => `${selector}, ${selector} * { background-color: ${color} !important; color: ${color} !important; border-color: ${color} !important; }`;
  const style = await page.addStyleTag({ content: css("rgb(239,0,239)") });
  let first;
  let second;
  try {
    first = await page.screenshot({ clip: geometry.clip });
    await style.evaluate((node, content) => { node.textContent = content; }, css("rgb(0,239,239)"));
    second = await page.screenshot({ clip: geometry.clip });
  } finally { await style.evaluate(node => node.remove()); }
  return page.evaluate(async ({ first, second, regions, clip }) => {
    const pixels = async base64 => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width };
    };
    const [a, b] = await Promise.all([pixels(first), pixels(second)]);
    let changedPixels = 0;
    let testedPixels = 0;
    const examples = [];
    for (const region of regions) {
      for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
          const index = ((y - clip.y) * a.width + x - clip.x) * 4;
          testedPixels++;
          if (Math.max(...[0, 1, 2].map(channel => Math.abs(a.data[index + channel] - b.data[index + channel]))) <= 1) continue;
          changedPixels++;
          if (examples.length < 8) examples.push({ region: region.name, x, y, first: [...a.data.slice(index, index + 3)], second: [...b.data.slice(index, index + 3)] });
        }
      }
    }
    return { changedPixels, testedPixels, examples };
  }, { first: first.toString("base64"), second: second.toString("base64"), regions: geometry.regions, clip: geometry.clip });
}

async function assertGuttersOpaque(page, name, record) {
  const gutters = await toolbarGutters(page);
  const pixels = await gutterPixels(page, gutters);
  record.occlusion.push({ name, ...gutters, pixels });
  assert.ok(gutters.sampledPoints > 100, "Regression must sample the full toolbar surround");
  assert.equal(gutters.hits.length, 0, `${name}: listing cards must not receive hits above/around the toolbar: ${JSON.stringify(gutters.hits.slice(0, 4))}`);
  assert.equal(pixels.changedPixels, 0, `${name}: fixture-card paint must not show through toolbar gutters/corners: ${JSON.stringify(pixels.examples)}`);
  await page.screenshot({ path: path.join(output, `${name}.png`), clip: gutters.clip });
}

async function pan(page, start, delta, { samples, steps = 22, onFrame, onRelease, settleAfter = true } = {}) {
  if (process.env.TOOLBAR_TOUCH === "1") return touchPan(page, start, delta, samples, onFrame, { onRelease, settleAfter });
  await page.mouse.move(start.x, start.y);
  assert.ok(await page.getByTestId("market-toolbar").evaluate((toolbar, point) => toolbar.contains(document.elementFromPoint(point.x, point.y)), start), "Manual gesture must start on the exposed toolbar");
  await page.mouse.down();
  try {
    for (let index = 1; index <= steps; index++) {
      await page.mouse.move(start.x + (delta.x || 0) * index / steps, start.y + (delta.y || 0) * index / steps);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      const frame = samples || onFrame ? await geometry(page) : null;
      if (samples) samples.push(frame);
      if (onFrame) await onFrame(frame, index);
    }
  } finally { await page.mouse.up(); }
  if (onRelease) await onRelease();
  if (settleAfter) await settle(page);
}

async function touchPan(page, start, delta, samples, onFrame, { onRelease, settleAfter = true } = {}) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.evaluate(() => {
      globalThis.__toolbarTouchStart = null;
      document.addEventListener("touchstart", event => {
        const target = event.target instanceof Element ? event.target : event.target.parentElement;
        globalThis.__toolbarTouchStart = { insideToolbar: Boolean(target?.closest('[data-testid="market-toolbar"]')), tag: target?.tagName, label: target?.getAttribute("aria-label") };
      }, { once: true, capture: true });
    });
    const point = (x, y) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(start.x, start.y) });
    const touchStart = await page.evaluate(() => globalThis.__toolbarTouchStart);
    if (samples) samples.push({ touchStart });
    assert.ok(touchStart?.insideToolbar, "Touch gesture must actually target the exposed toolbar");
    for (let index = 1; index <= 20; index++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(start.x + (delta.x || 0) * index / 20, start.y + (delta.y || 0) * index / 20) });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      const frame = samples || onFrame ? await geometry(page) : null;
      if (samples) samples.push(frame);
      if (onFrame) await onFrame(frame, index);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    if (onRelease) await onRelease();
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await session.detach();
  }
  if (settleAfter) await settle(page);
}

async function touchFeedPan(page, deltaY) {
  const box = await page.getByTestId("market-feed").boundingBox();
  const start = { x: box.x + box.width * 0.65, y: box.y + box.height * 0.65 };
  assert.ok(await page.getByTestId("market-feed").evaluate((feed, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return feed.contains(hit) && !hit.closest('[data-testid="market-toolbar"]');
  }, start), "Feed touch must start on a card below the floating toolbar");
  const session = await page.context().newCDPSession(page);
  const point = y => [{ x: start.x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  try {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(start.y) });
    for (let index = 1; index <= 24; index++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(start.y + deltaY * index / 24) });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    // Hold before release to test direction-following without a browser fling
    // masking the deliberate next reverse drag.
    for (let index = 0; index < 12; index++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(start.y + deltaY) });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await session.detach();
  }
  await settle(page);
}

async function blankPan(page, direction, samples, onFrame) {
  const { toolbar, categories, tools } = await geometry(page);
  // The border/padding is part of the toolbar and has no interactive child.
  let start = { x: toolbar.x + 3, y: direction === "up" ? categories.bottom - 5 : toolbar.y + Math.min(18, toolbar.height / 2) };
  if (process.env.TOOLBAR_TOUCH === "1") {
    // Chromium adjusts touch targets on the three-pixel chrome edge toward
    // the underlying scroll port. Use a full visible chip for real touch
    // input; the default mouse case continues to exercise bare chrome.
    start = await page.getByTestId("market-categories").evaluate(root => {
      const clip = root.getBoundingClientRect();
      const chip = [...root.querySelectorAll('[role="button"]')].find(element => {
        const box = element.getBoundingClientRect();
        return !element.closest('[aria-hidden="true"]') && box.x >= clip.x && box.right <= clip.right && box.y >= clip.y && box.bottom <= clip.bottom;
      });
      if (!chip) throw new Error("No fully visible category chip for manual touch input");
      const box = chip.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
  }
  const distance = Math.max(190, tools.height + 35);
  if (samples) samples.push({ gestureStart: { ...start }, target: await page.evaluate(point => document.elementsFromPoint(point.x, point.y).slice(0, 5).map(element => ({ testID: element.getAttribute("data-testid"), label: element.getAttribute("aria-label"), pointerEvents: getComputedStyle(element).pointerEvents, touchAction: getComputedStyle(element).touchAction })), start) });
  await pan(page, start, { y: direction === "up" ? -distance : distance }, { samples, onFrame });
}

async function home(page) {
  await page.goto(fixture.origin);
  await expect(page.getByTestId("market-toolbar")).toBeVisible();
  await expect(page.getByRole("button", { name: cardTitle(1), exact: true })).toBeVisible();
  // App content mounts beneath the timed welcome overlay. Geometry/visibility
  // alone do not mean it can receive gestures, even during the overlay fade.
  await expect(page.getByRole("progressbar", { name: "جارٍ تشغيل التطبيق", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("شعار سوق حمد", { exact: true })).toHaveCount(0);
  await settle(page);
  const topSpacing = await page.getByTestId("market-panel").evaluate(panel => {
    const header = panel.previousElementSibling;
    const toolbar = panel.querySelector('[data-testid="market-toolbar"]');
    if (!header || !toolbar) throw new Error("Marketplace header/toolbar missing for top-spacing regression");
    const panelBox = panel.getBoundingClientRect();
    return {
      headerToPanel: panelBox.top - header.getBoundingClientRect().bottom,
      panelToToolbar: toolbar.getBoundingClientRect().top - panelBox.top - parseFloat(getComputedStyle(panel).borderTopWidth),
    };
  });
  assert.ok(Math.abs(topSpacing.headerToPanel) <= 1, `Marketplace panel must meet the header without an extra top gap: ${topSpacing.headerToPanel}px`);
  assert.ok(Math.abs(topSpacing.panelToToolbar) <= 1, `Toolbar must start at the panel content edge without extra top padding: ${topSpacing.panelToToolbar}px`);
  const initial = await geometry(page);
  assert.ok(initial.tools.height > 70, "Upper tools must start expanded");
  assert.ok(Math.abs(initial.first.y - initial.toolbar.bottom) <= 1.5,
    `The first card must meet the toolbar without an extra spacer: ${initial.first.y - initial.toolbar.bottom}px`);
  return initial;
}

function initialInventoryReads(state, record) {
  const pages = state.requests.map(request => request.page);
  // Connecting SSE reconciles the first snapshot. Capture those startup reads
  // before gestures so the assertions below detect requests caused by motion.
  assert.ok(pages.length >= 1 && pages.length <= 2, "Startup must contain only its initial read and optional connection reconciliation");
  assert.ok(pages.every(page => page === 1), "Startup must not fetch another page");
  assert.equal(state.active, 0, "Startup reads must finish before testing gestures");
  record.initialInventoryPages = pages;
  return pages;
}

function assertTopTracks(samples, initialGap) {
  const usable = samples.filter(sample => sample.first && sample.toolbar && sample.categories);
  assert.ok(usable.length > 8, "Need geometry from the in-progress manual drag");
  const toolHeights = new Set(usable.map(sample => Math.round(sample.tools.height)));
  assert.ok(toolHeights.size > 4, "Manual drag must reveal intermediate toolbar heights");
  for (const sample of usable) {
    const gap = sample.first.y - sample.toolbar.bottom;
    assert.ok(Math.abs(gap - initialGap) <= 5, `First card must track toolbar without a gap/jump: initial gap=${initialGap}, observed=${gap}`);
  }
}

async function currentRows(page) { return (await geometry(page)).visibleRows; }
async function expectRows(page, labels) { await expect.poll(() => currentRows(page)).toEqual(labels); }

async function selectCarModel(page, state) {
  const categories = page.getByTestId("market-categories");
  await categories.getByRole("button", { name: cars.group, exact: true }).click();
  await expectRows(page, rowLabels.slice(0, 2));
  await categories.getByRole("button", { name: cars.label, exact: true }).click();
  await expectRows(page, rowLabels.slice(1, 3));
  await categories.getByRole("button", { name: toyota.label, exact: true }).click();
  await expectRows(page, rowLabels.slice(2, 4));
  await categories.getByRole("button", { name: camry.label, exact: true }).click();
  await expect.poll(() => state.requests.findLast(request => request.params.carModel)?.params).toMatchObject({
    category: "cars", categoryOption: "toyota", carModel: "camry", page: "1",
  });
  await settle(page);
  const selected = await geometry(page);
  assert.ok(Math.abs(selected.first.y - selected.toolbar.bottom) <= 1.5,
    "Changing category branches must retain the first-card edge without an extra spacer");
}

async function scenario(browser, name, callback, options) {
  if (process.env.TOOLBAR_CASE && !name.includes(process.env.TOOLBAR_CASE)) return;
  const { page, context } = await fixture.fixtureContext(browser, true, name);
  const state = await inventory(context, options);
  const record = { name, requests: state.requests, samples: [] };
  if (process.env.TOOLBAR_TRACE === "1") await page.addInitScript(() => {
    globalThis.__toolbarDOMEvents = [];
    for (const type of ["mousedown", "mousemove", "mouseup", "pointerdown", "pointermove", "pointerup", "touchstart", "touchmove", "touchend", "touchcancel", "dragstart"]) {
      document.addEventListener(type, event => {
        if ((type === "mousemove" || type === "pointermove") && !event.buttons) return;
        globalThis.__toolbarDOMEvents.push({ type, buttons: event.buttons, x: event.clientX, y: event.clientY, touches: event.touches?.length,
          path: event.composedPath().filter(node => node instanceof Element).slice(0, 8).map(node => ({ tag: node.tagName, testID: node.getAttribute("data-testid"), label: node.getAttribute("aria-label"), responder: node.__reactResponderId })) });
      }, true);
    }
  });
  evidence.push(record);
  try {
    await callback({ page, context, state, record });
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
    results.push({ name, passed: false, error: error.stack || String(error) });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    if (process.env.TOOLBAR_TRACE === "1") {
      record.domEvents = await page.evaluate(() => globalThis.__toolbarDOMEvents).catch(() => []);
      record.responderAttachment = await page.getByTestId("market-toolbar").evaluate(node => {
        const key = Object.keys(node).find(key => key.startsWith("__reactProps"));
        const props = key ? node[key] : {};
        return { responder: node.__reactResponderId, reactPropsKey: key, keys: Object.keys(props), ancestors: [...(function* () { for (let parent = node; parent; parent = parent.parentElement) yield parent; })()].map(element => ({ testID: element.getAttribute("data-testid"), responder: element.__reactResponderId })) };
      }).catch(error => ({ error: error.message }));
    }
    state.release();
    record.maxConcurrentRequests = state.maxActive;
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = fixture.createStaticServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(8181, "127.0.0.1", resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    await scenario(browser, "top-manual-card-tracking", async ({ page, record }) => {
      const initial = await home(page);
      await page.screenshot({ path: path.join(output, "market-toolbar-expanded.png"), fullPage: true });
      assert.equal(Math.round(initial.categories.height), 40, "Unselected market retains one basic category row");
      await expectRows(page, [rowLabels[0]]);
      const collapse = [];
      record.samples.push({ action: "collapse", geometry: collapse });
      await beginMotion(page);
      await blankPan(page, "up", collapse);
      const collapseFrames = await endMotion(page);
      record.collapseFrames = collapseFrames;
      assertFixedContent(collapseFrames, "Top manual collapse");
      for (const frame of collapseFrames.filter(frame => frame.firstY != null)) {
        assert.ok(Math.abs(frame.firstY - frame.toolbarBottom - (initial.first.y - initial.toolbar.bottom)) <= 5, "First card must follow the toolbar on every presented manual-drag frame");
      }
      assertTopTracks(collapse, initial.first.y - initial.toolbar.bottom);
      const closed = await geometry(page);
      assert.ok(closed.tools.height <= 2, "Manual upward toolbar drag must fully collapse upper tools");
      assert.equal(Math.round(closed.categories.height), 40);
      await expectRows(page, [rowLabels[0]]);
      assert.ok(Math.abs((await scrollPort(page)).offset - initial.tools.height) <= 3, "An explicit manual top drag must keep the first card attached to the tools");
      await page.screenshot({ path: path.join(output, "market-toolbar-collapsed.png"), fullPage: true });
      const expand = [];
      record.samples.push({ action: "expand", geometry: expand });
      await beginMotion(page);
      await blankPan(page, "down", expand);
      record.expandFrames = await endMotion(page);
      assertFixedContent(record.expandFrames, "Top manual expansion");
      assertTopTracks(expand, initial.first.y - initial.toolbar.bottom);
      const opened = await geometry(page);
      assert.ok(Math.abs(opened.tools.height - initial.tools.height) <= 2, "Manual downward toolbar drag must restore tools");
      assert.ok(Math.abs(opened.first.y - initial.first.y) <= 3, "First card must return with the expanded toolbar");
      assert.ok((await scrollPort(page)).offset <= 1);
      const viewport = page.viewportSize();
      await page.screenshot({ path: path.join(output, "market-bottom-navigation.png"), clip: { x: 0, y: viewport.height - 150, width: viewport.width, height: 150 } });
    });

    await scenario(browser, "short-feed-first-card-tracking", async ({ page, record }) => {
      const initial = await home(page);
      await beginMotion(page);
      await blankPan(page, "up");
      record.collapseFrames = await endMotion(page);
      assertFixedContent(record.collapseFrames, "Short-feed manual collapse");
      assert.ok((await geometry(page)).tools.height <= 2);
      for (const frame of record.collapseFrames) {
        assert.ok(Math.abs(frame.firstY - frame.toolbarBottom - (initial.first.y - initial.toolbar.bottom)) <= 5, "A single result must track the toolbar without leaving a gap");
      }
      await blankPan(page, "down");
      assert.ok(Math.abs((await geometry(page)).first.y - initial.first.y) <= 3);
      assert.ok((await scrollPort(page)).offset <= 1);
    }, { shortFeed: true });

    await scenario(browser, "reduced-motion-settle-and-focus", async ({ page, record }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const initial = await home(page);
      const button = await page.getByRole("button", { name: "أنشئ إعلانك مع حمد", exact: true }).boundingBox();
      await pan(page, { x: button.x + button.width / 2, y: button.y + button.height / 2 }, { y: -90 });
      const closed = await geometry(page);
      assert.ok(closed.tools.height <= 2, "Partial upward drag must settle closed with reduced motion");
      assert.ok(Math.abs(closed.first.y - closed.toolbar.bottom - (initial.first.y - initial.toolbar.bottom)) <= 3, "Instant settle must synchronize the first card before ending the manual gesture");
      // Focus exercises the lock/open path directly, independently of a pan.
      await page.getByLabel("البحث في السوق", { exact: true }).evaluate(element => element.focus());
      await expect.poll(async () => (await geometry(page)).tools.height).toBeGreaterThan(initial.tools.height - 2);
      await settle(page);
      record.opened = await geometry(page);
      assert.ok(Math.abs(record.opened.first.y - initial.first.y) <= 3, "Instant focus expansion must restore the first card");
      assert.ok((await scrollPort(page)).offset <= 1);
    });

    await scenario(browser, "button-input-and-category-arbitration", async ({ page, record }) => {
      const initial = await home(page);
      const search = page.getByLabel("البحث في السوق", { exact: true });
      await search.fill("toolbar input");
      await expect(search).toHaveValue("toolbar input");
      await search.fill("");
      await search.evaluate(element => element.blur());
      await settle(page);
      const create = page.getByRole("button", { name: "أنشئ إعلانك مع حمد", exact: true });
      const createBox = await create.boundingBox();
      const buttonDrag = [];
      record.samples.push({ action: "button-drag", geometry: buttonDrag });
      // Cross the 50% settle boundary after the responder's activation slop.
      await pan(page, { x: createBox.x + createBox.width / 2, y: createBox.y + createBox.height / 2 }, { y: -90 }, { samples: buttonDrag });
      await expect(page).toHaveURL(fixture.origin + "/");
      assert.ok((await geometry(page)).tools.height < initial.tools.height - 20, "Vertical drag starting on a button must move the toolbar");
      await blankPan(page, "up");
      const categories = page.getByTestId("market-categories");
      const chip = categories.getByRole("button", { name: cars.group, exact: true });
      const chipBox = await chip.boundingBox();
      const before = await geometry(page);
      await pan(page, { x: Math.min(chipBox.x + chipBox.width / 2, before.categories.x + before.categories.width - 15), y: chipBox.y + chipBox.height / 2 }, { y: 200 });
      assert.ok((await geometry(page)).tools.height > initial.tools.height - 3, "Vertical drag starting on a category chip must expand the toolbar");
      assert.equal(chipBox.height > 0, true);
      await expectRows(page, [rowLabels[0]]);
      const horizontalBefore = await categories.getByLabel(rowLabels[0], { exact: true }).evaluate(root => {
        const nodes = [root, ...root.querySelectorAll("div")];
        const node = nodes.find(element => /auto|scroll/.test(getComputedStyle(element).overflowX) && element.scrollWidth > element.clientWidth + 4);
        if (!node) throw new Error("Category row has no horizontal scroll port");
        return { left: node.scrollLeft, width: node.clientWidth, content: node.scrollWidth };
      });
      const categoryBox = (await geometry(page)).categories;
      const toolsBefore = (await geometry(page)).tools.height;
      await touchPan(page, { x: categoryBox.x + categoryBox.width * 0.55, y: categoryBox.y + 20 }, { x: 130, y: 0 });
      const horizontalAfter = await categories.getByLabel(rowLabels[0], { exact: true }).evaluate(root => {
        const node = [root, ...root.querySelectorAll("div")].find(element => /auto|scroll/.test(getComputedStyle(element).overflowX) && element.scrollWidth > element.clientWidth + 4);
        return node.scrollLeft;
      });
      assert.ok(Math.abs(horizontalAfter - horizontalBefore.left) > 20, "Horizontal category touch drag must scroll the chip row");
      assert.ok(Math.abs((await geometry(page)).tools.height - toolsBefore) <= 2, "Horizontal chip scrolling must not collapse the parent toolbar");
      await expect(page).toHaveURL(fixture.origin + "/");
      record.horizontal = { before: horizontalBefore, after: horizontalAfter };
    });

    await scenario(browser, "category-hierarchy-and-feed-follow", async ({ page, state, record }) => {
      await home(page);
      await selectCarModel(page, state);
      const initial = await geometry(page);
      assert.equal(Math.round(initial.categories.height), 80);
      await blankPan(page, "up");
      assert.ok((await geometry(page)).tools.height <= 2);
      await expectRows(page, rowLabels.slice(2, 4));
      await blankPan(page, "down");
      const expanded = (await geometry(page)).tools.height;
      const frames = [];
      record.samples.push({ action: "feed-forward-and-reverse", geometry: frames });
      await beginMotion(page);
      const feedBox = await page.getByTestId("market-feed").boundingBox();
      await page.mouse.move(feedBox.x + feedBox.width / 2, feedBox.y + feedBox.height * 0.72);
      for (let index = 0; index < 14; index++) {
        await page.mouse.wheel(0, 18);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        frames.push(await geometry(page));
      }
      await settle(page);
      assert.ok((await geometry(page)).tools.height < 3, "Forward feed scrolling must collapse tools");
      assert.ok(frames.some(frame => frame.tools.height > 5 && frame.tools.height < expanded - 5), "Feed follow must include intermediate heights");
      await expectRows(page, rowLabels.slice(2, 4));
      const offsetBeforeReverse = (await scrollPort(page)).offset;
      assert.ok(offsetBeforeReverse > 20, "The feed should have advanced");
      for (let index = 0; index < 14; index++) {
        await page.mouse.wheel(0, -18);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        frames.push(await geometry(page));
      }
      await settle(page);
      assert.ok((await geometry(page)).tools.height >= expanded - 2, "A sustained reverse feed scroll must restore all tools smoothly");
      record.followFrames = await endMotion(page);
      assertFixedContent(record.followFrames, "Automatic feed follow");
      record.followScrollCommands = await scrollCommands(page);
      assert.deepEqual(record.followScrollCommands, [], "Automatic toolbar following must not issue competing list scroll commands");
      record.followCardMotion = assertNativeCardMotion(record.followFrames, "Automatic feed follow");
      record.followSpeed = assertCalmAutomaticMotion(record.followFrames, "Automatic feed follow", expanded, initial.first.y - initial.toolbar.bottom);
      // Once input stops, neither the toolbar nor the cards may continue an
      // alternating layout/scroll feedback loop.
      await beginMotion(page);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
      record.idleFrames = await endMotion(page);
      assert.ok(spread(record.idleFrames, "toolsHeight") <= 1, "Toolbar must stay still after feed input stops");
      assert.ok(spread(record.idleFrames, "offset") <= 1, "Feed must stay still after input stops");
      await expectRows(page, rowLabels.slice(2, 4));
      const last = state.requests.at(-1).params;
      assert.equal(last.carModel, "camry", "Header gestures must preserve selected model");
      assert.equal(last.categoryOption, "toyota");
      const optionsRow = page.getByTestId("market-categories").getByLabel(rowLabels[2], { exact: true });
      await optionsRow.getByRole("button", { name: toyota.label, exact: true }).click();
      await expectRows(page, rowLabels.slice(1, 3));
    });

    await scenario(browser, "stress-real-touch-feed-direction-and-idle", async ({ page, state, record }) => {
      const initial = await home(page);
      const initialPages = initialInventoryReads(state, record);
      await beginMotion(page);
      await touchFeedPan(page, -240);
      const advanced = await scrollPort(page);
      assert.ok(advanced.offset > 120, "A real card touch drag must advance the feed");
      assert.ok((await geometry(page)).tools.height <= 2, "Upward card touch drag must collapse the tools");
      await expectRows(page, [rowLabels[0]]);
      await touchFeedPan(page, 150);
      assert.ok((await scrollPort(page)).offset < advanced.offset - 70, "Reverse card touch drag must move toward earlier cards");
      assert.ok((await geometry(page)).tools.height > initial.tools.height - 20, "Downward card touch drag must reveal the tools");
      record.touchFrames = await endMotion(page);
      record.touchScrollCommands = await scrollCommands(page);
      assert.deepEqual(record.touchScrollCommands, [], "Actual card touch movement must remain native without forced list scroll commands");
      record.touchCardMotion = assertNativeCardMotion(record.touchFrames, "Actual card touch forward/reverse");
      assertFixedContent(record.touchFrames, "Actual card touch forward/reverse");
      record.touchSpeed = assertCalmAutomaticMotion(record.touchFrames, "Actual card touch forward/reverse", initial.tools.height, initial.first.y - initial.toolbar.bottom);
      await beginMotion(page);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
      record.idleFrames = await endMotion(page);
      assert.ok(spread(record.idleFrames, "toolsHeight") <= 1, "Tools must stop moving after the card touch is released");
      assert.ok(spread(record.idleFrames, "offset") <= 1, "Cards must stop moving after the card touch is released");
      assert.deepEqual(state.requests.map(request => request.page), initialPages, "Card gestures must not refetch or skip pages");
    });

    await scenario(browser, "stress-small-reversals-and-interrupted-settle", async ({ page, record }) => {
      const initial = await home(page);
      const button = await page.getByRole("button", { name: "أنشئ إعلانك مع حمد", exact: true }).boundingBox();
      await beginMotion(page);
      await pan(page, { x: button.x + button.width / 2, y: button.y + button.height / 2 }, { y: -85 }, { settleAfter: false });
      // Re-grab the categories while the first release is still settling.
      await blankPan(page, "down");
      record.interruptedFrames = await endMotion(page);
      assertFixedContent(record.interruptedFrames, "Interrupted top settle");
      for (const frame of record.interruptedFrames.filter(frame => frame.firstY != null)) {
        assert.ok(Math.abs(frame.firstY - frame.toolbarBottom - (initial.first.y - initial.toolbar.bottom)) <= 5, "Re-grabbing a moving toolbar must not detach the first card");
      }
      assert.ok((await geometry(page)).tools.height >= initial.tools.height - 2);
      await advanceFeed(page, 800);
      await blankPan(page, "down");
      const feed = await page.getByTestId("market-feed").boundingBox();
      await page.mouse.move(feed.x + feed.width / 2, feed.y + feed.height * 0.7);
      await beginMotion(page);
      for (let index = 0; index < 6; index++) {
        await page.mouse.wheel(0, 6);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.mouse.wheel(0, -6);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      record.reverseFrames = await endMotion(page);
      assert.ok(spread(record.reverseFrames, "toolsHeight") <= 1, "Alternating tiny scroll movements must not make the toolbar oscillate");
      assert.ok(spread(record.reverseFrames, "contentHeight") <= 2, "Small reversals must keep the feed content extent stable");
      await beginMotion(page);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
      record.idleFrames = await endMotion(page);
      assert.ok(spread(record.idleFrames, "toolsHeight") <= 1, "Tiny scroll reversals must not leave a toolbar oscillation");
      assert.ok(spread(record.idleFrames, "offset") <= 1, "Tiny scroll reversals must not leave feed motion");
    });

    await scenario(browser, "stress-collapsed-category-selection", async ({ page, state, record }) => {
      const initial = await home(page);
      await advanceFeed(page, 900);
      await blankPan(page, "up");
      assert.ok((await geometry(page)).tools.height <= 2);
      await beginMotion(page);
      await page.getByTestId("market-categories").getByRole("button", { name: cars.group, exact: true }).click();
      await expect.poll(() => state.requests.at(-1)?.params.categories).toBeTruthy();
      await expectRows(page, rowLabels.slice(0, 2));
      await settle(page);
      const selected = await geometry(page);
      record.selectionFrames = await endMotion(page);
      record.selected = selected;
      assert.ok(selected.tools.height <= 2, "Choosing a category from collapsed tools must retain the collapsed tools state");
      assert.ok(Math.abs(selected.first.y - selected.toolbar.bottom - (initial.first.y - initial.toolbar.bottom)) <= 5, "Filtered first card must begin below the retained categories without a gap");
      assert.ok((await scrollPort(page)).offset < 250, "A new category must reset a deep feed to its first results");
    });

    await scenario(browser, "stress-toolbar-height-change-during-settle", async ({ page, state, record }) => {
      const initial = await home(page);
      const button = await page.getByRole("button", { name: "أنشئ إعلانك مع حمد", exact: true }).boundingBox();
      await pan(page, { x: button.x + button.width / 2, y: button.y + button.height / 2 }, { y: -85 }, {
        onRelease: () => state.releaseBootstrap("رسالة السوق تصل أثناء طي الأدوات للاختبار فقط"),
      });
      await expect(page.getByText("رسالة السوق تصل أثناء طي الأدوات للاختبار فقط", { exact: true })).toHaveCount(1);
      await settle(page);
      record.afterResize = await geometry(page);
      assert.ok(record.afterResize.tools.height <= 2, "A measured tools-height change must not cancel a collapse halfway through settling");
      await advanceFeed(page, 700);
      const feed = await page.getByTestId("market-feed").boundingBox();
      await page.mouse.move(feed.x + feed.width / 2, feed.y + feed.height * 0.7);
      await page.mouse.wheel(0, -100);
      await settle(page);
      assert.ok((await geometry(page)).tools.height > 60, "Automatic follow must remain responsive after resizing during a manual release");
      assert.ok(initial.tools.height > 70);
    }, { deferBootstrap: true });

    await scenario(browser, "deep-manual-keeps-feed-anchor", async ({ page, record }) => {
      await home(page);
      await advanceFeed(page, 1400);
      // Begin expanded so both manual directions can be measured independently
      // of the collapse caused by moving into the deep feed.
      await blankPan(page, "down");
      const before = await geometry(page);
      const anchor = await page.getByTestId("market-feed").evaluate(root => {
        const toolbar = document.querySelector('[data-testid="market-toolbar"]').getBoundingClientRect();
        const element = [...root.querySelectorAll('[role="button"][aria-label^="Toolbar fixture "]')].find(card => {
          const box = card.getBoundingClientRect();
          return box.top >= toolbar.bottom + 3 && box.top < innerHeight - 220;
        });
        if (!element) throw new Error("No fully visible deep-feed fixture anchor");
        return { title: element.getAttribute("aria-label"), y: element.getBoundingClientRect().y };
      });
      const beforeOffset = (await scrollPort(page)).offset;
      await beginMotion(page, anchor.title);
      await blankPan(page, "up");
      record.collapseFrames = await endMotion(page);
      assertFixedContent(record.collapseFrames, "Deep manual collapse");
      assert.ok(spread(record.collapseFrames, "anchorY") <= 3, "Deep-feed card must remain anchored during every collapse frame");
      assert.ok(spread(record.collapseFrames, "offset") <= 2, "Deep manual collapse must not fight feed scrolling");
      const anchorY = await page.getByRole("button", { name: anchor.title, exact: true }).evaluate(element => element.getBoundingClientRect().y);
      const collapsedOffset = (await scrollPort(page)).offset;
      assert.ok(Math.abs(anchorY - anchor.y) <= 4, `Deep manual collapse must keep ${anchor.title} in place`);
      assert.ok(collapsedOffset > 800, "Manual header collapse must not reset a deep feed to zero");
      assert.ok((await geometry(page)).tools.height <= 2);
      await beginMotion(page, anchor.title);
      await blankPan(page, "down");
      record.expandFrames = await endMotion(page);
      assertFixedContent(record.expandFrames, "Deep manual expansion");
      assert.ok(spread(record.expandFrames, "anchorY") <= 3, "Deep-feed card must remain anchored during every expansion frame");
      assert.ok(spread(record.expandFrames, "offset") <= 2, "Deep manual expansion must not fight feed scrolling");
      const restoredY = await page.getByRole("button", { name: anchor.title, exact: true }).evaluate(element => element.getBoundingClientRect().y);
      assert.ok(Math.abs(restoredY - anchor.y) <= 4, "Deep manual expansion must retain the same anchor");
      assert.ok(Math.abs((await geometry(page)).tools.height - before.tools.height) <= 2);
      assert.ok(Math.abs((await scrollPort(page)).offset - beforeOffset) <= 4);
      record.anchor = { ...anchor, collapsedY: anchorY, restoredY, beforeOffset, collapsedOffset };
    });

    for (const scheme of ["light", "dark"]) await scenario(browser, `opaque-toolbar-gutters-${scheme}`, async ({ page, record }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const initial = await home(page);
      await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(scheme);
      record.scheme = scheme;
      record.occlusion = [];
      await advanceFeed(page, 1400);
      await blankPan(page, "down");
      assert.ok((await scrollPort(page)).offset > 800, "Occlusion regression must use cards from a deep feed");
      assert.ok(Math.abs((await geometry(page)).tools.height - initial.tools.height) <= 2);

      // Prove that this pixel oracle detects the original transparent-gutter
      // failure, rather than passing because no card is behind the seam.
      const backdrop = page.getByTestId("market-toolbar-backdrop");
      try {
        await backdrop.evaluate(node => {
          const panel = node.closest('[data-testid="market-panel"]');
          const panelTop = panel.getBoundingClientRect().top + parseFloat(getComputedStyle(panel).borderTopWidth);
          const explicitCap = panel.querySelector('[data-testid="market-toolbar-top-edge"]');
          const topCaps = explicitCap ? [explicitCap] : [...panel.querySelectorAll("div")].filter(element => {
            if (element === node) return false;
            const box = element.getBoundingClientRect();
            return getComputedStyle(element).position === "absolute" && box.height > 0 && box.height <= 6 && box.width >= panel.clientWidth - 2 && Math.abs(box.top - panelTop) <= 1;
          });
          if (topCaps.length !== 1) throw new Error("Expected one static top-edge cap for the transparent-cover negative control");
          // Both cover layers must be removed for this negative control. The
          // static cap deliberately hides the rounded upper corners even when
          // the moving backdrop is transparent.
          globalThis.__marketCoverNegativeControl = [node, ...topCaps].map(element => ({ element, cssText: element.style.cssText }));
          node.style.setProperty("background-color", "transparent", "important");
          topCaps[0].style.setProperty("opacity", "0", "important");
        });
        const gutters = await toolbarGutters(page);
        record.negativeControl = await gutterPixels(page, gutters);
        assert.ok(record.negativeControl.changedPixels > 30, "Removing the moving backdrop and static cap must expose fixture-card pixels in protected gutters");
      } finally {
        await page.evaluate(() => {
          for (const original of globalThis.__marketCoverNegativeControl ?? []) original.element.style.cssText = original.cssText;
          globalThis.__marketCoverNegativeControl = null;
        });
      }
      await assertGuttersOpaque(page, `${scheme}-deep-expanded`, record);
      let collapseIntermediate = false;
      await blankPan(page, "up", undefined, async frame => {
        if (collapseIntermediate || frame.tools.height < initial.tools.height * 0.3 || frame.tools.height > initial.tools.height * 0.7) return;
        collapseIntermediate = true;
        await assertGuttersOpaque(page, `${scheme}-deep-collapsing`, record);
      });
      assert.ok(collapseIntermediate, "Must inspect actual intermediate collapse geometry");
      assert.ok((await geometry(page)).tools.height <= 2);
      await assertGuttersOpaque(page, `${scheme}-deep-collapsed`, record);
      let expandIntermediate = false;
      await blankPan(page, "down", undefined, async frame => {
        if (expandIntermediate || frame.tools.height < initial.tools.height * 0.3 || frame.tools.height > initial.tools.height * 0.7) return;
        expandIntermediate = true;
        await assertGuttersOpaque(page, `${scheme}-deep-expanding`, record);
      });
      assert.ok(expandIntermediate, "Must inspect actual intermediate expansion geometry");
      assert.ok(Math.abs((await geometry(page)).tools.height - initial.tools.height) <= 2);
      await assertGuttersOpaque(page, `${scheme}-deep-restored`, record);
    });

    await scenario(browser, "bottom-toolbar-motion-without-scroll-clamp", async ({ page, state, record }) => {
      await home(page);
      const initialPages = initialInventoryReads(state, record);
      await reachPageTwo(page, state);
      await expect.poll(() => state.active).toBe(0);
      await scrollPort(page, "bottom");
      await expect(page.getByRole("button", { name: cardTitle(40), exact: true })).toBeVisible();
      await settle(page);
      await blankPan(page, "down");
      const before = await scrollPort(page);
      // This exercises the native content-size clamp condition: changing the
      // header height at the end of a feed would reduce the maximum offset.
      await beginMotion(page, cardTitle(40));
      await blankPan(page, "up");
      record.collapseFrames = await endMotion(page);
      assertFixedContent(record.collapseFrames, "Bottom manual collapse");
      assert.ok(spread(record.collapseFrames, "offset") <= 2, "Bottom collapse must not clamp the feed offset");
      assert.ok(spread(record.collapseFrames, "anchorY") <= 3, "Final card must not jump while the toolbar collapses");
      await beginMotion(page, cardTitle(40));
      await blankPan(page, "down");
      record.expandFrames = await endMotion(page);
      assertFixedContent(record.expandFrames, "Bottom manual expansion");
      assert.ok(spread(record.expandFrames, "offset") <= 2, "Bottom expansion must not shift the feed offset");
      assert.ok(spread(record.expandFrames, "anchorY") <= 3, "Final card must not jump while the toolbar expands");
      assert.ok(Math.abs((await scrollPort(page)).offset - before.offset) <= 2);
      assert.deepEqual(state.requests.map(request => request.page), [...initialPages, 2], "Toolbar movement must not refetch the inventory");
    });

    await scenario(browser, "infinite-pagination-and-deduplication", async ({ page, state, record }) => {
      await home(page);
      const initialPages = initialInventoryReads(state, record);
      await reachPageTwo(page, state);
      assert.equal(state.active, 1, "Page two must still be held in flight for the concurrency check");
      for (let index = 0; index < 8; index++) {
        await scrollPort(page, "bottom");
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      }
      assert.equal(state.requests.filter(request => request.page === 2).length, 1, "Repeated end-reached events must not issue concurrent page-two requests");
      assert.equal(state.maxActive, 1);
      state.release();
      await expect.poll(() => state.active).toBe(0);
      await scrollPort(page, "bottom");
      await expect(page.getByRole("button", { name: cardTitle(40), exact: true })).toBeVisible();
      const duplicate = page.getByRole("button", { name: cardTitle(24), exact: true });
      await duplicate.scrollIntoViewIfNeeded();
      await settle(page);
      await expect(duplicate).toHaveCount(1);
      await scrollPort(page, "bottom");
      await settle(page);
      assert.deepEqual(state.requests.map(request => request.page), [...initialPages, 2], "Page sequence after startup must neither skip nor repeat a page");
      assert.ok(state.requests.every(request => request.params.limit === "24"));
      record.pagination = { pages: state.requests.map(request => request.page), maxConcurrent: state.maxActive };
    }, { holdPage2: true });
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    const browserErrors = fixture.report.browserErrors;
    const report = {
      boundary: "Local React Native Web with intercepted fixture APIs; no native-device or production verification",
      inputMode,
      finishedAt: new Date().toISOString(),
      results, evidence, browserErrors,
      passed: results.filter(result => result.passed).length,
      failed: results.filter(result => !result.passed).length,
    };
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed, browserErrors: browserErrors.length, output }, null, 2));
    if (report.failed || browserErrors.length) process.exitCode = 1;
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
