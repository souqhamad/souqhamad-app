type Failure = { code?: unknown; status?: unknown; message?: unknown };

const publicMessages: Record<string, string> = {
  network: "تعذّر الاتصال. أعد المحاولة.",
  aborted: "تعذّر الاتصال. أعد المحاولة.",
  auth_required: "سجّل الدخول للمتابعة.",
  account_changed: "تغيّر الحساب. أعد المحاولة.",
  listing_not_found: "هذا الإعلان غير متاح حاليًا.",
  conversation_not_found: "المحادثة غير متاحة.",
  commission_locked: "حالة الرسوم معتمدة ولا يمكن تعديلها.",
  commission_agreement_required: "وافق على اتفاقية المنصة للمتابعة.",
  seller_listing_limit_reached: "وصلت إلى الحد المسموح من الإعلانات.",
  account_deactivated: "الحساب موقوف. تواصل مع الدعم.",
  google_native_unavailable: "تسجيل الدخول غير متاح حاليًا.",
  invalid_google_id_token: "تعذّر تسجيل الدخول عبر Google.",
  google_registration_failed: "تعذّر إكمال تسجيل الدخول. حاول لاحقًا.",
  image_too_large: "حجم الصورة يتجاوز الحد المسموح.",
  listing_image_limit_reached: "وصل الإعلان إلى الحد المسموح من الصور.",
  image_uploads_pending: "الصور قيد التجهيز. انتظر أو ألغِ الصور المنتظرة من تعديل الإعلان.",
  push_not_configured: "الإشعارات غير متاحة في هذه النسخة.",
  push_permission_denied: "فعّل الإشعارات من إعدادات الجهاز.",
  push_registration_failed: "تعذّر تفعيل الإشعارات حاليًا.",
};

// Errors may originate in native SDKs, storage, an API or a browser transport.
// Keep their diagnostic details out of the customer interface.
const technicalMessage = /firebase|google-services|initializeApp|messaging instance|NativeModule|TypeError|ReferenceError|SyntaxError|DEVELOPER_ERROR|node_modules|https?:\/\/|\/api\/|Client ID|client_id|SHA-?1|\bcom\.(?:[a-z]\w*\.)+[a-z]\w*|[A-Za-z]:\\|\bat\s+\w+[.(]|^[\s]*[\[{]|<\/?(?:html|body)|\b(?:stack trace|exception|undefined|null)\b/i;

export function userMessage(
  error: unknown,
  fallback = "تعذّر إتمام الإجراء. أعد المحاولة.",
): string {
  if (!error || typeof error !== "object") return fallback;
  const failure = error as Failure;
  if (typeof failure.code === "string" && publicMessages[failure.code])
    return publicMessages[failure.code];
  const message = typeof failure.message === "string" ? failure.message.trim() : "";
  if (/firebase|google-services|initializeApp|messaging instance/i.test(message))
    return publicMessages.push_not_configured;
  if (/network request failed|failed to fetch|networkerror|internet.*offline/i.test(message))
    return publicMessages.network;
  if (failure.status === 429) return "انتظر قليلًا ثم أعد المحاولة.";
  if (typeof failure.status === "number" && failure.status >= 500)
    return "الخدمة غير متاحة مؤقتًا. حاول لاحقًا.";
  if (!message || message.length > 180 || /[\r\n]/.test(message) ||
      !/[\u0600-\u06ff]/.test(message) || technicalMessage.test(message))
    return fallback;
  return message;
}
