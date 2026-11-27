# شاشة الترحيب بتصميم الأيقونة

اعتمدت الشاشة في 25 أكتوبر 2026 بطلب المستخدم، خلفية الأيقونة الخضراء والزخارف على كامل المساحة، وشعار «سوق حمد» الأصلي في المنتصف، وشريط التشغيل المتحرك أسفل الشاشة. أضيفت لاحقًا بطلب المستخدم عبارة «سوقك الذكي للبيع والشراء» تحت الشريط بخط أبيض متوسط بمقاس 14 ومسافة 12 عن الشريط.

- المصدر: `assets/app-icon.png`، بقيت الأيقونة الأصلية دون تعديل.
- الخلفية المستخدمة: `assets/welcome-background.png`، أصل محلي مضمّن لا يطلبه التطبيق من الشبكة.
- الشعار: `assets/hamad-market-wordmark.webp` مع معاينة `assets/hamad-market-wordmark-fallback.png`؛ بقيت الكتابة وأبعادها النسبية كما هي. يختلف اسم المعاينة لتجنب تكرار اسم مورد أندرويد بين PNG وWebP.
- التنفيذ: `src/features/welcome/brand-welcome.tsx`. الخلفية تملأ المساحة بنمط `cover`، والشعار يستخدم `contain` بعرض 84% وبحد أقصى 500.

ينتظر الترحيب جاهزية الخلفية والشعار قبل بدء الحركة؛ يُسمح بالانتقال عند فشل أصل حتى لا يعلق التطبيق. يعرض الترحيب لمدة 2700 مللي ثانية ثم يتلاشى خلال 300 مللي ثانية، أي نحو 3 ثوانٍ إجمالًا بعد الجاهزية. بقيت شاشة النظام الخضراء البسيطة وإدارة الافتتاح ومسارات التطبيق كما هي. لا يُعاد تشغيل الترحيب من حدث العودة إلى المقدمة.

## التحقق

نجح `pnpm check` (TypeScript وESLint)، ونجح تصدير Android وiOS والويب بعد التعديل. نجحت معاينة Playwright المحلية في خمس حالات: مقاسات 360×800 و412×915 و768×1024، وتأخير الخلفية، وفشل الخلفية مع الخطوط العربية. فُحصت تغطية الخلفية، ونسب الشعار وتمركزه، وحركة الشريط بقياسين، والانتقال إلى سوق قابل للاستخدام، وعدم إعادة الترحيب عند التنقل للحساب والعودة. لم توجد أخطاء JavaScript أو طلبات غير متوقعة.

تخص المعاينة والتصدير المذكوران نسخة الترحيب قبل إضافة العبارة أسفل الشريط؛ لا تُظهر الصور السابقة هذه الإضافة النصية اللاحقة.

الدليل والصور في `C:\Users\maher\Documents\SouqHamad-Archive\2026-10-25\design-review\welcome-icon-layout`. هذه معاينة React Native Web ببيانات معزولة؛ لم يُبنَ إصدار أصلي موقّع ولم تُجرَ تجربة جهاز خلال هذا التعديل. لم تُدفع التعديلات أو تُنشر.

## أصل الخلفية

استُخدمت مهارة `imagegen` والأداة المدمجة `image_gen` لتحرير خلفية الأيقونة وتمديدها طولياً مع إزالة الكتابة من الخلفية فقط؛ يُركّب الشعار الأصلي فوقها في التطبيق. حُفظ الأصل المولد داخل المشروع في `assets/welcome-background.png` دون استبدال الأيقونة. النسخة الأصلية من مخرجات الأداة محفوظة أيضاً في `C:\Users\maher\.codex\generated_images\01a16883-8f45-77e1-a948-a71bd5025460\exec-862a9dad-fa65-42d3-a1c0-e18c4afed393.png`.

النص النهائي المستخدم في التوليد:

```text
Edit the supplied Souq Hamad app icon into a BACKGROUND-ONLY production asset for a native mobile splash screen. Output a tall portrait image, 9:20 aspect ratio, ideally 1080x2400. Closely preserve the reference icon's exact emerald green/deep teal/navy palette, fine softly textured surface, subtle diagonal green illumination, and thin engraved pointed-arch outlines with quiet dimensional rim highlights. Extend the original background and arch pattern vertically to fill the portrait canvas edge to edge. Remove ONLY the Arabic wordmark and its shadow, replacing it seamlessly with the same green background; the real original wordmark will be overlaid separately by the app, so do not render any writing at all. Arrange two elegant rows of the same repeated arch motifs: one upper row and one lower row; keep the central 28 percent of height quiet and largely free of the arches, so the existing wide white/green logo can be placed at vertical center. Keep the lower 10 percent calm and dark for a small loading bar. No icons, no new logos, no text, no lettering, no phone/device frame, no borders, no white margins, no UI elements. Faithful extension of the provided brand art, not a redesign. The entire canvas is opaque. This is a project asset, not a mockup.
```
