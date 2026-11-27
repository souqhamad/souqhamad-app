import { useActionMutation as useMutation } from "../../ui/action-mutation";
import { SystemAlert as Alert, useFeedback } from "../../ui/feedback";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Linking, Platform, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { ChatKeyboardLayout } from "../../ui/chat-keyboard-layout";
import { router, useIsFocused } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVisibleInfiniteQuery as useInfiniteQuery } from "../../core/visible-query";
import * as Crypto from "expo-crypto";
import { api } from "../../core/api";
import { useAuth } from "../../core/auth";
import { userMessage } from "../../core/errors";
import { createThemedStyles } from "../../ui/theme-context";
import type {
  Conversation,
  ConversationMessage,
  Pagination,
} from "../../core/types";
import { createConversationBottomAnchor } from "./bottom-anchor";
import {
  AppText,
  ActionMenu,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  InlineNotice,
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
  useAccountPalette,
  showError,
  useAccountStyles,
} from "../account/shared";

type Participant = {
  id: string;
  name?: string;
  picture?: string;
  lastActiveAt?: string;
  deletedAt?: string;
};
type ConversationRecord = Conversation & {
  seller?: Participant;
  buyer?: Participant;
};
type ConversationPage = {
  conversations: ConversationRecord[];
  pagination: Pagination;
};
type BlockStatus = { blocked: boolean; blockedByMe: boolean };
type ConversationPayload = {
  conversation: ConversationRecord;
  blockStatus?: BlockStatus;
};

function participantFor(conversation: ConversationRecord, userId?: string) {
  return conversation.sellerId === userId
    ? conversation.buyer
    : conversation.seller;
}
function metadataHas(
  message: ConversationMessage,
  key: string,
  userId?: string,
) {
  const record = message.metadata?.[key];
  return Boolean(
    userId &&
      record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      typeof (record as Record<string, unknown>)[userId] === "string",
  );
}
function visibleMessages(conversation: ConversationRecord, userId?: string) {
  return conversation.messages.filter(
    (message) =>
      message.type !== "conversation_hidden" &&
      !metadataHas(message, "deletedFor", userId),
  );
}
function deletedMessage(message: ConversationMessage) {
  return (
    message.type === "message_deleted" ||
    Boolean(message.metadata?.deletedForEveryone)
  );
}
function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
}

