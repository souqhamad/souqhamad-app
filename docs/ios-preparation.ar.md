# تجهيز سوق حمد لآيفون

## ما جُهّز في الكود

نسخة آيفون تستخدم زر **Sign in with Apple** الأصلي فقط؛ Google باقٍ على Android. استُبعدت مكتبة Google الأصلية من ربط iOS عبر إعداد Expo Autolinking، مع بقائها في Android. يتحقق الزر من دعم الجهاز ومن `auth.apple` في bootstrap، ويحتفظ بالموافقة على الشروط والعمولة قبل الدخول. غياب إعداد Apple في AWS يبقي الدخول غير متاح؛ تجهيز الحزمة لا يفعّله تلقائيًا.

السيرفر يميّز هوية `apple:` عن هوية `google:`، ويمكنه إرجاع الحساب النشط الموجود عندما يتطابق البريد الموثّق. استخدام «إخفاء بريدي» في Apple قد ينتج هوية وبريدًا مختلفين؛ لا يُفترض أن ذلك ينقل إعلانات حساب Google أو محادثاته تلقائيًا.

الحزمة `com.souqhamad.app`، والإصدار `1.0.57`، والبناء `433 + PROJECT_BUILD_NUMBER` في Codemagic مع استمرار عداد المشروع دون تصفيره. الاتجاه رأسي، و`supportsTablet=false` كما اتُّفق سابقًا. أضيفت بيئة APNs الإنتاجية؛ توجد Associated Domains وSign in with Apple. أغراض الكاميرا والصور والموقع عربية، وأزيل تصريح Face ID والحركة والموقع الدائم لأن التطبيق لا يستخدمها. لم تُضف خدمات Firebase إلى iOS.

مسار **Souq Hamad iOS Release** يدوي ويعمل على Mac M2 وXcode 26.6. يفحص المدخلات، ويثبت pnpm المثبت محليًا، ويشغّل الأنواع وlint والاختبارات، ثم يولّد iOS وPods ويجلب ملفات التوقيع ويبني IPA. يفحص الناتج الموقّع: رقم الإصدار والبناء، وهوية التطبيق والفريق، وملف تعريف App Store وصلاحيته، وصلاحيات Apple وAPNs والروابط، والاتجاه الرأسي. لا يتضمن المسار نشرًا تلقائيًا إلى المتجر أو TestFlight.

## إعداد حساب Apple وCodemagic لاحقًا

