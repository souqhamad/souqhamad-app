import { useActionMutation as useMutation } from "../../ui/action-mutation";
import { useFeedback } from "../../ui/feedback";
import React, { useEffect, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useVisibleQuery as useQuery } from "../../core/visible-query";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { api, getApiIdentity, type ApiIdentity } from "../../core/api";
import { useAuth } from "../../core/auth";
import { useAiConsent } from "../../core/ai-consent";
import { useBootstrap } from "../../core/bootstrap";
import { createThemedStyles, useTheme } from "../../ui/theme-context";
import type { User } from "../../core/types";
import {
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  PageHeader,
  Screen,
} from "../../ui";
import {
  Avatar,
  confirmAction,
  ErrorState,
  formatDate,
  GuestState,
  MenuRow,
  useAccountPalette,
  SectionLabel,
  showError,
  useAccountStyles,
} from "./shared";

export function AccountScreen() {
  const feedback = useFeedback();
  const palette = useAccountPalette();
  const shared = useAccountStyles();
  const local = useLocalStyles();
  const { user, status, refresh, signOut } = useAuth();
  const aiConsent = useAiConsent(user?.id ?? "");
  const [refreshing, setRefreshing] = useState(false);
  const reload = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } catch (error) {
      showError(error, "تعذّر تحديث الحساب");
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <Screen scroll={false}>
      <PageHeader title="حسابي" />
      <ScrollView
        contentContainerStyle={shared.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void reload()}
            tintColor={palette.primary}
            colors={[palette.primary]}
            progressBackgroundColor={palette.surface}
          />
        }
      >
        {status === "loading" ? (
          <LoadingState />
        ) : status === "guest" ? (
          <GuestState />
        ) : (
          <>
            <Card style={{ padding: 0 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="تعديل حسابي"
                onPress={() => router.push("/account/edit")}
                style={local.profile}
              >
                <Avatar name={user?.name} picture={user?.picture} size={48} />
                <View style={shared.grow}>
                  <AppText variant="label" numberOfLines={1}>{user?.name || "حسابي"}</AppText>
                  <AppText variant="caption" numberOfLines={1} color={palette.muted}>
                    {user?.email}
                  </AppText>
                </View>
                <Icon name="create-outline" size={20} color={palette.primary} />
              </Pressable>
            </Card>
            <View>
              <SectionLabel>حسابي</SectionLabel>
              <Card style={local.menuCard}>
                <MenuRow
                  title="إعلاناتي"
                  icon="albums-outline"
                  onPress={() => router.push("/(tabs)/listings")}
                />
                <MenuRow
                  title="محادثاتي"
                  icon="chatbubbles-outline"
                  onPress={() => router.push("/(tabs)/messages")}
                />
                <MenuRow
                  title="المفضلة"
                  icon="heart-outline"
                  onPress={() => router.push("/(tabs)/favorites")}
                />
                <MenuRow
                  title="الإشعارات"
                  icon="notifications-outline"
                  onPress={() => router.push("/notifications")}
                />
                <MenuRow
                  title="قائمة المتابعة"
                  icon="people-outline"
                  onPress={() => router.push("/account/follows")}
                />
                <MenuRow
                  title="رسوم المنصة"
                  icon="wallet-outline"
                  onPress={() => router.push("/commissions")}
                />
                <MenuRow
                  title={aiConsent.accepted ? "إيقاف مشاركة بيانات حمد" : "مشاركة بيانات محادثة حمد"}
                  icon="sparkles-outline"
                  onPress={() => {
                    if (aiConsent.accepted) confirmAction(
                      "إيقاف مشاركة بيانات حمد",
                      "لن تُرسل رسائل أو صور جديدة إلى حمد حتى توافق مجددًا.",
                      () => { void aiConsent.revoke().then(() => feedback.info("تم إيقاف مشاركة بيانات حمد")).catch(error => feedback.error(error, "تعذّر حفظ إيقاف المشاركة.")); },
                      "إيقاف المشاركة",
                    );
                    else void aiConsent.request();
                  }}
                />
              </Card>
            </View>
          </>
        )}
        <AppearanceSettings />
        <View>
          <SectionLabel>عن سوق حمد</SectionLabel>
          <Card style={local.menuCard}>
            <MenuRow
              title="شروط الاستخدام"
              icon="document-text-outline"
              onPress={() => router.push("/policies/terms")}
            />
            <MenuRow
              title="سياسة الإعلانات"
              icon="shield-checkmark-outline"
              onPress={() => router.push("/policies/listings")}
            />
            <MenuRow
              title="سياسة الخصوصية"
              icon="lock-closed-outline"
              onPress={() => router.push("/policies/privacy")}
            />
            <MenuRow
              title="سياسة رسوم المنصة"
              icon="receipt-outline"
              onPress={() => router.push("/policies/commissions")}
            />
            <MenuRow
              title="تواصل مع الدعم"
              icon="mail-outline"
              onPress={() =>
                void Linking.openURL("mailto:support@souqhamad.com").catch(
                  showError,
                )
              }
            />
          </Card>
        </View>
        {status === "authenticated" && (
          <Button
            title="تسجيل الخروج"
            variant="ghost"
            icon="log-out-outline"
            onPress={() =>
              confirmAction(
                "تسجيل الخروج",
                "يمكنك متابعة تصفح السوق بعد تسجيل الخروج.",
                () => {
                  feedback.expectSignOut("تم تسجيل الخروج");
                  void signOut().catch(error => feedback.error(error));
                },
                "تسجيل الخروج",
              )
            }
          />
        )}
      </ScrollView>
    </Screen>
  );
}