export function ConversationsScreen() {
  const feedback = useFeedback();
  const palette = useAccountPalette();
  const styles = useAccountStyles();
  const local = useLocalStyles();
  const { user, status } = useAuth();
  const [menuConversationId, setMenuConversationId] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["account", user?.id, "conversations"],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api.get<ConversationPage>("/api/marketplace/me/conversations", {
        page: pageParam,
        limit: 20,
      }, { signal }),
    getNextPageParam: (page) => page.pagination.nextPage ?? undefined,
    enabled: status === "authenticated",
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.delete(
        `/api/marketplace/conversations/${encodeURIComponent(id)}`,
        undefined,
        { idempotencyKey: Crypto.randomUUID() },
      ),
    onSuccess: () => {
      feedback.success("تم حذف المحادثة من قائمتك");
      void query.refetch();
    },
    onError: error => feedback.error(error),
  });
  const items = query.data?.pages.flatMap((page) => page.conversations) || [];
  const menuConversation = items.find(item => item.id === menuConversationId);
  return (
    <Screen scroll={false}>
      <PageHeader title="محادثاتي" />
      {status === "loading" ? (
        <LoadingState />
      ) : status === "guest" ? (
        <GuestState
          title="سجّل الدخول لعرض محادثاتك"
          message="لبدء المحادثات ومتابعة الرسائل."
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={query.isError && items.length ? <InlineNotice message={userMessage(query.error, "تعذّر تحديث المحادثات.")} onRetry={() => void query.refetch()} busy={query.isFetching} /> : undefined}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => void query.refetch()}
              tintColor={palette.primary}
              colors={[palette.primary]}
              progressBackgroundColor={palette.surface}
            />
          }
          renderItem={({ item }) => {
            const other = participantFor(item, user?.id);
            const messages = visibleMessages(item, user?.id);
            const latest = messages[messages.length - 1];
            const unread =
              latest &&
              latest.senderId !== user?.id &&
              !metadataHas(latest, "readBy", user?.id);
            return (
              <View style={local.conversationCard}>
                <Pressable
                  style={local.conversationOpen}
                  accessibilityRole="button"
                  accessibilityLabel={`فتح المحادثة: ${other?.name || "مستخدم سوق حمد"}`}
                  onPress={() =>
                    router.push(`/conversations/${encodeURIComponent(item.id)}`)
                  }
                >
                  <Avatar
                    name={other?.name}
                    picture={other?.picture}
                    size={40}
                  />
                  <View style={styles.grow}>
                    <View style={styles.between}>
                      <AppText
                        variant="label"
                        numberOfLines={1}
                        style={styles.grow}
                      >
                        {other?.deletedAt
                          ? "حساب محذوف"
                          : other?.name || "مستخدم سوق حمد"}
                      </AppText>
                      <AppText variant="caption" color={palette.muted}>
                        {formatDate(item.updatedAt)}
                      </AppText>
                    </View>
                    <AppText
                      variant="caption"
                      color={palette.primary}
                      numberOfLines={1}
                    >
                      {item.listing?.title || "محادثة بشأن إعلان"}
                    </AppText>
                    <View style={styles.between}>
                      <AppText
                          variant="caption"
                        numberOfLines={1}
                        color={palette.muted}
                        style={styles.grow}
                      >
                        {latest
                          ? deletedMessage(latest)
                            ? "تم حذف الرسالة"
                            : latest.type === "contact_share"
                              ? "تمت مشاركة رقم التواصل"
                              : latest.body
                          : "ابدأ المحادثة"}
                      </AppText>
                      {unread && <View style={local.unreadDot} />}
                    </View>
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="خيارات المحادثة"
                  disabled={remove.isPending}
                  style={local.conversationMenu}
                  onPress={() => setMenuConversationId(item.id)}
                >
                  <Icon name="ellipsis-horizontal" size={21} color={palette.muted} />
                </Pressable>
              </View>
            );
          }}
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
                icon="chatbubbles-outline"
                title="لا توجد محادثات"
                message="افتح إعلانًا واضغط «راسل المعلن»."
                action={
                  <Button
                    title="تصفح السوق"
                    onPress={() => router.push("/")}
                    variant="secondary"
                  />
                }
              />
            )
          }
          ListFooterComponent={
            query.isFetchingNextPage ? (
              <LoadingState />
            ) : query.hasNextPage ? (
              <Button
                title="تحميل المزيد"
                variant="secondary"
                onPress={() => void query.fetchNextPage()}
              />
            ) : undefined
          }
          onEndReached={() => {
            if (query.hasNextPage && !query.isFetching)
              void query.fetchNextPage();
          }}
          onEndReachedThreshold={0.4}
        />
      )}
      <ActionMenu
        visible={!!menuConversation && status === "authenticated"}
        title="خيارات المحادثة"
        onClose={() => setMenuConversationId(null)}
        items={menuConversation ? [{
          label: "حذف المحادثة",
          icon: "trash-outline",
          destructive: true,
          disabled: remove.isPending,
          onPress: () => confirmAction(
            "حذف المحادثة؟",
            "سيتم إخفاء المحادثة من قائمة محادثاتك.",
            () => remove.mutate(menuConversation.id),
            "حذف",
            true,
          ),
        }] : []}
      />
    </Screen>
  );
}

