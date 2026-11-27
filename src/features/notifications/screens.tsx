import { useActionMutation as useMutation } from "../../ui/action-mutation";
import { useFeedback } from "../../ui/feedback";
import React, { useEffect, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useVisibleQuery } from "../../core/visible-query";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { api } from "../../core/api";
import { userMessage } from "../../core/errors";
import { useAuth } from "../../core/auth";
import { createThemedStyles } from "../../ui/theme-context";
import { disableNativePush, enableNativePush, getNativePushState } from "../../core/push";
import {
  AppText,
  Button,
  Card,
  EmptyState,
  Icon,
  InlineNotice,
  LoadingState,
  PageHeader,
  Screen,
} from "../../ui";
import {
  confirmAction,
  ErrorState,
  formatDate,
  GuestState,
  useAccountPalette,

  useAccountStyles,
} from "../account/shared";

type Notification = {
  id: string;
  listingId: string;
  sellerId: string;
  title?: string;
  body?: string;
  url: string;
  readAt?: string;
  createdAt: string;
};

export function NotificationsScreen() {
  const feedback = useFeedback();
  const palette = useAccountPalette();
  const styles = useAccountStyles();
  const local = useLocalStyles();
  const { user, status } = useAuth();
  const canConfigurePush =
    Device.isDevice &&
    Platform.OS !== "web" &&
    Constants.executionEnvironment !== "storeClient";
  const query = useVisibleQuery({
    queryKey: ["account", user?.id, "notifications"],
    queryFn: ({ signal }) =>
      api.get<{ notifications: Notification[]; unreadCount: number }>(
        "/api/notifications",
        undefined, { signal },
      ),
    enabled: status === "authenticated",
  });
  const read = useMutation({
    mutationFn: () => api.patch("/api/notifications"),
    onSuccess: () => {
      feedback.success("تم تحديد الإشعارات كمقروءة");
      void query.refetch();
    },
    onError: error => feedback.error(error),
  });
  const remove = useMutation({
    mutationFn: (id?: string) =>
      api.delete(
        id
          ? `/api/notifications?id=${encodeURIComponent(id)}`
          : "/api/notifications",
      ),
    onSuccess: (_data, id) => {
      feedback.success(id ? "تم حذف الإشعار" : "تم حذف الإشعارات");
      void query.refetch();
    },
    onError: error => feedback.error(error),
  });
  return (
    <Screen scroll={false}>
      <PageHeader
        title="الإشعارات"
        subtitle={
          query.data?.unreadCount
            ? `${query.data.unreadCount} إشعار غير مقروء`
            : undefined
        }
        back
      />
      {status === "loading" ? (
        <LoadingState />
      ) : status === "guest" ? (
        <GuestState
          title="سجّل الدخول لعرض الإشعارات"
        />
      ) : (
        <FlatList
          data={query.data?.notifications || []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => void query.refetch()}
              tintColor={palette.primary}
              colors={[palette.primary]}
              progressBackgroundColor={palette.surface}
            />
          }
          ListHeaderComponent={
            <View style={styles.stack}>
              {canConfigurePush && user ? <DevicePushSetting key={user.id} ownerId={user.id} /> : null}
              {query.data?.notifications.length ? (
                <View style={styles.between}>
                  <Button
                    title="قراءة الكل"
                    variant="ghost"
                    icon="checkmark-done-outline"
                    loading={read.isPending}
                    disabled={!query.data.unreadCount}
                    onPress={() => read.mutate()}
                  />
                  <Button
                    title="مسح الكل"
                    variant="ghost"
                    icon="trash-outline"
                    loading={remove.isPending && !remove.variables}
                    onPress={() =>
                      confirmAction(
                        "مسح الإشعارات؟",
                        "سيتم حذف جميع الإشعارات من سجل حسابك.",
                        () => remove.mutate(undefined),
                        "مسح الكل",
                        true,
                      )
                    }
                  />
                </View>
              ) : undefined}
            </View>
          }
          renderItem={({ item }) => (
            <Card style={[local.notification, !item.readAt && local.unread]}>
              <Pressable
                style={local.open}
                accessibilityRole="button"
                onPress={() => {
                  if (item.listingId)
                    router.push(
                      `/listings/${encodeURIComponent(item.listingId)}`,
                    );
                }}
              >
                <View style={local.notificationIcon}>
                  <Icon
                    name="notifications-outline"
                    size={22}
                    color={palette.primary}
                  />
                </View>
                <View style={styles.grow}>
                  <AppText variant="label">
                    {item.title || "تحديث جديد"}
                  </AppText>
                  {item.body && (
                    <AppText color={palette.muted} style={{ marginTop: 4 }}>
                      {item.body}
                    </AppText>
                  )}
                  <AppText
                    variant="caption"
                    color={palette.muted}
                    style={{ marginTop: 8 }}
                  >
                    {formatDate(item.createdAt)}
                  </AppText>
                </View>
                {!item.readAt && <View style={local.dot} />}
              </Pressable>
              <Button
                title="حذف"
                variant="ghost"
                loading={remove.isPending && remove.variables === item.id}
                onPress={() => remove.mutate(item.id)}
              />
            </Card>
          )}
          ListEmptyComponent={
            query.isPending ? (
              <LoadingState />
            ) : query.isError ? (
              <ErrorState
                error={query.error}
                retry={() => void query.refetch()}
              />
            ) : (
              <EmptyState
                icon="notifications-outline"
                title="لا توجد إشعارات"
              />
            )
          }
        />
      )}
    </Screen>
  );
}

