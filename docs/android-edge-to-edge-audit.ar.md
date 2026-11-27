# مراجعة Android 15 وedge-to-edge

تاريخ الفحص: 2026-11-01. هذه مراجعة لمصدر تحذير Google Play، وليست إثباتًا لاختفاء التحذير أو نجاح تجربة جهاز.

## النسخة التي فُحصت

فُحص أرشيف `app-release.aab` المحلي قراءةً فقط. أكد `base/manifest/AndroidManifest.xml` داخله:

- `versionName`: `1.0.51`؛ `versionCode`: `327`.
- `targetSdkVersion`: `36`؛ `minSdkVersion`: `24`.
- اتجاه النشاط الرئيسي: `portrait`.
- SHA-256: `735c977eae66d9c324c5a6690180010b13bec1c7bd4111e961e1165c33460302`.

المجلد `android/` المحلي والبناء الموجود فيه يخصان النسخة الأقدم `1.0.50 (239)`؛ لم يُستخدما لإثبات محتويات البناء 327.

## ما يثبت مصدر التحذير

يحوي DEX في البناء 327 مراجع هذه الواجهات: `Window.setStatusBarColor` و`Window.setNavigationBarColor` و`Window.getNavigationBarColor` و`Window.setDecorFitsSystemWindows` و`Window.setStatusBarContrastEnforced`. هذه قائمة المراجع التي تحقق منها الفحص، وليست نقلًا لقائمة Google Play التفصيلية غير المتاحة.

ربطت خريطة R8 المضمنة بعض مواضع النداء بمصادرها الأصلية؛ قد يدمج R8 شيفرة المكتبة في صنف آخر:

| المصدر | الواجهات أو المسار المثبت |
| --- | --- |
| React Native، `WindowUtilKt.enableEdgeToEdge` | تعيين لونَي شريط الحالة والتنقل؛ المصدر المثبت محليًا `react-native@0.88.1`، الملف `ReactAndroid/src/main/java/com/facebook/react/views/view/WindowUtil.kt`، الأسطر 166–188. |
| AndroidX Core، `WindowCompat` | مساعدا `Api30Impl` و`Api35Impl` لتحديد `decorFitsSystemWindows` موجودان في خريطة البناء. |
| Expo ImagePicker، `ExpoCropImageActivity.onCreate` | دمج R8 استدعاء `WindowCompat.enableEdgeToEdge` في النشاط؛ يشمل تعيين لونَي الشريطين. المصدر المحلي يستعمل هذا المساعد في `applyWindowCustomization` عند السطر 167. |
| AndroidX SplashScreen، `SplashScreen.Impl31.applyAppSystemUiTheme` | استعادة لونَي الشريطين عند خروج شاشة البداية؛ ظهرت في خريطة R8 داخل مستمع الخروج. |

تثبت بيانات الاعتماديات داخل الأرشيف وجود AndroidX Activity `1.11.0` وCore `1.18.0` وSplashScreen `1.2.0` وMaterial `1.13.0`.

في مصدر React Native المحلي، تعيين لون شريط الحالة ليس محاطًا بشرط يستبعد API 35؛ لون شريط التنقل وضبط التباين لهما مسار API 29 فأحدث ومسار أقدم. وضع فتحة الشاشة يستعمل `ALWAYS` على API 30 فأحدث و`SHORT_EDGES` على الإصدارات الأقدم. لذلك لا يصح وصف جميع المراجع بأنها شيفرة غير قابلة للتنفيذ، ولا حذفها لمجرد إزالة التحذير: بعض السلوك مطلوب للإصدارات الأقدم أو للتنقل بثلاثة أزرار. تثبت هذه المراجعة وجود مسارات الاعتماديات، ولا تعين أيها أظهرته قائمة Play Console تحديدًا.

## ما يفعله التطبيق وما بقي للتحقق

`src/app/_layout.tsx` يثبت `SafeAreaProvider` ويستخدم `StatusBar` لضبط نمط الأيقونات فقط. لا توجد في `src/` أو `app.config.ts` أو الإضافات المحلية استدعاءات مباشرة لواجهات ألوان الشريطين القديمة، ولا خصائص `backgroundColor` أو `translucent` على `StatusBar`، ولا استدعاءات NavigationBar.

يعالج `Screen` الأعلى والجانبين؛ وتحسب المكونات السفلية مسافاتها من safe-area. يحسب عارض الصور الجهات الأربع، وتعالج مكونات المحادثات والنماذج تداخل لوحة المفاتيح المقاس فعليًا. كذلك يفعّل React Native المودالات الممتدة إلى الحواف عند تفعيل edge-to-edge؛ عدم تمرير خصائص translucency صراحةً لا يثبت عطلًا في هذه النسخة.

لم تُضف معالجة native غير مثبتة، ولم يتغير `orientation` أو `ios.supportsTablet`. إصلاح تخطيط الشريط والبطاقات لا يزيل مراجع APIs داخل المكتبات، ولا يثبت زوال تحذير Play Console. يحتاج إثبات السلامة البصرية إلى تشغيل البناء الجديد على Android 15/16 مع الإيماءات والأزرار الثلاثة، وفحص المودالات والكيبورد وفتحة الشاشة؛ ويحتاج إثبات زوال تحذير المتجر إلى فحص الحزمة الجديدة في Play Console.

## تحديث توافق SDK

كشف `expo install --check` عن ترقيعات موصى بها داخل SDK 58. ثُبتت عبر Expo installer: `expo ~58.0.22` و`expo-build-properties ~58.0.12` و`expo-dev-client ~58.0.18` و`expo-router ~58.0.29` و`react-native-screens ~4.30.1`. أُضيف `@expo/metro-runtime ~58.0.16` صراحةً بالطريقة نفسها لتلبية اعتماد Router المحدّث بدل إبقاء الإصدار غير المتوافق `58.0.15`. جُهز لاحقًا الإصدار `1.0.52` بقاعدة بناء `328`، بينما بيانات AAB `1.0.51 (327)` أعلاه تظل نتائج فحص الحزمة السابقة.

قورنت مصادر الحزمة المنشورة `react-native-screens@4.30.1` بالمثبتة `4.30.0`: التغييرات في سبعة ملفات iOS، دون اختلاف في مصادر Android أو `src/`. لذلك تحديث التوافق لا يمثل إصلاحًا مثبتًا لواجهات Android المهملة، ولا يغير نتائج فحص AAB 327 السابق. سجل `expo-build-properties` يذكر تحديث `@expo/schema-utils` إلى `58.0.3`، وسجل `expo-dev-client` يذكر تحديث `expo-dev-launcher` إلى `58.0.18`.

المراجع: [تغييرات Android 15](https://developer.android.com/about/versions/15/behavior-changes-15#edge-to-edge)، [System bars في Expo](https://docs.expo.dev/develop/user-interface/system-bars/)، [StatusBar في Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/status-bar/)، [Safe areas في Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/safe-area-context/).