export function ConversationScreen({
  conversationId,
}: {
  conversationId: string;
}) {
  const feedback = useFeedback();
  const palette = useAccountPalette();
  const styles = useAccountStyles();
  const local = useLocalStyles();
  const { user, status } = useAuth();
  const client = useQueryClient();
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(
    AppState.currentState === "active",
  );
  const canRead =
    focused &&
    appActive &&
    status === "authenticated" &&
    Boolean(conversationId);
  const readAllowed = useRef(canRead);
  useEffect(() => {
    readAllowed.current = canRead;
  }, [canRead]);
  const [body, setBody] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportDetails, setReportDetails] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const list = useRef<FlatList<ConversationMessage>>(null);
  // A new account/thread owns a new scroll anchor, just like its query data.
  const bottomAnchor = useMemo(
    () => createConversationBottomAnchor(`${user?.id || "guest"}:${conversationId}`),
    [conversationId, user?.id],
  );
  const sendAttempt = useRef<{ body: string; key: string } | null>(null);
  const endpoint = `/api/marketplace/conversations/${encodeURIComponent(conversationId)}`;
  // This GET marks messages as read on the server. A mounted background route
  // must never refetch in response to global realtime invalidations.
  const query = useQuery({
    queryKey: ["account", user?.id, "conversation", conversationId],
    queryFn: ({ signal }) =>
      api.get<ConversationPayload>(endpoint, undefined, { signal }),
    enabled: canRead,
  });
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") {
        readAllowed.current = false;
        void client.cancelQueries({
          queryKey: ["account", user?.id, "conversation", conversationId],
          exact: true,
        });
      }
      setAppActive(next === "active");
    });
    return () => subscription.remove();
  }, [client, user?.id, conversationId]);
  useEffect(() => {
    if (!canRead)
      void client.cancelQueries({
        queryKey: ["account", user?.id, "conversation", conversationId],
        exact: true,
      });
  }, [canRead, client, user?.id, conversationId]);
  const conversation = query.data?.conversation;
  const block = query.data?.blockStatus;
  const other = conversation
    ? participantFor(conversation, user?.id)
    : undefined;
  const otherId = conversation
    ? conversation.sellerId === user?.id
      ? conversation.buyerId
      : conversation.sellerId
    : undefined;
  const closed = conversation?.status !== "open";
  const blocked = Boolean(block?.blocked);
  const messages = conversation ? visibleMessages(conversation, user?.id) : [];
  // Discard unsent text and actions on a different account or conversation.

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Never retain unsent text or actions across accounts or conversation routes.
    setBody("");
    setReportOpen(false);
    setReportDetails("");
    setActionsOpen(false);
    sendAttempt.current = null;
  }, [user?.id, conversationId]);
  const reconcile = async () => {
    await client.invalidateQueries({
      queryKey: ["account", user?.id, "conversations"],
    });
    if (readAllowed.current && AppState.currentState === "active")
      await query.refetch();
  };
  const send = useMutation({
    mutationFn: async () => {
      const text = body.trim();
      if (!text) return;
      if (!sendAttempt.current || sendAttempt.current.body !== text)
        sendAttempt.current = { body: text, key: Crypto.randomUUID() };
      return api.post(
        endpoint,
        { body: text },
        { idempotencyKey: sendAttempt.current.key },
      );
    },
    onSuccess: async () => {
      setBody("");
      feedback.success("تم إرسال الرسالة");
      sendAttempt.current = null;
      bottomAnchor.followLatest();
      await reconcile();
    },
    onError: error => feedback.error(error),
  });
  const act = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post(endpoint, payload, { idempotencyKey: Crypto.randomUUID() }),
    onSuccess: async (_data, payload) => {
      if (payload.action === "report_user") {
        setReportOpen(false);
        setReportDetails("");
        feedback.success("تم إرسال البلاغ للإدارة");
      }
      if (payload.action === "delete_message") feedback.success(payload.mode === "for_everyone" ? "تم حذف الرسالة لدى الجميع" : "تم حذف الرسالة لديك");
      if (payload.action === "block_user") feedback.success("تم حظر المستخدم");
      if (payload.action === "unblock_user") feedback.success("تم إلغاء الحظر");
      if (payload.action === "share_contact") feedback.success("تمت مشاركة رقمك في المحادثة");
      setActionsOpen(false);
      await reconcile();
    },
    onError: error => feedback.error(error),
  });
  const deleteMessage = (message: ConversationMessage) => {
    if (deletedMessage(message)) return;
    Alert.alert("حذف الرسالة", "اختر طريقة حذف الرسالة.", [
      { text: "إلغاء", style: "cancel" },
      {
        text: "حذف لدي فقط",
        onPress: () =>
          act.mutate({
            action: "delete_message",
            messageId: message.id,
            mode: "for_me",
          }),
      },
      ...(message.senderId === user?.id
        ? [
            {
              text: "حذف لدى الجميع",
              style: "destructive" as const,
              onPress: () =>
                act.mutate({
                  action: "delete_message",
                  messageId: message.id,
                  mode: "for_everyone",
                }),
            },
          ]
        : []),
    ]);
  };
  const shareContact = () => {
    if (!user?.phoneNumber) {
      Alert.alert(
        "أضف رقم التواصل أولًا",
        "يمكنك إضافة رقم جوالك من صفحة تعديل الحساب، ثم العودة لمشاركته رسميًا.",
        [
          { text: "إلغاء", style: "cancel" },
          { text: "تعديل حسابي", onPress: () => router.push("/account/edit") },
        ],
      );
      return;
    }
    confirmAction(
      "مشاركة رقمك؟",
      "سيظهر رقم الاتصال المسجل في حسابك للطرف الآخر داخل المحادثة.",
      () => act.mutate({ action: "share_contact" }),
      "مشاركة الرقم",
    );
  };
  return (
    <Screen scroll={false}>
      <PageHeader
        title={other?.deletedAt ? "حساب محذوف" : other?.name || "المحادثة"}
        subtitle={
          other?.lastActiveAt
            ? `آخر نشاط ${formatDate(other.lastActiveAt)}`
            : "مراسلة داخل سوق حمد"
        }
        back
        right={
          status === "authenticated" && conversation ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="خيارات المحادثة"
              onPress={() => setActionsOpen((value) => !value)}
              style={local.moreButton}
            >
              <Icon name="ellipsis-horizontal" />
            </Pressable>
          ) : undefined
        }
      />
      {status === "loading" ? (
        <LoadingState />
      ) : status === "guest" ? (
        <GuestState title="سجّل الدخول لعرض المحادثة" />
      ) : query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !conversation ? (
        <EmptyState title="المحادثة غير متاحة" icon="chatbubble-outline" />
      ) : (
        <ChatKeyboardLayout>
          {actionsOpen && (
            <Card style={local.actions}>
              <View style={[styles.row, { flexWrap: "wrap" }]}>
                {otherId && (
                  <Button
                    title="صفحة المعلن"
                    variant="ghost"
                    icon="person-outline"
                    onPress={() =>
                      router.push(`/sellers/${encodeURIComponent(otherId)}`)
                    }
                  />
                )}
                <Button
                  title="إبلاغ"
                  variant="ghost"
                  icon="flag-outline"
                  onPress={() => {
                    setReportOpen((value) => !value);
                    setActionsOpen(false);
                  }}
                />
                {block?.blockedByMe ? (
                  <Button
                    title="إلغاء الحظر"
                    variant="secondary"
                    loading={act.isPending}
                    onPress={() =>
                      confirmAction(
                        "إلغاء الحظر؟",
                        "سيتمكن الطرف الآخر من إرسال رسائل جديدة في المحادثة.",
                        () => act.mutate({ action: "unblock_user" }),
                        "إلغاء الحظر",
                      )
                    }
                  />
                ) : (
                  <Button
                    title="حظر المستخدم"
                    variant="danger"
                    loading={act.isPending}
                    onPress={() =>
                      confirmAction(
                        "حظر المستخدم؟",
                        "سيمنع الحظر إرسال رسائل جديدة بينكما.",
                        () =>
                          act.mutate({
                            action: "block_user",
                            reason: "conversation_block",
                          }),
                        "حظر",
                        true,
                      )
                    }
                  />
                )}
              </View>
            </Card>
          )}
          {conversation.listing && (
            <Pressable
              style={local.listingStrip}
              onPress={() => {
                if (conversation.listing?.status === "published")
                  router.push(
                    `/listings/${encodeURIComponent(conversation.listingId)}`,
                  );
              }}
            >
              <Icon name="pricetag-outline" size={19} color={palette.primary} />
              <AppText
                variant="caption"
                color={palette.primary}
                numberOfLines={1}
                style={styles.grow}
              >
                {conversation.listing.title || "إعلان سوق حمد"}
              </AppText>
              {conversation.listing.status !== "published" && (
                <AppText variant="caption" color={palette.muted}>
                  غير منشور
                </AppText>
              )}
            </Pressable>
          )}
          {reportOpen && (
            <Card style={local.actions}>
              <AppText variant="label">تفاصيل البلاغ</AppText>
              <Field
                placeholder="اشرح المشكلة للإدارة"
                value={reportDetails}
                onChangeText={setReportDetails}
                multiline
                maxLength={1000}
              />
              <View style={styles.row}>
                <Button
                  title="إرسال البلاغ"
                  variant="danger"
                  disabled={reportDetails.trim().length < 2}
                  loading={act.isPending}
                  onPress={() =>
                    act.mutate({
                      action: "report_user",
                      reason: "conversation_report",
                      details: reportDetails.trim(),
                    })
                  }
                />
                <Button
                  title="إلغاء"
                  variant="ghost"
                  onPress={() => setReportOpen(false)}
                />
              </View>
            </Card>
          )}
          <FlatList
            key={`${user?.id || "guest"}:${conversationId}`}
            testID="conversation-message-feed"
            ref={list}
            style={local.messageList}
            data={messages}
            keyExtractor={(message) => message.id}
            contentContainerStyle={local.messages}
            refreshControl={
              <RefreshControl
                refreshing={query.isRefetching}
                onRefresh={() => void query.refetch()}
                tintColor={palette.primary}
                colors={[palette.primary]}
                progressBackgroundColor={palette.surface}
              />
            }
            {...(Platform.OS === "web" ? {
              onWheel: () => bottomAnchor.noteUserIntent(),
              onTouchMove: () => bottomAnchor.noteUserIntent(),
              onKeyDown: (event: unknown) => {
                const key = event && typeof event === "object" && "key" in event ? event.key : null;
                if (typeof key === "string" && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key))
                  bottomAnchor.noteUserIntent();
              },
            } : {})}
            onContentSizeChange={(_width, height) => {
              if (bottomAnchor.measureContent(height))
                list.current?.scrollToEnd({ animated: false });
            }}
            onLayout={(event) => {
              if (bottomAnchor.measureViewport(event.nativeEvent.layout.height))
                list.current?.scrollToEnd({ animated: false });
            }}
            onScroll={(event) => {
              bottomAnchor.observe(event.nativeEvent);
            }}
            onScrollBeginDrag={(event) => { bottomAnchor.beginDrag(event.nativeEvent); }}
            onScrollEndDrag={(event) => { bottomAnchor.endDrag(event.nativeEvent); }}
            onMomentumScrollBegin={() => { bottomAnchor.beginMomentum(); }}
            onMomentumScrollEnd={(event) => { bottomAnchor.endMomentum(event.nativeEvent); }}
            scrollEventThrottle={100}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustContentInsets={false}
            automaticallyAdjustKeyboardInsets={false}
            contentInsetAdjustmentBehavior="never"
            ListEmptyComponent={
              <EmptyState
                title="ابدأ المحادثة"
                message="استفسر عن الإعلان واتفق على تفاصيل المعاينة."
                icon="chatbubble-ellipses-outline"
              />
            }
            renderItem={({ item, index }) => {
              const mine = item.senderId === user?.id;
              const deleted = deletedMessage(item);
              const phone =
                typeof item.metadata?.phoneNumber === "string"
                  ? item.metadata.phoneNumber
                  : undefined;
              const dayChanged =
                index === 0 ||
                formatDate(messages[index - 1].createdAt) !==
                  formatDate(item.createdAt);
              return (
                <View style={local.messageWrap}>
                  {dayChanged && (
                    <AppText
                      variant="caption"
                      color={palette.muted}
                      style={local.date}
                    >
                      {formatDate(item.createdAt)}
                    </AppText>
                  )}
                  <Pressable
                    testID={`conversation-message-${item.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={
                      deleted ? "رسالة محذوفة" : "اضغط مطولًا لخيارات الرسالة"
                    }
                    onLongPress={() => deleteMessage(item)}
                    delayLongPress={450}
                    style={[
                      local.bubble,
                      mine ? local.mine : local.theirs,
                      deleted && local.deleted,
                    ]}
                  >
                    {deleted ? (
                      <AppText color={palette.muted} style={local.messageText}>تم حذف الرسالة</AppText>
                    ) : item.type === "contact_share" ? (
                      <View style={styles.stack}>
                        <View style={styles.row}>
                          <Icon
                            name="call-outline"
                            color={mine ? palette.onPrimary : palette.primary}
                            size={19}
                          />
                          <AppText
                            variant="label"
                            color={mine ? palette.onPrimary : palette.ink}
                          >
                            رقم التواصل الرسمي
                          </AppText>
                        </View>
                        {phone ? (
                          <Pressable
                            accessibilityRole="link"
                            accessibilityLabel={`الاتصال ${phone}`}
                            onPress={() =>
                              void Linking.openURL(`tel:${phone}`).catch(
                                showError,
                              )
                            }
                          >
                            <AppText
                              color={mine ? palette.onPrimary : palette.primary}
                              style={[local.messageText, { writingDirection: "ltr" }]}
                            >
                              {phone}
                            </AppText>
                          </Pressable>
                        ) : (
                          <AppText color={mine ? palette.onPrimary : palette.ink} style={local.messageText}>
                            {item.body}
                          </AppText>
                        )}
                      </View>
                    ) : (
                      <AppText color={mine ? palette.onPrimary : palette.ink} style={local.messageText}>
                        {item.body}
                      </AppText>
                    )}
                    <View style={local.messageMeta}>
                      <AppText
                        variant="caption"
                        color={mine && !deleted ? `${palette.onPrimary}B5` : palette.muted}
                        style={{ fontSize: 10, lineHeight: 14 }}
                      >
                        {time(item.createdAt)}
                      </AppText>
                      {mine && !deleted && (
                        <Icon
                          name={
                            metadataHas(item, "readBy", otherId)
                              ? "checkmark-done"
                              : metadataHas(item, "deliveredTo", otherId)
                                ? "checkmark-done-outline"
                                : "checkmark"
                          }
                          size={15}
                          color={
                            metadataHas(item, "readBy", otherId)
                              ? palette.onPrimary
                              : `${palette.onPrimary}AA`
                          }
                        />
                      )}
                    </View>
                  </Pressable>
                </View>
              );
            }}
          />
          {(blocked || closed) && (
            <View style={local.closed}>
              <Icon
                name="lock-closed-outline"
                size={16}
                color={palette.muted}
              />
              <AppText variant="caption" color={palette.muted}>
                {blocked
                  ? "لا يمكن إرسال رسائل جديدة بعد الحظر."
                  : "هذه المحادثة مغلقة."}
              </AppText>
            </View>
          )}
          <View style={local.composer}>
            <AppText
              variant="caption"
              color={palette.muted}
              style={{ textAlign: "center", fontSize: 10 }}
            >
              لا تحوّل مبالغ قبل المعاينة والتأكد من الإعلان.
            </AppText>
            <View style={local.inputRow}>
              <View style={styles.grow}>
                <Field
                  placeholder="اكتب رسالتك…"
                  value={body}
                  onChangeText={setBody}
                  maxLength={1000}
                  multiline
                  editable={!blocked && !closed && !send.isPending}
                  style={local.input}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="إرسال الرسالة"
                onPress={() => send.mutate()}
                disabled={!body.trim() || blocked || closed || send.isPending}
                style={[
                  local.send,
                  (!body.trim() || blocked || closed || send.isPending) && {
                    opacity: 0.4,
                  },
                ]}
              >
                <Icon name="arrow-up" color={palette.onPrimary} size={23} />
              </Pressable>
            </View>
            <Button
              title={act.isPending ? "جار تنفيذ الطلب…" : "مشاركة رقم التواصل"}
              variant="ghost"
              icon="call-outline"
              disabled={blocked || closed || act.isPending}
              onPress={shareContact}
            />
          </View>
        </ChatKeyboardLayout>
      )}
    </Screen>
  );
}

const useLocalStyles = createThemedStyles((colors) => StyleSheet.create({
  conversationCard: { flexDirection: "row-reverse", alignItems: "center", gap: 4, paddingVertical: 8, paddingHorizontal: 8, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 8 },
  conversationOpen: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
    minHeight: 60,
  },
  conversationMenu: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  moreButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  actions: { marginHorizontal: 16, marginBottom: 10 },
  listingStrip: {
    marginHorizontal: 16,
    backgroundColor: colors.primarySoft,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row-reverse",
    gap: 8,
    alignItems: "center",
  },
  messageList: { flex: 1, minHeight: 0 },
  messages: { padding: 12, paddingBottom: 16, flexGrow: 1 },
  messageWrap: { marginBottom: 6 },
  bubble: {
    maxWidth: "85%",
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 4,
    borderRadius: 14,
    gap: 2,
  },
  messageText: { fontSize: 15, lineHeight: 22 },
  mine: {
    alignSelf: "flex-end",
    backgroundColor: colors.primaryFill,
    borderBottomRightRadius: 5,
  },
  theirs: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 5,
  },
  deleted: { backgroundColor: colors.subtle, borderColor: colors.border },
  date: { textAlign: "center", marginBottom: 10, marginTop: 6 },
  messageMeta: {
    flexDirection: "row",
    gap: 5,
    alignItems: "center",
    alignSelf: "flex-start",
  },
  composer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    flexShrink: 0,
    gap: 8,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  inputRow: { flexDirection: "row-reverse", alignItems: "flex-end", gap: 10 },
  input: {
    minHeight: 47,
    maxHeight: 120,
    paddingTop: 12,
    backgroundColor: colors.background,
  },
  send: {
    width: 46,
    height: 46,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryFill,
    marginBottom: 1,
  },
  closed: {
    flexDirection: "row-reverse",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    padding: 12,
  },
}));
