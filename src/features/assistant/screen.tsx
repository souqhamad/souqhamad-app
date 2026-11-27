import { SystemAlert as Alert, useFeedback } from "../../ui/feedback";
import { createThemedStyles, useTheme } from "../../ui/theme-context";
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from "react";
import {
  AppState,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { ChatKeyboardLayout } from "../../ui/chat-keyboard-layout";
import { router } from "expo-router";
import * as Crypto from "expo-crypto";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart } from "ai";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, getApiBaseUrl, getSessionToken } from "../../core/api";
import { useAuth } from "../../core/auth";
import { aiConsentHeader, useAiConsent } from '../../core/ai-consent';
import { userMessage } from "../../core/errors";
import { pickListingImages, type UploadAsset } from "../../core/media";
import {
  AppText,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  PageHeader,
  Screen,
} from "../../ui";
import {
  clearAssistantHistory,
  readAssistantHistory,
  writeAssistantHistory,
} from "./history";
import { isCreationChoiceMessage, selectAssistantContext } from "./context";
import { HamadDraftCards, HamadSelectedDraft } from "./draft-cards";
import { readHamadDraftUi, type HamadDraftAction } from "./drafts";
import { clearListingAssistantLaunch, readListingAssistantLaunch } from "./entry";


export function AssistantScreen() {
  const { user, status } = useAuth();
  const [listingLaunch] = useState(readListingAssistantLaunch);
  useEffect(() => {
    clearListingAssistantLaunch(listingLaunch);
  }, [listingLaunch]);
  if (status === "loading")
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  if (!user)
    return (
      <Screen>
        <PageHeader title="حمد، مساعدك في السوق" back />
        <EmptyState
          title="كيف أساعدك؟"
          message="سجّل دخولك للتحدث مع حمد وتجهيز إعلانك، أو اطّلع على سياسات السوق."
          icon="sparkles-outline"
          action={
            <Button title="تسجيل الدخول" onPress={() => router.push("/auth")} />
          }
        />
        <View style={{ gap: 8, padding: 18 }}>
          <Button title="كيف تعمل رسوم المنصة؟" variant="secondary" onPress={() => router.push("/policies/commissions")} />
          <Button title="شروط وسياسة الإعلانات" variant="ghost" onPress={() => router.push("/policies/listings")} />
        </View>
      </Screen>
    );
  return <Conversation key={user.id} ownerId={user.id} listingEntry={!!listingLaunch} />;
}

