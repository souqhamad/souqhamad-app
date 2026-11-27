/* Isolated React Native Web interaction evidence; not a device/FCM/OAuth test. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect } = require("@playwright/test");
const fixture = require("./browser-smoke.cjs");
const output = path.resolve(".data/feedback-review");
const results = [];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: {
  "Access-Control-Allow-Origin": fixture.origin,
  "Access-Control-Allow-Headers": "Accept,Content-Type,Authorization,Idempotency-Key,X-Souq-Hamad-Commission-Agreement",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
}, body: JSON.stringify(body) });

async function scenario(browser, name, callback, theme = "light") {
  const { page, context, state } = await fixture.fixtureContext(browser, true, name);
  await context.addInitScript(value => localStorage.setItem("souq-hamad-appearance-v1", value), theme);
  try {
    await callback({ page, context, state });
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true });
    results.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}

async function installProfile(context) {
  const profile = { ...fixture.user };
  const state = { saves: 0, deletes: 0, failure: false, authenticated: true, hold: null };
  await context.route("**/api/auth/session", route => route.request().method() === "OPTIONS" ? route.fallback() : json(route, { authenticated: state.authenticated, user: state.authenticated ? profile : null }));
  await context.route("**/api/auth/logout", route => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    state.authenticated = false;
    return json(route, { success: true });
  });
  await context.route("**/api/account/profile", async route => {
    const method = route.request().method();
    if (method === "OPTIONS") return route.fallback();
    if (method === "DELETE") { state.deletes++; state.authenticated = false; return json(route, { deleted: true }); }
    state.saves++;
    if (state.hold) await state.hold;
    if (state.failure) return json(route, { error: "server_failure", message: "TypeError /api/private secret-stack" }, 500);
    const body = route.request().postDataJSON();
    assert.deepEqual(Object.keys(body).sort(), ["displayName", "phoneNumber"]);
    profile.name = body.displayName;
    return json(route, { user: profile });
  });
  return state;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = fixture.createStaticServer();
  await new Promise(resolve => server.listen(8181, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of ["light", "dark"]) await scenario(browser, `account-save-${theme}`, async ({ page, context }) => {
      const state = await installProfile(context);
      let release;
      state.hold = new Promise(resolve => { release = resolve; });
      await page.goto(fixture.origin + "/account/edit");
      await expect(page.getByRole("button", { name: "حفظ التغييرات", exact: true })).toBeVisible();
      await page.getByRole("textbox").first().fill("اسم الاختبار الجديد");
      await page.getByRole("button", { name: "حفظ التغييرات", exact: true }).click();
      await expect.poll(() => state.saves).toBe(1);
      await expect(page.getByText("تم حفظ بيانات حسابك", { exact: true })).toHaveCount(0);
      release();
      await expect(page.getByText("تم حفظ بيانات حسابك", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "إغلاق الرسالة", exact: true })).toHaveCount(1);
      const text = page.getByText("تم حفظ بيانات حسابك", { exact: true });
      const card = await text.evaluate(element => getComputedStyle(element.parentElement).backgroundColor);
      assert.equal(card, theme === "dark" ? "rgb(34, 46, 40)" : "rgb(255, 255, 255)");
      await page.screenshot({ path: path.join(output, `account-save-${theme}.png`) });
      await page.getByRole("button", { name: "إغلاق الرسالة", exact: true }).click();
      state.failure = true;
      await page.getByRole("textbox").first().fill("بيانات تبقى عند الفشل");
      await page.getByRole("button", { name: "حفظ التغييرات", exact: true }).click();
      await expect(page.getByText("الخدمة غير متاحة مؤقتًا. حاول لاحقًا.", { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox").first()).toHaveValue("بيانات تبقى عند الفشل");
      await expect(page.getByText(/TypeError|secret-stack/)).toHaveCount(0);
      await page.waitForTimeout(4500);
      await expect(page.getByText("الخدمة غير متاحة مؤقتًا. حاول لاحقًا.", { exact: true })).toBeVisible();
    }, theme);

    await scenario(browser, "account-delete-confirm-cancel", async ({ page, context }) => {
      const state = await installProfile(context);
      await page.goto(fixture.origin + "/account/edit");
      await page.getByRole("button", { name: "حذف حسابي نهائيًا", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "حذف حسابك؟", exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "إلغاء", exact: true }).click();
      assert.equal(state.deletes, 0);
      await page.getByRole("button", { name: "حذف حسابي نهائيًا", exact: true }).click();
      await dialog.getByRole("button", { name: "حذف الحساب", exact: true }).click();
      await expect.poll(() => state.deletes).toBe(1);
      await expect(page.getByText("تم تنفيذ طلب حذف حسابك", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(fixture.origin + "/");
    });

    await scenario(browser, "favorite-result-and-report-modal", async ({ page, state }) => {
      await page.goto(fixture.origin + `/listings/${fixture.listingId}`);
      await page.getByLabel("حفظ في المفضلة", { exact: true }).click();
      await expect(page.getByText("أُضيف الإعلان للمفضلة", { exact: true })).toBeVisible();
      assert.equal(state.favorite, true);
      await page.getByRole("button", { name: "إغلاق الرسالة", exact: true }).click();
      await page.getByRole("button", { name: "الإبلاغ عن الإعلان", exact: true }).click();
      await page.getByRole("textbox").fill("بلاغ اختبار عرض الرسائل فقط");
      await page.getByRole("button", { name: "إرسال البلاغ", exact: true }).click();
      await expect(page.getByText("تم إرسال البلاغ للإدارة", { exact: true })).toBeVisible();
      assert.equal(state.reports.length, 1);
      await expect(page.getByRole("button", { name: "إغلاق الرسالة", exact: true })).toHaveCount(1);
    });

    await scenario(browser, "editor-modal-publication-error-and-retry", async ({ page, context }) => {
      const draft = { ...fixture.listing, sellerId: fixture.user.id, status: "draft", price: 100, images: [] };
      let publishCount = 0;
      let fail = true;
      const handle = route => {
        if (route.request().method() === "OPTIONS") return route.fallback();
        if (route.request().method() === "PATCH") {
          const body = route.request().postDataJSON();
          if (body.action === "publish") {
            publishCount++;
            if (fail) return json(route, { error: "network", message: "تعذّر الاتصال. أعد المحاولة." }, 503);
            draft.status = "published";
          } else Object.assign(draft, body);
        }
        return json(route, { listing: draft });
      };
      await context.route(`**/api/marketplace/me/listings/${fixture.listingId}`, handle);
      await context.route(`**/api/marketplace/listings/${fixture.listingId}`, handle);
      await page.goto(fixture.origin + `/create/${fixture.listingId}`);
      await page.getByRole("button", { name: "معاينة الإعلان", exact: true }).click();
      await page.getByRole("button", { name: "نشر الإعلان", exact: true }).click();
      const confirm = page.getByRole("dialog", { name: "نشر الإعلان", exact: true });
      await expect(confirm).toBeVisible();
      await page.screenshot({ path: path.join(output, "publish-confirmation.png") });
      await confirm.getByRole("button", { name: "تأكيد النشر", exact: true }).click();
      await expect.poll(() => publishCount).toBe(1);
      await expect(page.getByText("تعذّر الاتصال. أعد المحاولة.", { exact: true })).toBeVisible();
      await expect(page.getByText(/^تم حفظ الإعلان(?: والصور)?$/)).toHaveCount(0);
      await page.screenshot({ path: path.join(output, "publish-modal-error.png") });
      fail = false;
      await page.getByRole("button", { name: "نشر الإعلان", exact: true }).click();
      await confirm.getByRole("button", { name: "تأكيد النشر", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "تم نشر إعلانك", exact: true })).toBeVisible();
      await page.getByRole("dialog", { name: "تم نشر إعلانك", exact: true }).getByRole("button", { name: "عرض الإعلان", exact: true }).click();
      await expect(page.getByText("تعذّر الاتصال. أعد المحاولة.", { exact: true })).toHaveCount(0);
      assert.equal(publishCount, 2);
      assert.equal(draft.images.length, 0, "No new photo requirement was introduced");
    });

    assert.deepEqual(fixture.report.browserErrors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ boundary: "Isolated React Native Web, mocked APIs; no native device or production writes", results, browserErrors: fixture.report.browserErrors, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length }, null, 2) + "\n");
    if (results.some(result => !result.passed)) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