1. من Apple Developer ← Certificates, Identifiers & Profiles، سجّل App ID صريحًا `com.souqhamad.app` وفعّل **Sign in with Apple** و**Push Notifications** و**Associated Domains**. استخدم فريق Apple نفسه في التوقيع وإعداد السيرفر.
2. من App Store Connect أنشئ سجل التطبيق للحزمة نفسها. جهّز مفتاح App Store Connect API للفريق بصلاحية مناسبة لإدارة شهادات التوزيع وملفات التعريف وفق [دليل Codemagic](https://docs.codemagic.io/yaml-code-signing/alternative-code-signing-methods/). ليس هذا مفتاح Sign in with Apple أو APNs.
3. في Codemagic ← Environment variables أنشئ المجموعة **ios_release** وأضف القيم السرية التالية. لا تُرسلها في المحادثة ولا تحفظها في Git:

| المتغير | القيمة المطلوبة |
| --- | --- |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID الخاص بمفتاح App Store Connect، بصيغة UUID |
| `APP_STORE_CONNECT_KEY_IDENTIFIER` | Key ID الخاص بالمفتاح نفسه |
| `APP_STORE_CONNECT_PRIVATE_KEY` | محتوى ملف `.p8` كاملًا بأسطره الفعلية، وليس Base64 |
| `CERTIFICATE_PRIVATE_KEY` | مفتاح RSA غير مشفّر، 2048 بت أو أكثر، لشهادة Apple Distribution التي سيستخدمها CI؛ احتفظ بالمفتاح المطابق عند إعادة البناء |

يعتمد `fetch-signing-files --create` على هذه المجموعة لجلب أو إنشاء شهادة وملف تعريف مطابقين. لا يهيّئ قدرات App ID بدلًا عنك. لا تضع هذه القيم ضمن متغيرات تبدأ بـ`EXPO_PUBLIC_`.

4. بعد تجهيز خدمات AWS أدناه، ابدأ المسار يدويًا على `main`. تنزيل IPA لا يجعله قابلًا للتثبيت المباشر على هاتف عشوائي؛ هذه حزمة توزيع App Store. ارفعه إلى App Store Connect للاختبار عبر TestFlight بعد استكمال المتطلبات، ثم قدّمه للمراجعة عندما يصبح جاهزًا. لم تُنفَّذ هذه الخطوة ضمن التجهيز المحلي.

## إعداد السيرفر في AWS لاحقًا

توجد مسارات الدخول وAPNs في المشروع الأساسي؛ لم تُغيّر هذه المهمة كود السيرفر أو متغيراته. أضف القيم الفعلية عبر مخزن الأسرار/إعداد الخدمة المعتمد، ثم انشر إعداد الخدمة:

| الوظيفة | متغيرات السيرفر |
| --- | --- |
| تسجيل Apple الأصلي | `APPLE_NATIVE_CLIENT_ID=com.souqhamad.app`، و`APPLE_TEAM_ID`، و`APPLE_KEY_ID`، و`APPLE_PRIVATE_KEY` من مفتاح Apple الذي فُعّلت له Sign in with Apple |
| إرسال الإشعارات | `APNS_TEAM_ID`، و`APNS_KEY_ID`، و`APNS_PRIVATE_KEY` من مفتاح APNs، و`APNS_BUNDLE_ID=com.souqhamad.app`، و`APNS_USE_SANDBOX=0` لحزمة App Store/TestFlight |
| Universal Links | يستخدم ملف `/.well-known/apple-app-site-association` القيمتين `APPLE_TEAM_ID` و`APPLE_NATIVE_CLIENT_ID` نفسيهما؛ تحقّق من رده الفعلي بعد النشر |

`APPLE_CLIENT_ID` يخص دخول الويب وليس بديلًا عن `APPLE_NATIVE_CLIENT_ID`. مفاتيح App Store Connect وSign in with Apple وAPNs وظائف مختلفة، ولا تُستبدل قيم إحداها بالأخرى. لا تحتاج نسخة آيفون عميل Google iOS أو GoogleService-Info.plist.

بعد النشر تأكد أن `https://souqhamad.com/api/mobile/bootstrap` يعرض `auth.apple=true`. اختبر على آيفون الدخول والإلغاء والخروج، وإنشاء إعلان وصوره وفتح العارض، والمحادثات ولوحة المفاتيح، وإذن الإشعارات ووصولها وفتح وجهتها، وحذف الحساب. لا يُعد تصدير JavaScript أو تمويه APNs اختبارًا حيًا لهذه الخدمات.

## متطلبات لمراجعة Apple ما زالت غير مكتملة

- **إلغاء تفويض Apple عند حذف الحساب:** استُكمل مساره في تحديث السيرفر اللاحق عبر حفظ الرموز مشفّرة وإلغائها قبل حذف الحساب. يتطلب نشر ترحيل قاعدة البيانات وإعداد Apple الفعلي ثم اختبار الحذف حيًا، مع إبقاء حماية السجلات المالية والأدلة. راجع [تعليمات Apple لحذف الحساب](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion/).
- **مشاركة بيانات حمد:** التطبيق يوضح مشاركة رسائل حمد والصور المختارة مع خدمة خارجية للذكاء الاصطناعي، ويطلب موافقة صريحة قبل إرسالها في المحادثة. يمكن رفضها والاستمرار يدويًا، وسحبها من «حسابي». الموافقة منفصلة لكل حساب وسيرفر وإصدار إفصاح، ويحفظها الجهاز بشكل آمن لمدة لا تتجاوز سنة. اقتراح التصنيف من عنوان الإعلان تلقائي دون حوار موافقة منفصل، وزر إيقافه مستقل عن موافقة حمد؛ وتوضح سياسة الخصوصية مساره. يتطلب تطبيق هذا السلوك نشر السيرفر وبناء نسخة التطبيق المحدثة. راجع [Apple 5.1.2(i)](https://developer.apple.com/app-store/review/guidelines/#5.1.2).
- استكمل بيانات App Privacy وفق البيانات الفعلية والمزودين، ورابط الخصوصية والدعم، والتصنيف العمري لمحتوى العملاء، ولقطات آيفون، ومعلومات تمكّن مراجع Apple من اختبار الوظائف المحمية دون تجاوز حماية الإنتاج.
- مكتبات React Native وExpo المستخدمة تتضمن ملفات PrivacyInfo. لا يكفي غياب تعريف إضافي في app.config لإثبات نقص؛ يلزم فحص ملفات الخصوصية المدمجة في IPA النهائي ونتيجة App Store Connect.

هذا تجهيز للبناء، ولا يعني جاهزية التقديم أو ضمان قبول Apple. المرجع الحالي للأدوات هو [متطلبات Apple](https://developer.apple.com/news/upcoming-requirements/) و[صورة Xcode لدى Codemagic](https://docs.codemagic.io/specs-macos/xcode-26-6/).

## سجل التحقق المحلي

- نجح TypeScript وESLint، و**370 اختبارًا** دون فشل أو تخطي، بما فيها زر Apple وحالات الإلغاء وتعطيل السيرفر وفحوص مدخلات التوقيع وأرشيف مموّه.
- نجح تصدير Expo لحزم iOS وAndroid والويب؛ هذا تصدير JavaScript/Hermes، وليس حزمة IPA/AAB موقّعة.
- فُحصت إعدادات iOS الفعلية المتولدة عبر Expo introspection: صلاحيات Apple وAPNs الإنتاجية والروابط، والأذونات المستخدمة، وعدم وجود أغراض Face ID والحركة والموقع الدائم والميكروفون. اختُبر توافق الاتجاهين الرأسيين اللذين يولدهما Expo مع فاحص الأرشيف، مع تمويه حقول Xcode غير المتاحة محليًا.
- أظهر ناتج Expo Autolinking الفعلي استبعاد Google من iOS وبقاءه في Android. فُحصت بنية YAML، وبقي مسار Android يعمل عند الدفع بينما iOS يدوي بلا publishing.
- ملفات التحقق المحلية في `.data/ios-preparation/` مستثناة من Git. لم تتغير بيانات الإنتاج أو كود السيرفر.

لا يمكن توليد مشروع iOS الأصلي أو بناء/توقيع IPA على بيئة Windows الحالية؛ رفض Expo تنفيذ prebuild لـiOS على هذه البيئة كما هو متوقع. يُنفَّذ ذلك في Codemagic على macOS. لم تُختبر مفاتيح Apple أو Pods أو APNs الحية أو جهاز آيفون، ولم يبدأ بناء أو رفع إلى المتجر ضمن هذه المهمة.
