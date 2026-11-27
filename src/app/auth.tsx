import { useEffect, useRef, useState } from "react";
import { useFeedback } from "../ui/feedback";
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import * as AppleAuthentication from "expo-apple-authentication";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "../core/auth";
import { googleSignInErrorMessage } from "../core/native-auth";
import { useBootstrap } from "../core/bootstrap";
import { userMessage } from "../core/errors";
import Constants from "expo-constants";
import { AppText, Button, Card, Icon, PageHeader, Screen, createThemedStyles, useTheme } from "../ui";
export default function AuthScreen() {
  const feedback = useFeedback();
  const { colors, scheme } = useTheme();
  const s = useStyles();
  const auth = useAuth();
  const bootstrap = useBootstrap();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [appleAvailable, setAppleAvailable] = useState<boolean | null>(null);
  const attempted = useRef(false);
  const loginPending = useRef(false);
  const appleDisabled = !bootstrap.data?.auth.apple || busy !== null;
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let active = true;
    void AppleAuthentication.isAvailableAsync().then(
      available => { if (active) setAppleAvailable(available); },
      () => { if (active) setAppleAvailable(false); },
    );
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!attempted.current || auth.status !== "authenticated" || !auth.user) return;
    attempted.current = false;
    feedback.success("تم تسجيل دخولك");
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [auth.status, auth.user, feedback]);
  async function login(provider: "google" | "apple") {
    if (
      loginPending.current || !bootstrap.data?.auth[provider] ||
      (provider === "google" && Platform.OS === "ios") ||
      (provider === "apple" && !appleAvailable)
    ) return;
    if (!accepted) {
      setError("حدّد مربع الموافقة على الشروط ورسوم المنصة قبل تسجيل الدخول.");
      return;
    }
    loginPending.current = true;
    setBusy(provider);
    attempted.current = true;
    setError("");
    try {
      await auth.acceptAgreement();
      const signedIn =
        provider === "google"
          ? await auth.signInGoogle()
          : (await auth.signInApple(), true);
      if (!signedIn) attempted.current = false;
    } catch (e) {
      attempted.current = false;
      const code = (e as { code?: string }).code;
      if (code !== "ERR_REQUEST_CANCELED" && code !== "SIGN_IN_CANCELLED")
        setError(userMessage(new Error(
          provider === "google"
            ? googleSignInErrorMessage(
                e,
                Platform.OS === "android"
                  ? Constants.expoConfig?.android?.package
                  : undefined,
              )
            : e instanceof Error
              ? e.message
              : "تعذّر تسجيل الدخول.",
        ), "تعذّر تسجيل الدخول. أعد المحاولة."));
    } finally {
      loginPending.current = false;
      setBusy(null);
    }
  }
  if (auth.user)
    return (
      <Screen scroll>
        <PageHeader title="مرحبًا بك" back />
        <Card>
          <AppText variant="heading">
            {auth.user.name || "تم تسجيل دخولك"}
          </AppText>
          <Button
            title="متابعة إلى السوق"
            onPress={() => router.replace("/")}
          />
        </Card>
      </Screen>
    );
  return (
    <Screen scroll>
      <PageHeader title="أهلًا بك في سوق حمد" back />
      <LinearGradient colors={[colors.primarySoft, colors.background]} style={s.hero}>
        <View style={s.mark}>
          <Icon name="storefront-outline" size={40} color={colors.primary} />
        </View>
        <AppText variant="title">مكانك للبيع والشراء</AppText>
        <AppText color={colors.muted} style={{ textAlign: "center" }}>
          حساب واحد لإعلاناتك ومحادثاتك والأشياء التي تهمك.
        </AppText>
      </LinearGradient>
      <Card>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: accepted }}
          onPress={() => {
            setAccepted(!accepted);
            setError("");
          }}
          style={s.agreement}
        >
          <View
            style={[
              s.check,
              accepted
                ? {
                    backgroundColor: colors.primaryFill,
                    borderColor: colors.primaryFill,
                  }
                : undefined,
            ]}
          >
            {accepted ? (
              <Icon name="checkmark" color={colors.onPrimary} size={16} />
            ) : null}
          </View>
          <AppText style={{ flex: 1, fontSize: 12, lineHeight: 23 }}>
            أوافق على شروط الاستخدام والسياسات، وأقر برسوم المنصة بنسبة 1% من
            قيمة البيع عند إتمام البيع عبر سوق حمد.
          </AppText>
        </Pressable>
        <View style={s.links}>
          {[
            ["terms", "الشروط"],
            ["privacy", "الخصوصية"],
            ["listings", "الإعلانات"],
            ["commissions", "الرسوم"],
          ].map(([id, label]) => (
            <Pressable key={id} onPress={() => router.push(`/policies/${id}`)}>
              <AppText color={colors.primary} variant="caption">
                {label}
              </AppText>
            </Pressable>
          ))}
        </View>
        {Platform.OS !== "ios" ? <Button
          title="المتابعة باستخدام Google"
          icon="logo-google"
          variant="secondary"
          disabled={!bootstrap.data?.auth.google || busy !== null}
          loading={busy === "google"}
          onPress={() => void login("google")}
        /> : null}
        {!accepted ? (
          <AppText variant="caption" color={colors.muted}>
            حدّد مربع الموافقة أعلاه لتفعيل تسجيل الدخول.
          </AppText>
        ) : null}
        {Platform.OS !== "ios" && bootstrap.data && !bootstrap.data.auth.google ? (
          <AppText color={colors.danger}>
            تسجيل Google غير مهيأ على السيرفر حاليًا.
          </AppText>
        ) : null}
        {Platform.OS === "ios" && appleAvailable ? (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={scheme === "dark"
              ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
              : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={16}
            style={s.appleButton}
            pointerEvents={appleDisabled ? "none" : "auto"}
            accessibilityState={{ disabled: appleDisabled, busy: busy === "apple" }}
            onPress={() => { if (!appleDisabled) void login("apple"); }}
          />
        ) : null}
        {Platform.OS === "ios" && busy === "apple" ? (
          <View style={s.appleProgress}>
            <ActivityIndicator color={colors.primary} />
            <AppText variant="caption" accessibilityLiveRegion="polite">
              جارٍ تسجيل الدخول باستخدام Apple
            </AppText>
          </View>
        ) : null}
        {Platform.OS === "ios" && bootstrap.data && !bootstrap.data.auth.apple ? (
          <AppText color={colors.danger}>
            تسجيل الدخول باستخدام Apple غير متاح حاليًا.
          </AppText>
        ) : null}
        {Platform.OS === "ios" && appleAvailable === false && bootstrap.data?.auth.apple ? (
          <AppText color={colors.muted}>
            تسجيل الدخول باستخدام Apple غير متاح على هذا الجهاز.
          </AppText>
        ) : null}
        {bootstrap.isError ? (
          <>
            <AppText color={colors.danger}>تعذّر تحميل خيارات الدخول.</AppText>
            <Button
              title="إعادة المحاولة"
              variant="ghost"
              onPress={() => void bootstrap.refetch()}
            />
          </>
        ) : null}
        {error ? <AppText color={colors.danger}>{error}</AppText> : null}
      </Card>
      <View style={s.security}>
        <Icon
          name="shield-checkmark-outline"
          color={colors.success}
          size={18}
        />
        <AppText variant="caption">
          بيانات حسابك وصلاحياته تُدار بأمان عبر سيرفر سوق حمد.
        </AppText>
      </View>
    </Screen>
  );
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({
  hero: { borderRadius: 26, padding: 24, alignItems: "center", gap: 12 },
  mark: {
    width: 84,
    height: 84,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    marginBottom: 8,
  },
  agreement: {
    flexDirection: "row-reverse",
    gap: 12,
    alignItems: "flex-start",
    marginVertical: 8,
  },
  check: {
    width: 23,
    height: 23,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 3,
  },
  links: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 18 },
  appleButton: { width: "100%", height: 44 },
  appleProgress: { flexDirection: "row-reverse", gap: 8, alignItems: "center" },
  security: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
  },
}));
