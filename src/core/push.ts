import { useEffect, useLayoutEffect } from "react";
import { AppState, Platform } from "react-native";
import * as Device from "expo-device";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { fetch as nativeFetch } from "expo/fetch";
import { ApiError, getApiBaseUrl, getSessionToken } from "./api";
import { userMessage } from "./errors";
import { notificationDestination } from "./notification-destination";

const preferenceKey = "hamad.native-push.enabled";
const registrationKey = "hamad.native-push.registration";
const pendingKey = "hamad.native-push.pending-removal";
let registeredToken: string | null = null;
let generation = 0;
let suspended = false;
let inFlight: Promise<unknown> = Promise.resolve();
type NotificationOwner = { userId: string; bearer: string };
let notificationOwner: NotificationOwner | null = null;
type Removal = { token: string; bearer: string; baseUrl: string; removalToken?: string };
const secureOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

Notifications.setNotificationHandler({
  handleNotification: async notification => {
    const allowed = isCurrentNotificationRecipient(notification.request.content.data);
    return { shouldPlaySound: allowed, shouldSetBadge: allowed,
      shouldShowBanner: allowed, shouldShowList: allowed };
  },
});

function isCurrentNotificationRecipient(data: Record<string, unknown> | undefined, owner = notificationOwner) {
  return Boolean(owner && owner === notificationOwner && !suspended &&
    owner.bearer === getSessionToken() && typeof data?.recipientId === "string" && data.recipientId === owner.userId);
}

function pushAvailable() {
  return Device.isDevice && (Platform.OS === "ios" || Platform.OS === "android") &&
    Constants.executionEnvironment !== "storeClient" &&
    (Platform.OS !== "android" || Constants.expoConfig?.extra?.androidPushConfigured !== false);
}

export type NativePushState = {
  status: "enabled" | "disabled" | "denied" | "unavailable";
  canAskAgain: boolean;
};

export async function getNativePushState(): Promise<NativePushState> {
  if (!pushAvailable()) return { status: "unavailable", canAskAgain: false };
  const owner = getSessionToken();
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return {
    status: permission.canAskAgain ? "disabled" : "denied",
    canAskAgain: permission.canAskAgain,
  };
  const enabled = await SecureStore.getItemAsync(preferenceKey);
  const stored = await SecureStore.getItemAsync(registrationKey);
  let registration: Removal | undefined;
  try { registration = stored ? JSON.parse(stored) : undefined; } catch { /* Retry registration on user action. */ }
  return {
    status: owner && owner === getSessionToken() && enabled === "1" &&
      registration?.bearer === owner && registration.baseUrl === getApiBaseUrl()
      ? "enabled" : "disabled",
    canAskAgain: permission.canAskAgain,
  };
}

function assertPushOwner(owner: string, expectedGeneration: number) {
  if (owner !== getSessionToken() || expectedGeneration !== generation || suspended)
    throw new ApiError(409, "account_changed", "تغيّر الحساب. أعد المحاولة.");
}