function AppearanceSettings() {
  const feedback = useFeedback();
  const { colors, preference, setPreference } = useTheme();
  const local = useLocalStyles();
  const options = [
    { value: "system", label: "حسب الجهاز", icon: "phone-portrait-outline" },
    { value: "light", label: "فاتح", icon: "sunny-outline" },
    { value: "dark", label: "داكن", icon: "moon-outline" },
  ] as const;
  return <View>
    <SectionLabel>المظهر</SectionLabel>
    <Card style={local.appearanceCard}>
      <View accessibilityRole="radiogroup" accessibilityLabel="المظهر" style={local.appearanceOptions}>
        {options.map(option => {
          const selected = preference === option.value;
          return <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: selected }}
            aria-checked={selected}
            onPress={() => {
              if (selected) return;
              setPreference(option.value);
              feedback.info(`المظهر: ${option.label}`);
            }}
            style={[local.appearanceOption, selected && local.appearanceSelected]}
          >
            <Icon name={option.icon} size={18} color={selected ? colors.onPrimary : colors.muted} />
            <AppText variant="caption" color={selected ? colors.onPrimary : colors.text}>
              {option.label}
            </AppText>
          </Pressable>;
        })}
      </View>
    </Card>
  </View>;
}

export function EditAccountScreen() {
  const feedback = useFeedback();
  const palette = useAccountPalette();
  const shared = useAccountStyles();
  const local = useLocalStyles();
  const { user, status, signOut, applyProfileUser, runProfileWrite } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // Hydrate this form when the authenticated server profile changes.

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The server account can change while this form remains mounted.
    setName(user?.name || "");
    setPhone(user?.phoneNumber || "");
  }, [user?.id, user?.name, user?.phoneNumber]);
  const save = useMutation({
    mutationFn: ({ identity, displayName, phoneNumber }: {
      identity: ApiIdentity;
      displayName: string;
      phoneNumber: string;
    }) => runProfileWrite(identity, async assertCurrent => {
      const result = await api.patch<{ user: User }>("/api/account/profile", {
        displayName,
        phoneNumber,
      }, { expectedIdentity: identity });
      assertCurrent();
      applyProfileUser(result.user, identity);
    }),
    onSuccess: () => {
      feedback.success("تم حفظ بيانات حسابك");
    },
    onError: error => feedback.error(error),
  });
  const picture = useMutation({
    mutationFn: (identity: ApiIdentity) => runProfileWrite(identity, async assertCurrent => {
      const selected = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      assertCurrent();
      if (selected.canceled || !selected.assets[0]) return;
      if (
        !selected.assets[0].width ||
        !selected.assets[0].height ||
        selected.assets[0].width * selected.assets[0].height > 45_000_000
      )
        throw new Error("اختر صورة واضحة لا تتجاوز 45 مليون بكسل.");
      const context = ImageManipulator.ImageManipulator.manipulate(
        selected.assets[0].uri,
      );
      let rendered: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
      try {
        if (Math.max(selected.assets[0].width, selected.assets[0].height) > 1000)
          context.resize(
            selected.assets[0].width >= selected.assets[0].height
              ? { width: 1000 }
              : { height: 1000 },
          );
        rendered = await context.renderAsync();
        assertCurrent();
        const image = await rendered.saveAsync({
          compress: 0.85,
          format: ImageManipulator.SaveFormat.JPEG,
        });
        assertCurrent();
        const result = await api.upload<{ user: User }>("/api/account/profile/picture", {
          uri: image.uri,
          name: "profile.jpg",
          type: "image/jpeg",
        }, { expectedIdentity: identity });
        assertCurrent();
        applyProfileUser(result.user, identity);
      } finally {
        rendered?.release();
        context.release();
      }
      assertCurrent();
      return true;
    }),
    onSuccess: uploaded => { if (uploaded) feedback.success("تم تحديث صورة حسابك"); },
    onError: error => feedback.error(error),
  });
  const removePicture = useMutation({
    mutationFn: (identity: ApiIdentity) => runProfileWrite(identity, async assertCurrent => {
      const result = await api.delete<{ user: User }>("/api/account/profile/picture", undefined, {
        expectedIdentity: identity,
      });
      assertCurrent();
      applyProfileUser(result.user, identity);
    }),
    onSuccess: () => {
      feedback.success("تمت إزالة صورة حسابك");
    },
    onError: error => feedback.error(error),
  });
  const deleteAccount = useMutation({
    mutationFn: () => api.delete("/api/account/profile"),
    onSuccess: async () => {
      feedback.expectSignOut("تم تنفيذ طلب حذف حسابك");
      await signOut();
      queryClient.clear();
      router.replace("/");
    },
    onError: error => feedback.error(error),
  });
  return (
    <Screen scroll={false}>
      <PageHeader title="تعديل حسابي" back />
      {status === "loading" ? (
        <LoadingState />
      ) : status === "guest" ? (
        <GuestState />
      ) : (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={shared.content}
        >
          <Card style={local.photoCard}>
            <Avatar name={user?.name} picture={user?.picture} size={72} />
            <View style={shared.row}>
              <Button
                title="تغيير الصورة"
                variant="secondary"
                icon="camera-outline"
                loading={picture.isPending}
                onPress={() => picture.mutate(getApiIdentity())}
              />
              {user?.picture && (
                <Button
                  title="إزالة"
                  variant="ghost"
                  loading={removePicture.isPending}
                  onPress={() => {
                    const identity = getApiIdentity();
                    confirmAction(
                      "إزالة صورة الحساب",
                      "ستعود صورة الحساب إلى الحرف الأول من اسمك.",
                      () => removePicture.mutate(identity),
                      "إزالة",
                      true,
                    );
                  }}
                />
              )}
            </View>
          </Card>
          <Card style={shared.stack}>
            <AppText variant="heading">بياناتك الشخصية</AppText>
            <Field
              label="الاسم الظاهر"
              value={name}
              onChangeText={setName}
              maxLength={80}
              autoComplete="name"
            />
            <Field
              label="رقم الجوال"
              placeholder="05xxxxxxxx"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
            />
            <AppText variant="caption" color={palette.muted}>
              يمكن للمستخدمين التواصل معك بالرقم الذي تضيفه. احذفه لحصر التواصل
              بالمحادثات الداخلية.
            </AppText>
            <Button
              title="حفظ التغييرات"
              icon="checkmark-outline"
              loading={save.isPending}
              disabled={!name.trim()}
              onPress={() => save.mutate({
                identity: getApiIdentity(),
                displayName: name.trim(),
                phoneNumber: phone.trim(),
              })}
            />
          </Card>
          <Card style={shared.stack}>
            <AppText variant="heading" color={palette.danger}>
              حذف الحساب
            </AppText>
            <AppText color={palette.muted}>
              اطّلع على تفاصيل الحذف قبل المتابعة. قد تحتفظ المنصة بالبيانات
              التي يلزم الاحتفاظ بها نظاميًا أو لحماية أدلة البلاغات.
            </AppText>
            <Button
              title="قراءة سياسة الحذف"
              variant="ghost"
              onPress={() => router.push("/policies/deletion")}
            />
            <Button
              title="حذف حسابي نهائيًا"
              variant="danger"
              icon="trash-outline"
              loading={deleteAccount.isPending}
              onPress={() =>
                confirmAction(
                  "حذف حسابك؟",
                  "سيتم حذف الحساب وتسجيل خروجك. ستفقد الوصول إلى إعلاناتك ومحادثاتك والمفضلة المرتبطة به. هذا الإجراء لا يمكن التراجع عنه.",
                  () => deleteAccount.mutate(),
                  "حذف الحساب",
                  true,
                )
              }
            />
          </Card>
        </ScrollView>
      )}
    </Screen>
  );
}

