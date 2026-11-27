/* Local React Native Web regression for the portrait phone/tablet layout.
 * Prerequisite: a completed web export containing the current app changes.
 * Run from the project root: node tests/tablet-layout-browser.cjs
 * Inventory and authentication are intercepted fixtures. This does not verify
 * an Android/iOS binary and never reads or writes production inventory.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect } = require("@playwright/test");
const fixture = require("./browser-smoke.cjs");

const output = path.resolve(__dirname, "../.data/tablet-layout-review");
const viewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 1366 },
];
const tabs = [
  { label: "إعلاناتي", pathname: "/listings" },
  { label: "محادثاتي", pathname: "/messages" },
  { label: "الرئيسية", pathname: "/" },
  { label: "المفضلة", pathname: "/favorites" },
  { label: "حسابي", pathname: "/account" },
];
const cardTitle = index => `Tablet layout fixture ${String(index).padStart(2, "0")}`;
const records = Array.from({ length: 40 }, (_, index) => ({
  ...fixture.listing,
  id: `tablet-layout-fixture-${index + 1}`,
  title: cardTitle(index + 1),
  price: 10000 + index,
  images: [],
}));
const report = {
  boundary: "Local React Native Web portrait viewports and window resizing with intercepted fixtures; no native-device or production verification",
  startedAt: new Date().toISOString(),
  scenarios: [],
};

async function installInventory(context) {
  const state = { requests: [], active: 0, maxActive: 0 };
  // Keep a healthy idle SSE connection in this browser fixture. The general
  // smoke fixture intentionally sends invalidations on every reconnect, which
  // would otherwise refetch inventory independently of the tested gestures.
  await context.addInitScript(() => {
    localStorage.setItem("souq-hamad-appearance-v1", "light");
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname !== "/api/realtime/stream") return originalFetch(input, init);
      let streamController;
      const stream = new ReadableStream({ start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode(": idle tablet layout fixture\n\n"));
      } });
      init?.signal?.addEventListener("abort", () => {
        try { streamController.close(); } catch { /* already closed */ }
      }, { once: true });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    };
  });
  await context.route("**/api/marketplace/listings**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== "/api/marketplace/listings" || request.method() === "OPTIONS") return route.fallback();
    assert.equal(request.method(), "GET", "The layout inventory fixture must remain read-only");
    const page = Number(url.searchParams.get("page"));
    assert.ok(page === 1 || page === 2, `Unexpected inventory page ${page}`);
    state.requests.push({ page, params: Object.fromEntries(url.searchParams) });
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      return await route.fulfill({
        contentType: "application/json",
        headers: {
          "Access-Control-Allow-Origin": fixture.origin,
          "Access-Control-Allow-Headers": "Accept,Content-Type,Authorization,Idempotency-Key,X-Souq-Hamad-Commission-Agreement",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({
          listings: page === 1 ? records.slice(0, 24) : records.slice(24),
          pagination: { page, limit: 24, hasMore: page === 1, nextPage: page === 1 ? 2 : null },
        }),
      });
    } finally { state.active--; }
  });
  return state;
}