async function pushRequest(
  method: "POST" | "DELETE",
  body: unknown,
  bearer: string | null,
  baseUrl = getApiBaseUrl(),
) {
  // Capture the identity before starting. A later account switch must never
  // retarget an in-flight registration or removal to the new account.
  const response = await nativeFetch(`${baseUrl}/api/mobile/push/register`, {
    method,
    // This transport uses the captured bearer or the scoped removal proof.
    // An older native sign-in cookie must not reject or retarget cleanup.
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new ApiError(response.status, "push_update_failed",
      "تعذر تحديث إشعارات الجهاز. تحقق من الاتصال وأعد المحاولة.",
    );
  return response;
}

async function flushPending() {
  const raw = await SecureStore.getItemAsync(pendingKey);
  if (!raw) return;
  const pending = JSON.parse(raw) as Removal;
  if (pending.baseUrl !== getApiBaseUrl()) return;
  try {
    await pushRequest("DELETE", { token: pending.token, removalToken: pending.removalToken },
      pending.removalToken ? null : pending.bearer, pending.baseUrl);
  } catch (error) {
    // A pre-upgrade expired session has no removal capability. The server's
    // verified expiry already excludes that registration from private delivery.
    if (pending.removalToken || !(error instanceof ApiError) || error.status !== 401) throw error;
  }
  if ((await SecureStore.getItemAsync(pendingKey)) === raw)
    await SecureStore.deleteItemAsync(pendingKey);
}

function nativeToken(token: Notifications.DevicePushToken) {
  if (
    (token.type !== "ios" && token.type !== "android") ||
    typeof token.data !== "string" ||
    token.data.startsWith("ExponentPushToken[") ||
    token.data.startsWith("ExpoPushToken[")
  ) {
    throw new Error("تعذر الحصول على رمز إشعارات الجهاز الأصلي.");
  }
  return token.data;
}

async function registerNow(
  token: Notifications.DevicePushToken,
  expectedGeneration: number,
  bearer: string | null,
) {
  const value = nativeToken(token);
  if (!bearer) throw new Error("سجّل الدخول لتفعيل إشعارات حسابك.");
  assertPushOwner(bearer, expectedGeneration);
  await flushPending();
  assertPushOwner(bearer, expectedGeneration);
  const response = await pushRequest(
    "POST",
    {
      token: value,
      platform: Platform.OS,
      locale: "ar-SA",
      appVersion: Constants.expoConfig?.version ?? "1.0.0",
    },
    bearer,
  );
  const result = await response.json().catch(() => ({})) as { removalToken?: string };
  const registration: Removal = {
    token: value,
    bearer,
    baseUrl: getApiBaseUrl(),
    ...(typeof result.removalToken === "string" ? { removalToken: result.removalToken } : {}),
  };
  if (expectedGeneration !== generation || bearer !== getSessionToken() || suspended) {
    await SecureStore.setItemAsync(
      pendingKey,
      JSON.stringify(registration),
      secureOptions,
    );
    await flushPending();
    throw new ApiError(409, "account_changed", "تغيّر الحساب. أعد المحاولة.");
  }
  await SecureStore.setItemAsync(registrationKey, JSON.stringify(registration), secureOptions);
  assertPushOwner(bearer, expectedGeneration);
  registeredToken = value;
}

function register(
  token: Notifications.DevicePushToken,
  expectedGeneration = generation,
  owner = getSessionToken(),
) {
  const result = inFlight
    .catch(() => {})
    .then(() => registerNow(token, expectedGeneration, owner));
  inFlight = result;
  return result;
}

/** Call from a user-operated notification setting, never at application boot. */
export async function enableNativePush() {
  if (!pushAvailable())
    throw new ApiError(0, "push_not_configured", "الإشعارات غير متاحة في هذه النسخة.");
  const ownerSession = getSessionToken();
  if (!ownerSession) throw new Error("سجّل الدخول لتفعيل إشعارات حسابك.");
  suspended = false;
  const expectedGeneration = generation;
  try {
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("default", {
      name: "إشعارات سوق حمد",
      importance: AndroidImportance.HIGH,
    });
  assertPushOwner(ownerSession, expectedGeneration);
  let permission = await Notifications.getPermissionsAsync();
  assertPushOwner(ownerSession, expectedGeneration);
  if (!permission.granted)
    permission = await Notifications.requestPermissionsAsync();
  assertPushOwner(ownerSession, expectedGeneration);
  if (!permission.granted)
    throw new ApiError(0, "push_permission_denied",
      "فعّل الإشعارات من إعدادات الجهاز.",
    );
  const token = await Notifications.getDevicePushTokenAsync();
  assertPushOwner(ownerSession, expectedGeneration);
  await register(token, expectedGeneration, ownerSession);
  assertPushOwner(ownerSession, expectedGeneration);
  await SecureStore.setItemAsync(preferenceKey, "1");
  assertPushOwner(ownerSession, expectedGeneration);
  } catch (error) {
    if (error instanceof ApiError && error.code !== "push_update_failed") throw error;
    throw new ApiError(0, "push_registration_failed", userMessage(error, "تعذّر تفعيل الإشعارات حاليًا."));
  }
}

export function unregisterNativePushBeforeSignOut(expectedOwner = getSessionToken()) {
  suspended = true;
  ++generation;
  // Share the registration queue: a new account can sign in immediately, but
  // its registration cannot be erased by an older device cleanup finishing late.
  const removal = inFlight.catch(() => {}).then(async () => {
    if (!expectedOwner && getSessionToken()) return;
    try {
      const saved = await SecureStore.getItemAsync(registrationKey);
      const registration = saved
        ? (JSON.parse(saved) as Removal)
        : registeredToken && expectedOwner
          ? { token: registeredToken, bearer: expectedOwner, baseUrl: getApiBaseUrl() }
          : null;
      if (registration && (!expectedOwner || registration.bearer === expectedOwner)) {
        await SecureStore.setItemAsync(pendingKey, JSON.stringify(registration), secureOptions);
        await flushPending();
        if ((await SecureStore.getItemAsync(registrationKey)) === saved)
          await SecureStore.deleteItemAsync(registrationKey);
      }
    } finally {
      // Unmounting the old account increments generation too; that must not
      // cancel removal. Only a different current identity keeps its OS token.
      const owner = getSessionToken();
      if (!owner || owner === expectedOwner) {
        registeredToken = null;
        await Notifications.unregisterForNotificationsAsync().catch(() => {});
        await Notifications.dismissAllNotificationsAsync();
        await Notifications.clearLastNotificationResponseAsync().catch(() => {});
        await Notifications.setBadgeCountAsync(0);
      }
    }
  });
  inFlight = removal;
  return removal;
}

export async function disableNativePush() {
  await SecureStore.deleteItemAsync(preferenceKey);
  await unregisterNativePushBeforeSignOut();
}

function navigateFromNotification(
  response: Notifications.NotificationResponse,
  owner = notificationOwner,
) {
  const data = response.notification.request.content.data;
  // Missing recipient IDs include pre-upgrade queued notifications: do not
  // route them into whichever account happens to be signed in now.
  if (!isCurrentNotificationRecipient(data, owner)) return;
  const destination = notificationDestination(data?.url);
  // Authorization is rechecked by each screen's API request.
  if (destination) router.push(destination);
}

export function useNativePushLifecycle(userId?: string | null) {
  const sessionToken = getSessionToken();
  useLayoutEffect(() => {
    const owner = userId && sessionToken ? { userId, bearer: sessionToken } : null;
    notificationOwner = owner;
    return () => { if (notificationOwner === owner) notificationOwner = null; };
  }, [userId, sessionToken]);
  useEffect(() => {
    void flushPending().catch(() => {});
    if (
      !userId ||
      !Device.isDevice ||
      !pushAvailable()
    )
      return;
    suspended = false;
    generation++;
    const sessionAtMount = getSessionToken();
    const ownerAtMount = notificationOwner;
    let disposed = false;
    const restore = async () => {
      const current = generation;
      if ((await SecureStore.getItemAsync(preferenceKey)) !== "1") return;
      const permission = await Notifications.getPermissionsAsync();
      if (
        !disposed &&
        permission.granted &&
        current === generation &&
        getSessionToken() === sessionAtMount
      )
        {
          const token = await Notifications.getDevicePushTokenAsync();
          if (!disposed && current === generation && getSessionToken() === sessionAtMount)
            await register(token, current, sessionAtMount);
        }
    };
    void restore().catch(() => {});
    const tokenSub = Notifications.addPushTokenListener((token) => {
      const current = generation;
      void SecureStore.getItemAsync(preferenceKey)
        .then((enabled) => {
          if (
            !disposed &&
            enabled === "1" &&
            getSessionToken() === sessionAtMount
          )
            return register(token, current, sessionAtMount);
        })
        .catch(() => {});
    });
    const responseSub = Notifications.addNotificationResponseReceivedListener(
      response => { if (!disposed) navigateFromNotification(response, ownerAtMount); },
    );
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!disposed && response) {
        navigateFromNotification(response, ownerAtMount);
        void Notifications.clearLastNotificationResponseAsync();
      }
    }).catch(() => {});
    const stateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") void restore().catch(() => {});
    });
    return () => {
      disposed = true;
      generation++;
      tokenSub.remove();
      responseSub.remove();
      stateSub.remove();
    };
  }, [userId, sessionToken]);
}