type FollowPerson = {
  id: string;
  userId: string;
  name: string;
  picture?: string;
  publishedListingCount: number;
  createdAt: string;
  isFollowing: boolean;
};
type SimilarFollow = {
  id: string;
  listingId: string;
  title: string;
  city?: string;
  image?: string;
  createdAt: string;
};
type FollowsPayload = {
  followers: FollowPerson[];
  following: FollowPerson[];
  similarListingFollows: SimilarFollow[];
  followerCount: number;
  followingCount: number;
  similarListingFollowCount: number;
};

export function FollowsScreen() {
  const feedback = useFeedback();
  const palette = useAccountPalette();
  const shared = useAccountStyles();
  const { user, status } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"following" | "followers" | "similar">(
    "following",
  );
  const query = useQuery({
    queryKey: ["account", user?.id, "follows"],
    queryFn: ({ signal }) => api.get<FollowsPayload>("/api/marketplace/me/follows", undefined, { signal }),
    enabled: status === "authenticated",
  });
  const change = useMutation({
    onMutate: () => ({ userId: user?.id }),
    mutationFn: ({ id, similar }: { id: string; similar?: boolean }) =>
      api.post<{ isFollowing: boolean }>(
        similar
          ? `/api/marketplace/listings/${encodeURIComponent(id)}/similar-follow`
          : `/api/marketplace/users/${encodeURIComponent(id)}/follow`,
      ),
    onSuccess: (data, variables, context) => {
      if (!context?.userId) return;
      if (typeof data.isFollowing === "boolean") feedback.success(data.isFollowing ? "تم تفعيل المتابعة" : "تم إلغاء المتابعة");
      void queryClient.invalidateQueries({
        queryKey: ["account", context.userId, "follows"],
      });
      if (variables.similar) {
        void queryClient.invalidateQueries({
          queryKey: ["account", context.userId, "similar-follow", variables.id],
        });
      }
    },
    onError: error => feedback.error(error),
  });
  const people =
    query.data?.[tab === "followers" ? "followers" : "following"] || [];
  return (
    <Screen scroll={false}>
      <PageHeader title="المتابعة" back />
      {status === "loading" ? (
        <LoadingState />
      ) : status === "guest" ? (
        <GuestState title="تابع المعلنين المفضلين لديك" />
      ) : (
        <ScrollView
          contentContainerStyle={shared.content}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => void query.refetch()}
              tintColor={palette.primary}
              colors={[palette.primary]}
              progressBackgroundColor={palette.surface}
            />
          }
        >
          <View style={[shared.row, { flexWrap: "wrap" }]}>
            <Chip
              label={`أتابعهم ${query.data?.followingCount ?? ""}`}
              active={tab === "following"}
              onPress={() => setTab("following")}
            />
            <Chip
              label={`المتابعون ${query.data?.followerCount ?? ""}`}
              active={tab === "followers"}
              onPress={() => setTab("followers")}
            />
            <Chip
              label="إعلانات مشابهة"
              active={tab === "similar"}
              onPress={() => setTab("similar")}
            />
          </View>
          {query.isPending ? (
            <LoadingState />
          ) : query.isError ? (
            <ErrorState
              error={query.error}
              retry={() => void query.refetch()}
            />
          ) : tab === "similar" ? (
            query.data?.similarListingFollows.length ? (
              query.data.similarListingFollows.map((item) => (
                <Card key={item.id} style={shared.stack}>
                  <Pressable
                    onPress={() =>
                      router.push(
                        `/listings/${encodeURIComponent(item.listingId)}`,
                      )
                    }
                  >
                    <AppText variant="label">{item.title}</AppText>
                    <AppText variant="caption" color={palette.muted}>
                      {item.city} · {formatDate(item.createdAt)}
                    </AppText>
                  </Pressable>
                  <Button
                    title="إلغاء التنبيه"
                    variant="ghost"
                    loading={
                      change.isPending &&
                      change.variables?.id === item.listingId
                    }
                    onPress={() =>
                      change.mutate({ id: item.listingId, similar: true })
                    }
                  />
                </Card>
              ))
            ) : (
              <EmptyState
                title="لم تفعّل تنبيهات بعد"
                message="من صفحة أي إعلان، يمكنك متابعة الإعلانات المشابهة له."
                icon="notifications-outline"
              />
            )
          ) : people.length ? (
            people.map((person) => (
              <Card key={person.id} style={shared.row}>
                <Pressable
                  style={shared.row}
                  onPress={() =>
                    router.push(`/sellers/${encodeURIComponent(person.userId)}`)
                  }
                >
                  <Avatar name={person.name} picture={person.picture} />
                  <View style={{ maxWidth: 145 }}>
                    <AppText variant="label">{person.name}</AppText>
                    <AppText variant="caption" color={palette.muted}>
                      {person.publishedListingCount} إعلان منشور
                    </AppText>
                  </View>
                </Pressable>
                <View style={shared.grow} />
                <Button
                  title={person.isFollowing ? "إلغاء" : "متابعة"}
                  variant={person.isFollowing ? "ghost" : "secondary"}
                  loading={
                    change.isPending && change.variables?.id === person.userId
                  }
                  onPress={() => change.mutate({ id: person.userId })}
                />
              </Card>
            ))
          ) : (
            <EmptyState
              icon="people-outline"
              title={
                tab === "following"
                  ? "لم تتابع أحدًا بعد"
                  : "لا يوجد متابعون بعد"
              }
              message={
                tab === "following"
                  ? "افتح صفحة المعلن واضغط متابعة لتصلك تحديثاته."
                  : "سيظهر هنا من يتابع حسابك."
              }
            />
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

export function PolicyScreen({ policyId }: { policyId: string }) {
  const palette = useAccountPalette();
  const shared = useAccountStyles();
  const local = useLocalStyles();
  const query = useBootstrap();
  const policies = query.data?.policies;
  const policy = policies?.[policyId];
  return (
    <Screen scroll={false}>
      <PageHeader title={policy?.title || "سياسات المنصة"} back />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !policy ? (
        <EmptyState
          title="الصفحة غير متاحة"
          message="تعذر العثور على هذه السياسة. أعد تحميل بيانات المنصة."
          icon="document-text-outline"
          action={
            <Button
              title="تحديث"
              onPress={() => void query.refetch()}
              variant="secondary"
            />
          }
        />
      ) : (
        <ScrollView contentContainerStyle={shared.content}>
          {policy.updatedAt && (
            <AppText variant="caption" color={palette.muted}>
              آخر تحديث: {policy.updatedAt}
            </AppText>
          )}
          {policy.sections.map((section, index) => (
            <Card key={`${index}-${section.title}`} style={shared.stack}>
              <AppText variant="heading">{section.title}</AppText>
              {section.body && (
                <AppText style={local.policyBody}>{section.body}</AppText>
              )}
              {section.items?.map((item, i) => (
                <View key={i} style={local.bullet}>
                  <View style={local.dot} />
                  <AppText style={[shared.grow, local.policyBody]}>
                    {item}
                  </AppText>
                </View>
              ))}
            </Card>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}

const useLocalStyles = createThemedStyles((colors) => StyleSheet.create({
  appearanceCard: { padding: 6 },
  appearanceOptions: { flexDirection: "row-reverse", gap: 4 },
  appearanceOption: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderRadius: 10,
  },
  appearanceSelected: { backgroundColor: colors.primaryFill },
  profile: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 10,
    minHeight: 72,
    padding: 12,
  },
  menuCard: { paddingHorizontal: 10, paddingVertical: 0, gap: 0 },
  photoCard: { alignItems: "center", gap: 10, paddingVertical: 14 },
  policyBody: { lineHeight: 27 },
  bullet: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 10 },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.primary,
    marginTop: 11,
  },
}));
