import assert from "node:assert/strict";
import test from "node:test";
import { userMessage } from "../src/core/errors.ts";

test("native Firebase diagnostics never reach the customer message", () => {
  assert.equal(userMessage(new Error("Unable to get Firebase Messaging instance. Default FirebaseApp is not initialized. Call FirebaseApp.initializeApp(Context).")), "الإشعارات غير متاحة في هذه النسخة.");
});

test("network and server failures have short messages without diagnostic bodies", () => {
  assert.equal(userMessage(new TypeError("Network request failed")), "تعذّر الاتصال. أعد المحاولة.");
  assert.equal(userMessage({ code: "network", message: "socket exception" }), "تعذّر الاتصال. أعد المحاولة.");
  assert.equal(userMessage({ status: 503, message: "upstream https://private.example.test/api" }), "الخدمة غير متاحة مؤقتًا. حاول لاحقًا.");
});

test("actionable Arabic validation remains visible while mixed diagnostics are hidden", () => {
  assert.equal(userMessage(new Error("أضف عنوانًا واضحًا من حرفين على الأقل.")), "أضف عنوانًا واضحًا من حرفين على الأقل.");
  assert.equal(userMessage(new Error("رفض السيرفر الرمز. تحقّق من Client ID.")), "تعذّر إتمام الإجراء. أعد المحاولة.");
  assert.equal(userMessage(new Error("تعذر التحميل\n at NativeModule.getToken()"), "تعذّر تحميل البيانات."), "تعذّر تحميل البيانات.");
  assert.equal(userMessage({ code: "account_changed", message: "internal" }), "تغيّر الحساب. أعد المحاولة.");
});
