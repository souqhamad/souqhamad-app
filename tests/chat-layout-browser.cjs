/* Isolated viewport-resize evidence for React Native Web. This does not open a
 * native IME or prove keyboard animation on Android/iOS. Requires dist/index.html
 * from the root-owned web export. Run: node tests/chat-layout-browser.cjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect } = require("@playwright/test");
const fixture = require("./browser-smoke.cjs");

const output = path.resolve(__dirname, "../.data/chat-layout-review");
const report = {
  boundary: "React Native Web viewport resize with intercepted fixtures; no native IME, device, or production verification",
  startedAt: new Date().toISOString(),
  scenarios: [],
};
const latestUserMessage = "آخر رسالة في محادثة المعاينة — يجب أن تبقى ظاهرة";
const shortMine = "شكرًا";
const shortTheirs = "تمام";
const assistantGreeting = "مرحبًا";
const firstListingDescription = "آيفون 14 مستعمل في الرياض بسعر 1200 ريال";
const latestAssistantMessage = "نهاية رد حمد في اختبار المعاينة";
const draftListRequest = "أبغى أعدّل واحد من إعلاناتي السابقة";
const draftEditRequest = "خل السعر ٥٠٠";
const draftPageKey = "a".repeat(64) + ":0";
const draftMemory = "h2_preview." + "c".repeat(43);
const draftCards = ["مسودة المكتب", "مسودة الجوال"].map(title => ({
  title, modified: "2026-11-23T08:00:00Z", price: 300, imageCount: 0,
}));
const assistantResponse = Array.from({ length: 16 }, (_, index) =>
  `فقرة معاينة ${index + 1}: هذه بيانات لاختبار تخطيط المحادثة فقط.`,
).join("\n\n") + `\n\n${latestAssistantMessage}`;
const conversation = {
  id: fixture.conversationId,
  listingId: fixture.listingId,
  sellerId: fixture.sellerId,
  buyerId: fixture.user.id,
  status: "open",
  listing: fixture.listing,
  seller: { id: fixture.sellerId, name: "معلن اختبار تخطيط المحادثة" },
  buyer: fixture.user,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T11:00:00.000Z",
  messages: Array.from({ length: 40 }, (_, index) => ({
    id: `layout-message-${index}`,
    conversationId: fixture.conversationId,
    senderId: index % 2 ? fixture.user.id : fixture.sellerId,
    type: "text",
    status: "sent",
    reasons: [],
    metadata: {},
    body: index === 39 ? latestUserMessage : index === 38 ? shortTheirs : index === 37 ? shortMine : `رسالة معاينة رقم ${index + 1} لاختبار التمرير.`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, index)).toISOString(),
  })),
};

function headers() {
  return {
    "Access-Control-Allow-Origin": fixture.origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Accept,Content-Type,Authorization,Idempotency-Key,X-Souq-Hamad-Commission-Agreement,X-Souq-Hamad-AI-Consent",
    "Cache-Control": "no-store",
  };
}

async function installChatFixtures(context) {
  // React Native Web exports a no-op Alert. Emulate the native choice only in
  // the local preview, so the test still exercises the real consent gate.
  await context.route(`${fixture.origin}/_expo/static/js/web/entry-*.js`, async route => {
    const response = await route.fetch();
    const bundle = await response.text();
    const nativeAlert = /static alert\(\)\s*\{\s*\}/g;
    assert.equal([...bundle.matchAll(nativeAlert)].length, 1);
    return route.fulfill({ status: 200, contentType: "application/javascript", body: bundle.replace(nativeAlert,
      "static alert(title,message,buttons){const choice=globalThis.confirm(title+'\\n'+message)?'أوافق':'لاحقًا';buttons.find(button=>button.text===choice)?.onPress()}") });
  });
  await context.route(`**/api/marketplace/conversations/${fixture.conversationId}`, route => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    assert.equal(route.request().method(), "GET");
    return route.fulfill({ contentType: "application/json", headers: headers(),
      body: JSON.stringify({ conversation, blockStatus: { blocked: false, blockedByMe: false } }) });
  });
  const assistantRequests = [];
  await context.route("**/api/chat", route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: headers() });
    assert.equal(route.request().method(), "POST");
    const body = route.request().postDataJSON();
    assistantRequests.push(body);
    const latestText = body.messages.at(-1)?.parts.find(part => part.type === "text")?.text;
    const offerChoice = latestText === firstListingDescription && body.creationMethod !== "chat";
    let reply = offerChoice ? "كيف تفضّل إنشاء إعلانك؟"
      : latestText === firstListingDescription ? "وصلت تفاصيل الإعلان." : assistantResponse;
    let draftMetadata = {};
    if (latestText === draftListRequest || body.hamadDraftAction?.type === "list") {
      draftMetadata = { hamadDraftMemory: draftMemory, hamadDraftUi: { active: null,
        page: { key: draftPageKey, hasNext: false, cards: draftCards } } };
      reply = "مسودة المكتب\nمسودة الجوال";
    } else if (body.hamadDraftAction?.type === "select" || latestText === draftEditRequest) {
      const changed = latestText === draftEditRequest;
      const draft = draftCards[changed ? 1 : body.hamadDraftAction.choice - 1];
      draftMetadata = { hamadDraftMemory: draftMemory, hamadDraftUi: {
        active: { title: draft.title, expires: Date.now() + 300_000 },
        preview: { ...draft, price: changed ? 500 : draft.price, description: "وصف المسودة الظاهر في المعاينة" },
      } };
      reply = changed ? "حُفظ السعر في المسودة." : "تم اختيار المسودة.";
    }
    const chunks = [
      { type: "start", messageId: `layout-assistant-response-${assistantRequests.length}`,
        messageMetadata: { creationChoice: offerChoice, ...draftMetadata } },
      { type: "text-start", id: "layout-text" },
      { type: "text-delta", id: "layout-text", delta: reply },
      { type: "text-end", id: "layout-text" },
      { type: "finish", finishReason: "stop" },
    ];
    return route.fulfill({ contentType: "text/event-stream", headers: {
      ...headers(), "x-vercel-ai-ui-message-stream": "v1",
    }, body: chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
  });
  return assistantRequests;
}

async function composerRectangle(send) {
  return send.evaluate(element => {
    let row = element.parentElement;
    while (row && !row.querySelector("textarea")) row = row.parentElement;
    if (!row?.parentElement) throw new Error("Composer row with textarea was not found");
    const composer = row.parentElement;
    const bounds = composer.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      bottom: bounds.bottom, paddingBottom: getComputedStyle(composer).paddingBottom };
  });
}

async function markerRectangle(locator, marker) {
  return locator.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.textContent.lastIndexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom };
    }
    throw new Error("Latest message marker was not found");
  }, marker);
}

async function compactMessage(locator) {
  const measurement = await locator.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { width: bounds.width, height: bounds.height,
      paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
      paddingTop: style.paddingTop, paddingBottom: style.paddingBottom };
  });
  assert.ok(measurement.width < 206, "A short message must size to its content instead of filling the chat width");
  assert.ok(measurement.height <= 62, "A short message must not become an oversized container");
  return measurement;
}

async function verifyLayout(page, name, height, baselineHeaderY, selectors) {
  await page.setViewportSize({ width: 412, height });
  const input = page.getByPlaceholder(selectors.placeholder, { exact: true });
  const send = page.getByRole("button", { name: "إرسال الرسالة", exact: true });
  const header = page.getByText(selectors.header, { exact: true }).filter({ visible: true }).first();
  const latest = page.getByText(selectors.marker, { exact: false }).filter({ visible: true }).last();
  await expect(input).toBeVisible();
  await expect(send).toBeVisible();
  await expect(latest).toBeVisible();
  // Poll the final positions after RN layout and scroll-to-end callbacks settle.
  await expect.poll(async () => {
    const composer = await composerRectangle(send);
    const marker = await markerRectangle(latest, selectors.marker);
    return marker.bottom <= composer.y + 2 && marker.y >= (await header.boundingBox()).y;
  }, { message: "The latest message must remain above the composer after viewport resize" }).toBe(true);
  const inputBox = await input.boundingBox();
  const sendBox = await send.boundingBox();
  const headerBox = await header.boundingBox();
  const composer = await composerRectangle(send);
  const marker = await markerRectangle(latest, selectors.marker);
  for (const [label, box] of [["input", inputBox], ["send", sendBox]]) {
    assert.ok(box.y >= 0 && box.y + box.height <= height + 1, `${label} must fit in the visible viewport`);
    assert.ok(box.x >= 0 && box.x + box.width <= 413, `${label} must fit horizontally`);
  }
  assert.ok(Math.abs(headerBox.y - baselineHeaderY) <= 1, "Header position must stay fixed");
  assert.ok(Math.abs(composer.bottom - height) <= 1, "No extra blank footer may sit below the composer");
  assert.equal(composer.paddingBottom, selectors.paddingBottom, "Only normal composer padding remains on web");
  await page.screenshot({ path: path.join(output, `${name}-${height}.png`) });
  return { viewport: { width: 412, height }, input: inputBox, send: sendBox, header: headerBox, composer, latest: marker };
}

async function scenario(browser, name, callback) {
  const { page, context } = await fixture.fixtureContext(browser, true, `chat-layout-${name}`);
  await context.addInitScript(() => localStorage.setItem("souq-hamad-appearance-v1", "light"));
  const result = { name, passed: false, measurements: [] };
  report.scenarios.push(result);
  try {
    const requests = await installChatFixtures(context);
    page.on("dialog", async dialog => {
      if (dialog.type() === "confirm" && dialog.message().includes("مشاركة البيانات مع الذكاء الاصطناعي")) await dialog.accept();
      else await dialog.dismiss();
    });
    await callback({ page, result, requests });
    result.passed = true;
    console.log(`PASS ${name}`);
  } catch (error) {
    result.error = error.stack || String(error);
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true });
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
    await scenario(browser, "user-conversation", async ({ page, result }) => {
      await page.goto(fixture.origin + `/conversations/${fixture.conversationId}`);
      await expect(page.getByPlaceholder("اكتب رسالتك…", { exact: true })).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "جارٍ تشغيل التطبيق" })).toHaveCount(0);
      await expect(page.getByLabel("شعار سوق حمد", { exact: true })).toHaveCount(0);
      const selectors = { placeholder: "اكتب رسالتك…", header: conversation.seller.name,
        marker: latestUserMessage, paddingBottom: "12px" };
      await expect(page.getByText(shortMine, { exact: true })).toBeVisible();
      await expect(page.getByText(shortTheirs, { exact: true })).toBeVisible();
      result.compactMessages = [
        await compactMessage(page.getByTestId("conversation-message-layout-message-37")),
        await compactMessage(page.getByTestId("conversation-message-layout-message-38")),
      ];
      const baseline = await page.getByText(selectors.header, { exact: true }).boundingBox();
      for (const [index, height] of [915, 500, 915].entries()) result.measurements.push(
        await verifyLayout(page, `user-conversation-${index}`, height, baseline.y, selectors),
      );
    });
    await scenario(browser, "reader-position-survives-layout", async ({ page, result }) => {
      await page.goto(fixture.origin + `/conversations/${fixture.conversationId}`);
      const feed = page.getByTestId("conversation-message-feed");
      await expect(feed).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "جارٍ تشغيل التطبيق" })).toHaveCount(0);
      const position = () => feed.evaluate(element => {
        const candidates = [element, ...element.querySelectorAll("div")];
        const scroller = candidates.find(candidate => /auto|scroll/.test(getComputedStyle(candidate).overflowY) && candidate.scrollHeight > candidate.clientHeight) || element;
        return { top: scroller.scrollTop, height: scroller.clientHeight, total: scroller.scrollHeight };
      });
      // FlatList's scroll extent can include trailing content padding. Assert
      // the customer's visible message, rather than an arbitrary zero gap.
      await expect(page.getByText(latestUserMessage, { exact: true })).toBeInViewport({ ratio: 1 });
      const initial = await position();
      await feed.hover();
      await page.mouse.wheel(0, -480);
      await expect.poll(async () => initial.top - (await position()).top).toBeGreaterThan(250);
      const reading = await position();
      await page.setViewportSize({ width: 412, height: 650 });
      await expect.poll(async () => (await position()).height).toBeLessThan(reading.height);
      await expect.poll(async () => Math.abs((await position()).top - reading.top)).toBeLessThan(3);
      const resized = await position();
      assert.ok(resized.total - resized.top - resized.height > 250, "Resizing must not pull a reader back to the latest message");
      result.measurements.push({ initial, reading, resized });
    });
    await scenario(browser, "hamad-conversation", async ({ page, result, requests }) => {
      await page.goto(fixture.origin + "/create/assistant");
      const input = page.getByPlaceholder("اكتب لحمد…", { exact: true });
      await expect(input).toBeEditable();
      await expect(page.getByRole("progressbar", { name: "جارٍ تشغيل التطبيق" })).toHaveCount(0);
      await expect(page.getByLabel("شعار سوق حمد", { exact: true })).toHaveCount(0);
      await input.fill(assistantGreeting);
      await page.getByRole("button", { name: "إرسال الرسالة", exact: true }).click();
      await expect(page.getByText(latestAssistantMessage, { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "إرسال الرسالة", exact: true })).toBeVisible();
      assert.equal(requests.length, 1, "Only the intercepted assistant fixture should be requested");
      result.compactMessages = [await compactMessage(page.getByTestId("hamad-user-message"))];
      result.plainReply = await page.getByTestId("hamad-assistant-message").evaluate(element => {
        const style = getComputedStyle(element);
        return { backgroundColor: style.backgroundColor, borderWidth: style.borderTopWidth,
          paddingTop: style.paddingTop, paddingRight: style.paddingRight,
          paddingBottom: style.paddingBottom, paddingLeft: style.paddingLeft };
      });
      assert.deepEqual(result.plainReply, { backgroundColor: "rgba(0, 0, 0, 0)", borderWidth: "0px",
        paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px" },
      "Hamad's reply must remain plain text without a bubble, border, or padded card");
      await page.getByTestId("hamad-user-message").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, "hamad-message-style.png") });
      await page.getByTestId("hamad-assistant-message").evaluate(element => {
        let scroll = element.parentElement;
        while (scroll && !(/auto|scroll/.test(getComputedStyle(scroll).overflowY) && scroll.scrollHeight > scroll.clientHeight)) scroll = scroll.parentElement;
        if (!scroll) throw new Error("Assistant scroll port was not found");
        // Restore the real end including normal message-list bottom padding,
        // after moving to the opening exchange for the style screenshot.
        scroll.scrollTop = scroll.scrollHeight;
      });
      const selectors = { placeholder: "اكتب لحمد…", header: "حمد",
        marker: latestAssistantMessage, paddingBottom: "14px" };
      const baseline = await page.getByText(selectors.header, { exact: true }).first().boundingBox();
      for (const [index, height] of [915, 500, 915].entries()) result.measurements.push(
        await verifyLayout(page, `hamad-conversation-${index}`, height, baseline.y, selectors),
      );
    });
    await scenario(browser, "dedicated-hamad-creation", async ({ page, requests }) => {
      await page.goto(fixture.origin);
      await page.getByRole("button", { name: "أنشئ إعلانك مع حمد" }).click();
      await expect(page).toHaveURL(/\/create\/assistant$/);
      const intake = page.getByPlaceholder("اكتب تفاصيل إعلانك…", { exact: true });
      await expect(intake).toBeEditable();
      await expect(page.getByText("اكتب تفاصيل إعلانك أو أرفق صوره، وأنا أساعدك في تجهيز المسودة.")).toBeVisible();
      assert.equal(requests.length, 0, "Opening the chat must not submit a request");
      await intake.fill(firstListingDescription);
      await page.getByRole("button", { name: "إرسال الرسالة" }).click();
      await expect(page.getByText("وصلت تفاصيل الإعلان.", { exact: true })).toBeVisible();
      assert.equal(requests[0].creationMethod, "chat");
      assert.equal(requests[0].messages.at(-1).parts[0].text, firstListingDescription);
      await expect(page.getByRole("button", { name: "الإنشاء اليدوي", exact: true })).toHaveCount(0);
      await page.getByLabel("رجوع", { exact: true }).filter({ visible: true }).click();
      await expect(page).toHaveURL(fixture.origin + "/");
      await page.goto(fixture.origin + "/create");
      await page.getByText("أنشئ مع حمد", { exact: true }).click();
      await expect(intake).toBeEditable();
      assert.equal(requests.length, 1, "Reopening must never create a second request");
    });
    await scenario(browser, "choosing-hamad-hides-the-obsolete-method-question", async ({ page, requests }) => {
      await page.goto(fixture.origin + "/create/assistant");
      await page.getByPlaceholder("اكتب لحمد…", { exact: true }).fill(firstListingDescription);
      await page.getByRole("button", { name: "إرسال الرسالة" }).click();
      await expect(page.getByRole("button", { name: "الإنشاء اليدوي", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "الإنشاء مع حمد", exact: true }).click();
      await expect(page.getByText(latestAssistantMessage, { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "الإنشاء مع حمد", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "الإنشاء اليدوي", exact: true })).toHaveCount(0);
      await expect(page.getByText("كيف تفضّل إنشاء إعلانك؟", { exact: true })).toHaveCount(0);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].creationMethod, "chat");
      assert.ok(!requests[1].messages.some(message => message.metadata?.creationChoice === true));
    });
    await scenario(browser, "general-hamad-and-manual-creation", async ({ page, requests }) => {
      await page.goto(fixture.origin + "/create/assistant");
      const generalInput = page.getByPlaceholder("اكتب لحمد…", { exact: true });
      await generalInput.fill(firstListingDescription);
      await page.getByRole("button", { name: "إرسال الرسالة" }).click();
      await expect(page.getByRole("button", { name: "الإنشاء مع حمد", exact: true })).toBeVisible();
      const manual = page.getByRole("button", { name: "الإنشاء اليدوي", exact: true });
      await expect(manual).toBeVisible();
      assert.equal(requests[0].creationMethod, undefined);
      await manual.click();
      await expect(page).toHaveURL(/\/create\/manual$/);
      assert.equal(requests.length, 1);
      await page.getByRole("button", { name: "معاينة الإعلان", exact: true }).click();
      await expect(page.getByRole("img", { name: "إعلان بدون صور — سوق حمد" })).toBeVisible();
      await page.getByRole("button", { name: "إغلاق", exact: true }).click();
      await expect(page.getByRole("heading", { name: "معاينة إعلانك" })).toHaveCount(0);
    });
    await scenario(browser, "hamad-select-and-switch-draft-cards", async ({ page, requests }) => {
      await page.goto(fixture.origin + "/create/assistant");
      const input = page.getByPlaceholder("اكتب لحمد…");
      const submit = page.getByRole("button", { name: "إرسال الرسالة", exact: true });
      const active = page.getByTestId("hamad-active-draft");
      await input.fill(draftListRequest);
      await submit.click();
      await expect(page.getByTestId("hamad-draft-picker")).toBeVisible();
      await input.fill(draftEditRequest);
      await page.getByRole("button", { name: "اختيار المسودة مسودة الجوال" }).click();
      await expect(page.getByTestId("hamad-draft-preview")).toContainText("وصف المسودة الظاهر في المعاينة");
      await expect(active).toContainText("مسودة الجوال");
      await expect(input).toHaveValue(draftEditRequest);
      assert.equal(requests[0].hamadDraftCards, true);
      assert.deepEqual(requests[1].hamadDraftAction, { type: "select", page: draftPageKey, choice: 2 });
      assert.equal(requests[1].messages.at(-2).metadata.hamadDraftMemory, draftMemory);
      assert.equal(requests[1].messages.at(-2).metadata.hamadDraftUi, undefined);
      await submit.click();
      await expect(page.getByText("حُفظ السعر في المسودة.", { exact: true })).toBeVisible();
      await expect(page.getByTestId("hamad-draft-preview").last()).toContainText(/٥٠٠|500/);
      assert.equal(requests[2].hamadDraftAction, undefined);
      assert.equal(requests[2].messages.at(-2).metadata.hamadDraftMemory, draftMemory);
      await active.getByRole("button", { name: "تغيير", exact: true }).click();
      await page.getByRole("button", { name: "اختيار المسودة مسودة المكتب" }).click();
      await expect(active).toContainText("مسودة المكتب");
      assert.deepEqual(requests[3].hamadDraftAction, { type: "list" });
      assert.equal(requests[4].hamadDraftAction.choice, 1);
      await page.setViewportSize({ width: 412, height: 500 });
      await expect(active).toBeInViewport();
      await expect(input).toBeInViewport();
      await page.screenshot({ path: path.join(output, "hamad-selected-draft.png") });
    });
    assert.deepEqual(fixture.report.browserErrors, []);
    assert.deepEqual(fixture.report.unexpectedApi, []);
    assert.deepEqual(fixture.report.blockedRemote, []);
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
    console.log(JSON.stringify({ boundary: report.boundary, passed: report.passed, failed: report.failed, output }, null, 2));
    if (report.failed) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