async function home(page) {
  await page.goto(fixture.origin);
  await expect(page.getByRole("button", { name: cardTitle(1), exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "جارٍ تشغيل التطبيق", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("شعار سوق حمد", { exact: true })).toHaveCount(0);
}

async function geometry(page) {
  return page.evaluate(titles => {
    const rectangle = element => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const byId = id => document.querySelector(`[data-testid="${id}"]`);
    const card = title => [...document.querySelectorAll('[role="button"]')].find(element => element.getAttribute("aria-label") === title);
    const first = card(titles[0]);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      content: rectangle(byId("market-content")),
      panel: rectangle(byId("market-panel")),
      toolbar: rectangle(byId("market-toolbar")),
      tools: rectangle(byId("market-toolbar-tools")),
      feed: rectangle(byId("market-feed")),
      navigation: rectangle(byId("bottom-navigation")),
      pill: rectangle(byId("navigation-pill")),
      first: rectangle(first),
      second: rectangle(card(titles[1])),
      cardDirection: first && getComputedStyle(first).flexDirection,
      imageWidth: first?.children[0]?.getBoundingClientRect().width,
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      orientation: screen.orientation?.type,
    };
  }, [cardTitle(1), cardTitle(2)]);
}

function centered(box, viewportWidth, label) {
  assert.ok(box, `${label} must be present`);
  const rightMargin = viewportWidth - box.right;
  assert.ok(Math.abs(box.x - rightMargin) <= 1, `${label} must have equal left/right margins (${box.x}px / ${rightMargin}px)`);
  assert.ok(box.x >= -1 && rightMargin >= -1, `${label} must fit in the window`);
}

async function navigationGeometry(page) {
  const navigation = page.getByTestId("bottom-navigation");
  const pill = await page.getByTestId("navigation-pill").boundingBox();
  const viewport = page.viewportSize();
  centered({ ...pill, right: pill.x + pill.width }, viewport.width, "Navigation pill");
  assert.ok(pill.width <= 481, "The navigation pill must stay bounded to 480px");
  assert.ok(Math.abs(pill.width - Math.min(viewport.width - 24, 480)) <= 1, "The navigation pill must use available phone width and stop growing on tablets");
  assert.ok(pill.y >= 0 && pill.y + pill.height <= viewport.height - 7, "The navigation pill must remain above the bottom safe gutter");
  const boxes = [];
  for (const tab of tabs) {
    const box = await navigation.getByRole("button", { name: tab.label, exact: true }).boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `${tab.label} must retain a usable touch target`);
    assert.ok(box.x >= pill.x - 1 && box.x + box.width <= pill.x + pill.width + 1, `${tab.label} must remain horizontally inside the pill`);
    boxes.push(box);
  }
  assert.ok(boxes.every((box, index) => index === 0 || boxes[index - 1].x > box.x), "Tabs must keep their right-to-left order");
  assert.ok(Math.abs(boxes[2].x + boxes[2].width / 2 - viewport.width / 2) <= 1, "The home tab must stay at the window center");
  return { pill, tabs: boxes };
}

async function assertMarketLayout(page) {
  const width = page.viewportSize().width;
  // RN Web commits layout asynchronously after a resize; wait for both bounded
  // containers before reading card alignment, rather than sleeping a fixed time.
  // Its useWindowDimensions consumers (including the draggable Hamad bubble)
  // update after the CSS layout, so include the document extent in that wait.
  // Persistent overflow still fails this poll and the strict assertion below.
  const settling = [];
  await expect.poll(async () => {
    const current = await geometry(page);
    settling.push({ contentWidth: current.content?.width, pillWidth: current.pill?.width, documentWidth: current.documentWidth });
    return current.content && current.pill &&
      Math.abs(current.content.width - Math.min(width, 720)) <= 1 &&
      Math.abs(current.pill.width - Math.min(width - 24, 480)) <= 1 &&
      current.documentWidth <= width + 1;
  }).toBe(true);
  const current = await geometry(page);
  current.settling = settling;
  centered(current.content, width, "Market content");
  centered(current.panel, width, "Market panel");
  centered(current.toolbar, width, "Market toolbar");
  centered(current.first, width, "First listing card");
  assert.ok(current.content.width <= 721, "Market content must stop growing at 720px");
  assert.ok(Math.abs(current.navigation.width - width) <= 1 && Math.abs(current.navigation.x) <= 1, "The navigation's outside wrapper must span the window");
  assert.ok(current.toolbar.x >= current.panel.x && current.toolbar.right <= current.panel.right, "Tools must fit within the bounded market panel");
  assert.ok(current.tools.width > 0 && current.tools.x >= current.toolbar.x && current.tools.right <= current.toolbar.right, "The expanded tools must fit within the toolbar");
  assert.ok(Math.abs(current.first.x - current.toolbar.x) <= 1 && Math.abs(current.first.width - current.toolbar.width) <= 1, "The first card and toolbar must share their horizontal edges");
  assert.ok(Math.abs(current.second.x - current.first.x) <= 1 && Math.abs(current.second.width - current.first.width) <= 1, "Listing cards must keep one aligned column");
  assert.ok(current.second.y >= current.first.bottom, "The second listing must follow below the first");
  assert.equal(current.cardDirection, "row-reverse", "Cards must preserve the horizontal mobile layout");
  assert.ok(Math.abs(current.imageWidth - 100) <= 1, "The existing 100px listing image must remain compact");
  assert.ok(current.documentWidth <= width + 1, "The page must not gain horizontal overflow");
  current.navigationGeometry = await navigationGeometry(page);
  return current;
}