function Conversation({ ownerId, listingEntry }: { ownerId: string; listingEntry: boolean }) {
  const aiConsent = useAiConsent(ownerId);
  const feedback = useFeedback();
  const { colors } = useTheme();
  const s = useStyles();
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const [creation, setCreation] = useState(false);
  const [attachments, setAttachments] = useState<UploadAsset[]>([]);
  const [picking, setPicking] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [expiredDraftAt, setExpiredDraftAt] = useState<number>();
  const conversationId = useRef(Crypto.randomUUID());
  const retained = useRef<{ source: string | null; files: FileUIPart[] }>({
    source: null,
    files: [],
  });
  const creationRef = useRef(creation);
  useEffect(() => {
    creationRef.current = creation;
  }, [creation]);
  const tokenAtMount = useRef(getSessionToken());
  const mounted = useRef(true);
  const sendPending = useRef(false);
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const client = useQueryClient();
  // The transport retains these callbacks; they read refs only on a request,
  // never while the transport is constructed during render.

  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- The constructor stores callbacks; each ref is read only when a later request invokes them.
      new DefaultChatTransport({
        api: `${getApiBaseUrl()}/api/chat`,
        fetch: (async (_url, init) => {
          if (!mounted.current || getSessionToken() !== tokenAtMount.current)
            throw new Error("تغيّر الحساب. افتح المحادثة من جديد.");
          const response = await apiFetch("/api/chat", init as RequestInit);
          if (!response.ok) {
            const failure = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(
              failure?.error === "ai_consent_required"
                ? "راجع موافقة مشاركة البيانات من حسابي، ثم أعد المحاولة."
                : response.status === 429
                ? "طلبات كثيرة. انتظر قليلًا ثم أعد المحاولة."
                : response.status === 409
                  ? "تغيّر الحساب. افتح المحادثة من جديد."
                  : "تعذر الاتصال بحمد. حاول بعد قليل.",
            );
          }
          if (
            !response.headers.get("content-type")?.includes("text/event-stream")
          )
            throw new Error("استجابة المحادثة غير صالحة. حاول بعد قليل.");
          return response;
        }) as typeof globalThis.fetch,
        prepareSendMessagesRequest: ({ messages, body, headers }) => {
          const creationSelected = listingEntry || creationRef.current;
          const context = selectAssistantContext(creationSelected ? messages.filter(message => !isCreationChoiceMessage(message)) : messages);
          const latest = context.findLast((message) => message.role === "user");
          const files =
            latest?.parts.filter(
              (part): part is FileUIPart =>
                part.type === "file" && part.mediaType.startsWith("image/"),
            ) ?? [];
          if (files.length) retained.current = { source: latest!.id, files };
          const keepEarlier =
            !body?.hamadDraftAction &&
            !files.length &&
            context.some((message) => message.id === retained.current.source);
          return {
            headers: { ...headers, Authorization: `Bearer ${tokenAtMount.current}` },
            body: {
              ...body,
              messages: context,
              chatOwnerId: ownerId,
              chatConversationId: conversationId.current,
              hamadDraftCards: true,
              locationSettings: {
                country: "السعودية",
                currency: "SAR",
                language: "ar",
              },
              ...(listingEntry || creationRef.current ? { creationMethod: "chat" } : {}),
              retainedListingImages: keepEarlier ? retained.current.files : [],
              retainedListingImageMessageId: keepEarlier
                ? retained.current.source
                : undefined,
            },
          };
        },
      }),
    [listingEntry, ownerId],
  );
  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    id: `hamad-native:${ownerId}`,
    transport,
    onFinish: () => {
      void client.invalidateQueries({ queryKey: ["my-listings"] });
    },
  });
  const busy = status === "submitted" || status === "streaming";
  const displayedMessages = listingEntry || creation ? messages.filter(message => !isCreationChoiceMessage(message)) : messages;
  const latestAssistant = displayedMessages.findLast((message) => message.role === "assistant");
  const { active, page } = readHamadDraftUi(latestAssistant?.metadata);
  const selected = active?.expires !== expiredDraftAt ? active : undefined;
  const selectionExpires = active?.expires;
  useEffect(() => {
    if (selectionExpires === undefined) return;
    const timer = setTimeout(() => setExpiredDraftAt(selectionExpires), Math.max(0, selectionExpires - Date.now()));
    return () => clearTimeout(timer);
  }, [selectionExpires]);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void readAssistantHistory(ownerId).then((saved) => {
      if (cancelled) return;
      if (saved) {
        conversationId.current = saved.conversationId;
        setMessages(saved.messages);
        setCreation(saved.creationMethod);
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
      mounted.current = false;
      void stop();
      retained.current = { source: null, files: [] };
    };
  }, [ownerId, setMessages, stop]);
  useEffect(() => {
    if (!ready || busy || !messages.length) return;
    const timer = setTimeout(() => {
      if (mounted.current)
        void writeAssistantHistory(ownerId, {
          conversationId: conversationId.current,
          messages,
          creationMethod: creation,
        }).catch(() => setHistoryError(true));
    }, 350);
    return () => clearTimeout(timer);
  }, [ownerId, messages, creation, busy, ready]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") void stop();
    });
    return () => sub.remove();
  }, [stop]);
  const send = async (message: string, beginDraft = false, draftAction?: HamadDraftAction) => {
    if (sendPending.current || busy || !ready || picking || (!message.trim() && !attachments.length))
      return;
    if (message.length > 12_000) {
      feedback.warning("اختصر الرسالة إلى 12 ألف حرف وأرسل التفاصيل على أكثر من خطوة.");
      return;
    }
    sendPending.current = true;
    try {
      if (!(await aiConsent.request()) || !mounted.current || getSessionToken() !== tokenAtMount.current) return;
      if ((beginDraft || listingEntry) && !creationRef.current) {
        creationRef.current = true;
        setCreation(true);
      }
      const files: FileUIPart[] = (draftAction ? [] : attachments)
        .filter((asset) => asset.dataUrl)
        .map((asset) => ({
          type: "file",
          mediaType: "image/jpeg",
          filename: asset.name,
          url: asset.dataUrl!,
        }));
      if (!draftAction) {
        setText("");
        setAttachments([]);
      }
      await sendMessage(
        { text: message, files },
        {
          body: draftAction ? { hamadDraftAction: draftAction } : beginDraft
            ? { creationMethod: "chat", beginDraftWithHamad: true }
            : {},
          headers: { [aiConsentHeader]: aiConsent.version },
        },
      );
    } finally {
      sendPending.current = false;
    }
  };
  const sendDraftAction = (action: HamadDraftAction) => void send(
    action.type === "select" ? "أرني المسودة المختارة." : action.type === "next" ? "اعرض المسودات التالية." : "اعرض مسوداتي.",
    false,
    action,
  );
  const choose = async (source: "camera" | "library") => {
    setPicking(true);
    try {
      const files = await pickListingImages(
        source,
        8 - attachments.length,
        true,
      );
      if (files.length) feedback.info("تم إرفاق الصور بالرسالة");
      if (mounted.current)
        setAttachments((current) => [...current, ...files].slice(0, 8));
    } catch (failure) {
      feedback.error(failure, "تعذّر إضافة الصور.");
    } finally {
      if (mounted.current) setPicking(false);
    }
  };
  const reset = () =>
    Alert.alert(
      "محادثة جديدة",
      "سيُمسح النص المحفوظ لهذه المحادثة من هذا الجهاز. تبقى مسودات الإعلانات في حسابك.",
      [
        { text: "إلغاء", style: "cancel" },
        {
          text: "ابدأ من جديد",
          onPress: () => {
            void stop();
            retained.current = { source: null, files: [] };
            conversationId.current = Crypto.randomUUID();
            setMessages([]);
            setText("");
            setAttachments([]);
            setCreation(false);
            void clearAssistantHistory(ownerId).then(() => feedback.success("تم بدء محادثة جديدة مع حمد")).catch(error => {
              setHistoryError(true);
              feedback.error(error, "بدأت محادثة جديدة، وتعذّر مسح السجل المحفوظ على الجهاز.");
            });
          },
        },
      ],
    );
  return (
    <Screen scroll={false}>
      <PageHeader
        title="حمد"
        subtitle={listingEntry || creation ? "نجهّز مسودة إعلانك معًا" : "مساعدك في سوق حمد"}
        back
        right={
          <Button
            title="جديدة"
            variant="ghost"
            icon="add-outline"
            onPress={reset}
            disabled={!ready}
          />
        }
      />
      <ChatKeyboardLayout>
        <ScrollView
          ref={list}
          style={s.messageList}
          contentContainerStyle={s.messages}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustContentInsets={false}
          automaticallyAdjustKeyboardInsets={false}
          contentInsetAdjustmentBehavior="never"
          onLayout={() => list.current?.scrollToEnd({ animated: false })}
          onContentSizeChange={() =>
            list.current?.scrollToEnd({ animated: true })
          }
        >
          {!ready ? (
            <LoadingState />
          ) : !displayedMessages.length ? (
            <View style={s.hero}>
              <View style={s.logo}>
                <Icon name="sparkles" size={34} color={colors.primary} />
              </View>
              <AppText variant="title">هلا، أنا حمد</AppText>
              <AppText color={colors.muted} style={{ textAlign: "center" }}>
                {listingEntry
                  ? "اكتب تفاصيل إعلانك أو أرفق صوره، وأنا أساعدك في تجهيز المسودة."
                  : "أساعدك تجهّز مسودة إعلان، وأجيب عن أسئلتك حول المنصة."}
              </AppText>
            </View>
          ) : (
            displayedMessages.map((message) => {
              const draftView = message.role === "assistant" ? readHamadDraftUi(message.metadata) : undefined;
              const currentPage = message.id === latestAssistant?.id ? page : undefined;
              return (
              <View
                key={message.id}
                testID={message.role === "user" ? "hamad-user-message" : "hamad-assistant-message"}
                style={message.role === "user" ? s.user : s.assistant}
              >
                {currentPage ? <HamadDraftCards page={currentPage} disabled={busy || picking} onAction={sendDraftAction} /> : message.parts.map((part, index) =>
                  part.type === "text" ? (
                    <AssistantText
                      key={index}
                      text={part.text}
                      user={message.role === "user"}
                    />
                  ) : part.type === "file" &&
                    part.mediaType.startsWith("image/") ? (
                    <Image
                      key={index}
                      source={{ uri: part.url }}
                      style={s.chatImage}
                    />
                  ) : null,
                )}
                {draftView?.preview && <HamadSelectedDraft draft={draftView.preview} />}
                {isCreationChoiceMessage(message) && (
                  <>
                    <Button
                      title="الإنشاء مع حمد"
                      variant="secondary"
                      disabled={busy}
                      onPress={() => send("أختار الإنشاء مع حمد.", true)}
                    />
                    <Button
                      title="الإنشاء اليدوي"
                      variant="ghost"
                      onPress={() => router.push("/create/manual")}
                    />
                  </>
                )}
              </View>
              );
            })
          )}
          {busy && (
            <View style={s.typing}>
              <Icon name="sparkles-outline" color={colors.primary} size={18} />
              <AppText variant="caption" color={colors.muted}>
                حمد يجهّز الرد بعد التحقق…
              </AppText>
            </View>
          )}
          {!!error && (
            <Card style={{ backgroundColor: colors.dangerSoft }}>
              <AppText color={colors.danger}>
                {userMessage(error, "تعذّر إكمال الرد. أعد المحاولة.")}
              </AppText>
              <AppText variant="caption" color={colors.muted}>
                إذا كنت تجهّز إعلانًا، راجع مسوداتك قبل إعادة الإرسال.
              </AppText>
              <Button
                title="عرض مسوداتي"
                variant="secondary"
                onPress={() => router.push("/(tabs)/listings" as never)}
              />
            </Card>
          )}
        </ScrollView>
        <View style={s.composer}>
          {!!selected && (
            <View style={s.selectedDraft} testID="hamad-active-draft">
              <Icon name="document-text-outline" size={17} color={colors.primary} />
              <View style={s.grow}>
                <AppText variant="caption" color={colors.muted}>المسودة المختارة</AppText>
                <AppText variant="label" numberOfLines={1}>{selected.title}</AppText>
              </View>
              <Button title="تغيير" variant="ghost" disabled={busy || picking} onPress={() => sendDraftAction({ type: "list" })} />
            </View>
          )}
          {attachments.length > 0 && (
            <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
              {attachments.map((asset) => (
                <View key={asset.uri}>
                  <Image source={{ uri: asset.uri }} style={s.attachment} />
                  <Pressable
                    accessibilityLabel="إزالة المرفق"
                    style={s.remove}
                    onPress={() => {
                      setAttachments((current) =>
                        current.filter((item) => item.uri !== asset.uri),
                      );
                      feedback.info("تمت إزالة المرفق");
                    }}
                  >
                    <Icon name="close" color={colors.onPrimary} size={14} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          <View style={s.inputRow}>
            <View style={s.grow}>
              <Field
                value={text}
                onChangeText={setText}
                placeholder={listingEntry ? "اكتب تفاصيل إعلانك…" : "اكتب لحمد…"}
                multiline
                maxLength={12_000}
                editable={ready && !busy}
                style={{ minHeight: 52, maxHeight: 130 }}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? "إيقاف الرد" : "إرسال الرسالة"}
              disabled={
                !ready ||
                picking ||
                (!busy && !text.trim() && !attachments.length)
              }
              onPress={() => (busy ? void stop() : send(text))}
              style={[s.send, !ready && { opacity: 0.4 }]}
            >
              <Icon name={busy ? "stop" : "arrow-up"} color={colors.onPrimary} size={23} />
            </Pressable>
          </View>
          <View style={s.tools}>
            <Pressable
              accessibilityLabel="إرفاق صور"
              disabled={busy || picking || attachments.length >= 8}
              onPress={() => void choose("library")}
            >
              <Icon name="images-outline" color={colors.primary} size={22} />
            </Pressable>
            <Pressable
              accessibilityLabel="التقاط صورة"
              disabled={busy || picking || attachments.length >= 8}
              onPress={() => void choose("camera")}
            >
              <Icon name="camera-outline" color={colors.primary} size={23} />
            </Pressable>
            {picking && <View style={s.grow}>
              <AppText variant="caption" color={colors.muted}>
                جارٍ تجهيز الصور…
              </AppText>
            </View>}
          </View>
          {historyError && <AppText
            variant="caption"
            color={colors.danger}
            style={{ fontSize: 10 }}
          >
            تعذر حفظ التاريخ محليًا. قد لا يبقى بعد إغلاق التطبيق.
          </AppText>}
        </View>
      </ChatKeyboardLayout>
    </Screen>
  );
}

function AssistantText({ text, user }: { text: string; user: boolean }) {
  const { colors } = useTheme();
  const s = useStyles();
  const safe = text
    .replace(/\[\[SMARTSTORE_GOOGLE_AUTH_REQUIRED\]\]/g, "")
    .trim();
  const pattern = /\[([^\]]+)\]\((\/[^\s)]+)\)/g;
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of safe.matchAll(pattern)) {
    pieces.push(safe.slice(cursor, match.index));
    const path = match[2];
    const mapped: Record<string, string> = {
      "/": "/(tabs)",
      "/account/listings": "/(tabs)/listings",
      "/account": "/(tabs)/account",
      "/conversations": "/(tabs)/messages",
      "/favorites": "/(tabs)/favorites",
      "/terms": "/policies/terms",
      "/privacy": "/policies/privacy",
      "/listing-policy": "/policies/listings",
      "/commission-policy": "/policies/commissions",
      "/delete-account": "/policies/deletion",
    };
    const target = mapped[path] ?? path;
    const allowed =
      Object.values(mapped).includes(target) ||
      target === "/create/manual" ||
      target === "/notifications" ||
      target === "/account/follows" ||
      /^\/listings\/[A-Za-z0-9_-]+$/.test(target) ||
      /^\/policies\/[A-Za-z0-9_-]+$/.test(target);
    pieces.push(
      allowed ? (
        <AppText
          key={`${match.index}`}
          color={user ? colors.onPrimary : colors.primary}
          style={[s.messageText, { textDecorationLine: "underline" }]}
          onPress={() => router.push(target as never)}
        >
          {match[1]}
        </AppText>
      ) : (
        match[1]
      ),
    );
    cursor = match.index! + match[0].length;
  }
  pieces.push(safe.slice(cursor));
  return (
    <AppText selectable color={user ? colors.onPrimary : colors.text} style={s.messageText}>
      {pieces}
    </AppText>
  );
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({
  grow: { flex: 1 },
  messageList: { flex: 1, minHeight: 0 },
  messages: { padding: 14, gap: 10, paddingBottom: 16, flexGrow: 1 },
  hero: { alignItems: "center", paddingTop: 26, paddingBottom: 18, gap: 12 },
  logo: {
    width: 84,
    height: 84,
    borderRadius: 28,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  messageText: { fontSize: 15, lineHeight: 22 },
  user: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 14,
    gap: 4,
    maxWidth: "88%",
    backgroundColor: colors.primaryFill,
    alignSelf: "flex-start",
    borderBottomStartRadius: 5,
  },
  assistant: {
    alignSelf: "stretch",
    gap: 6,
  },
  chatImage: {
    width: 190,
    height: 160,
    borderRadius: 12,
    backgroundColor: colors.primarySoft,
  },
  typing: { flexDirection: "row", gap: 8, alignItems: "center" },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
    flexShrink: 0,
    gap: 9,
  },
  selectedDraft: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8,
    backgroundColor: colors.primarySoft, borderRadius: 10 },
  inputRow: { flexDirection: "row", gap: 10, alignItems: "flex-end" },
  send: {
    width: 50,
    height: 50,
    borderRadius: 17,
    backgroundColor: colors.primaryFill,
    alignItems: "center",
    justifyContent: "center",
  },
  tools: { flexDirection: "row", alignItems: "center", gap: 18 },
  attachment: { width: 64, height: 64, borderRadius: 12 },
  remove: {
    position: "absolute",
    top: 2,
    end: 2,
    backgroundColor: colors.mediaOverlay,
    borderRadius: 20,
    padding: 3,
  },
}));