function DevicePushSetting({ ownerId }: { ownerId: string }) {
  const feedback = useFeedback();
  const palette = useAccountPalette();
  const styles = useAccountStyles();
  const local = useLocalStyles();
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const state = useQuery({
    queryKey: ["device-push-state", ownerId],
    queryFn: getNativePushState,
    staleTime: 0,
    retry: false,
  });
  const { refetch } = state;
  useEffect(() => {
    alive.current = true;
    const listener = AppState.addEventListener("change", value => {
      if (value === "active") void refetch();
    });
    return () => { alive.current = false; listener.remove(); };
  }, [refetch]);
  const change = useMutation({
    mutationFn: (enabled: boolean) => enabled ? enableNativePush() : disableNativePush(),
    onSuccess: (_result, enabled) => {
      if (!alive.current) return;
      setNotice("");
      feedback.success(enabled ? "تم تفعيل إشعارات الجهاز" : "تم إيقاف إشعارات الجهاز");
      void refetch();
    },
    onError: error => {
      if (!alive.current) return;
      setNotice(userMessage(error, "تعذّر تحديث الإشعارات."));
      void refetch();
    },
  });
  const denied = state.data?.status === "denied";
  const unavailable = state.data?.status === "unavailable";
  const openSettings = () => {
    void Linking.openSettings().catch(() => {
      if (alive.current) setNotice("افتح إعدادات الجهاز ثم إشعارات سوق حمد.");
    });
  };
  return <View style={{ gap: 4 }}>
    <View style={styles.between}>
      <View style={[styles.row, styles.grow]}>
        <Icon name="notifications-outline" size={21} color={palette.primary} />
        <AppText variant="label" style={styles.grow}>إشعارات الجهاز</AppText>
      </View>
      {denied ? <Pressable onPress={openSettings} accessibilityRole="button" accessibilityLabel="إعدادات إشعارات الجهاز" style={local.settingsButton}>
        <Icon name="settings-outline" size={20} color={palette.primary} />
      </Pressable> : null}
      <Switch
        accessibilityLabel="إشعارات الجهاز"
        accessibilityState={{ busy: state.isPending || change.isPending }}
        value={state.data?.status === "enabled"}
        disabled={state.isPending || change.isPending || unavailable}
        onValueChange={enabled => {
          setNotice("");
          if (enabled && denied) openSettings();
          else change.mutate(enabled);
        }}
        trackColor={{ false: palette.border, true: palette.primaryFill }}
        thumbColor={palette.onPrimary}
        ios_backgroundColor={palette.border}
      />
    </View>
    {notice ? <InlineNotice message={notice} /> : denied ? <AppText variant="caption">فعّل الإشعارات من إعدادات الجهاز.</AppText> : unavailable ? <AppText variant="caption">الإشعارات غير متاحة في هذه النسخة.</AppText> : state.isError ? <InlineNotice message="تعذّر قراءة إعدادات الإشعارات." onRetry={() => void refetch()} /> : null}
  </View>;
}

const useLocalStyles = createThemedStyles((colors) => StyleSheet.create({
  settingsButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  notification: { paddingBottom: 6 },
  unread: { backgroundColor: colors.primarySoft, borderColor: colors.border },
  open: { flexDirection: "row-reverse", gap: 12, alignItems: "flex-start" },
  notificationIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.primary,
    marginTop: 8,
  },
}));