async function verifyTabNavigation(page) {
  const navigation = page.getByTestId("bottom-navigation");
  for (const destination of [...tabs, tabs[2]]) {
    await navigation.getByRole("button", { name: destination.label, exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(destination.pathname);
    for (const tab of tabs) await expect(navigation.getByRole("button", { name: tab.label, exact: true }))
      .toHaveAttribute("aria-pressed", String(tab.pathname === destination.pathname));
    await navigationGeometry(page);
  }
  await expect(page.getByRole("button", { name: cardTitle(1), exact: true })).toBeVisible();
}

async function scrollPort(page, action) {
  return page.getByTestId("market-feed").evaluate((root, action) => {
    const node = [root, ...root.querySelectorAll("div")].find(element =>
      /auto|scroll/.test(getComputedStyle(element).overflowY) && element.clientHeight > 100 && element.scrollHeight > element.clientHeight + 5);
    if (!node) throw new Error("The market feed has no vertical browser scroll port");
    if (action === "bottom") node.scrollTop = node.scrollHeight;
    if (action === "navigation-gap") node.scrollTop = Math.max(0, node.scrollTop - 128);
    return { offset: node.scrollTop, height: node.clientHeight, contentHeight: node.scrollHeight };
  }, action);
}

async function gapClickthrough(page) {
  // On a tablet the market is wider than the pill. A real card behind either
  // outside gap must receive the browser click rather than the full-width
  // positioning wrapper consuming it. Stop the fixture click at capture time
  // so this probe does not leave the market or create unrelated detail reads.
  const probe = await page.evaluate(() => {
    const pill = document.querySelector('[data-testid="navigation-pill"]');
    const navigation = document.querySelector('[data-testid="bottom-navigation"]');
    const panel = document.querySelector('[data-testid="market-panel"]');
    const pillBox = pill.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const y = pillBox.top + pillBox.height / 2;
    const points = [
      { x: (panelBox.left + pillBox.left) / 2, y },
      { x: (pillBox.right + panelBox.right) / 2, y },
    ];
    const point = points.find(point => {
      const target = document.elementFromPoint(point.x, point.y);
      const card = target?.closest('[role="button"][aria-label^="Tablet layout fixture "]');
      return card && !navigation.contains(target);
    });
    if (!point) throw new Error("Neither navigation side gap exposes a listing card for the click-through regression");
    globalThis.__tabletGapClick = null;
    document.addEventListener("click", event => {
      const card = event.target.closest('[role="button"][aria-label^="Tablet layout fixture "]');
      globalThis.__tabletGapClick = { title: card?.getAttribute("aria-label"), insideNavigation: navigation.contains(event.target) };
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true, once: true });
    return point;
  });
  await page.mouse.click(probe.x, probe.y);
  const clicked = await page.evaluate(() => globalThis.__tabletGapClick);
  assert.ok(clicked?.title, "A card behind the navigation side gap must receive the click");
  assert.equal(clicked.insideNavigation, false, "The outside navigation wrapper must pass clicks through");
  return { point: probe, ...clicked };
}

async function scenario(browser, name, viewport, callback) {
  const { context, page } = await fixture.fixtureContext(browser, false, `tablet-layout-${name}`);
  const result = { name, viewport, passed: false, measurements: [] };
  report.scenarios.push(result);
  try {
    await page.setViewportSize(viewport);
    const state = await installInventory(context);
    result.requests = state.requests;
    await home(page);
    await callback({ page, state, result });
    result.passed = true;
    console.log(`PASS ${name}`);
  } catch (error) {
    result.error = error.stack || String(error);
    result.geometryAtFailure = await geometry(page).catch(() => null);
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = fixture.createStaticServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(8181, "127.0.0.1", resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of viewports) await scenario(browser, `portrait-${viewport.width}`, viewport, async ({ page, result }) => {
      result.measurements.push(await assertMarketLayout(page));
      if (viewport.width === 390 || viewport.width === 1024) {
        await page.screenshot({ path: path.join(output, `portrait-${viewport.width}.png`) });
      }
      await verifyTabNavigation(page);
      result.measurements.push(await assertMarketLayout(page));
    });
    await scenario(browser, "live-window-resize", viewports[2], async ({ page, result }) => {
      for (const viewport of [viewports[2], { width: 560, height: 900 }, viewports[0], viewports[3], viewports[2]]) {
        await page.setViewportSize(viewport);
        result.measurements.push(await assertMarketLayout(page));
      }
      assert.equal(new URL(page.url()).pathname, "/", "Resizing must keep the current market route");
      await expect(page.getByTestId("bottom-navigation").getByRole("button", { name: "الرئيسية", exact: true })).toHaveAttribute("aria-pressed", "true");
    });
    for (const viewport of [viewports[0], viewports[3]]) await scenario(browser, `scroll-pagination-${viewport.width}`, viewport, async ({ page, state, result }) => {
      result.measurements.push(await assertMarketLayout(page));
      const feed = page.getByTestId("market-feed");
      const before = await scrollPort(page);
      const box = await feed.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 480);
      await expect.poll(async () => (await scrollPort(page)).offset).toBeGreaterThan(before.offset + 100);
      await expect.poll(async () => {
        await scrollPort(page, "bottom");
        return state.requests.filter(request => request.page === 2).length;
      }, { timeout: 10000, intervals: [64, 100, 160] }).toBe(1);
      await expect.poll(() => state.active).toBe(0);
      await expect.poll(async () => {
        await scrollPort(page, "bottom");
        return page.getByRole("button", { name: cardTitle(40), exact: true }).isVisible();
      }, { timeout: 10000, intervals: [64, 100, 160] }).toBe(true);
      const finalCard = await page.getByRole("button", { name: cardTitle(40), exact: true }).boundingBox();
      centered({ ...finalCard, right: finalCard.x + finalCard.width }, viewport.width, "Paginated listing card");
      assert.ok(Math.abs(finalCard.width - result.measurements[0].first.width) <= 1, "Paginated cards must keep the original bounded width");
      assert.deepEqual(state.requests.map(request => request.page), [1, 2], "Scrolling must load exactly the first and second inventory pages");
      assert.ok(state.requests.every(request => request.params.limit === "24"));
      assert.equal(state.maxActive, 1, "Pagination must remain sequential");
      result.scrolling = { before, after: await scrollPort(page), finalCard, maxActive: state.maxActive };
      result.navigationAfterScrolling = await navigationGeometry(page);
      if (viewport.width > 720) {
        // Leave the feed's normal bottom padding so its final card sits behind
        // the navigation band and the outside gaps have a real click target.
        await scrollPort(page, "navigation-gap");
        result.gapClickthrough = await gapClickthrough(page);
      }
    });
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    report.finishedAt = new Date().toISOString();
    report.browserErrors = fixture.report.browserErrors;
    report.unexpectedApi = fixture.report.unexpectedApi;
    report.blockedRemote = fixture.report.blockedRemote;
    report.passed = report.scenarios.filter(result => result.passed).length;
    report.failed = report.scenarios.filter(result => !result.passed).length;
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed, browserErrors: report.browserErrors.length,
      unexpectedApi: report.unexpectedApi.length, blockedRemote: report.blockedRemote.length, output }, null, 2));
    if (report.failed || report.browserErrors.length || report.unexpectedApi.length || report.blockedRemote.length) process.exitCode = 1;
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
