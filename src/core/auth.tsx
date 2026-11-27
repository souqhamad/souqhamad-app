import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import Constants from "expo-constants";
import { useQueryClient } from "@tanstack/react-query";
import { isGoogleSignInSuccess } from "./native-auth";
import { createSessionRefresh } from "./session-refresh";
import { unregisterNativePushBeforeSignOut } from "./push";
import {
  api,
  ApiError,
  assertApiIdentity,
  getApiBaseUrl,
  getApiIdentity,
  getAgreementToken,
  isCurrentApiSession,
  setApiIdentity,
  subscribeToSessionRejection,
  type ApiIdentity,
  type RejectedApiSession,
} from "./api";
import type { User } from "./types";

type AuthResult = {
  authenticated: boolean;
  user: User | null;
  sessionToken?: string;
};
type AuthContextValue = {
  user: User | null;
  status: "loading" | "guest" | "authenticated";
  error: string | null;
  refresh: (afterWrite?: boolean) => Promise<void>;
  applyProfileUser: (user: User, identity: ApiIdentity) => void;
  runProfileWrite: <T>(identity: ApiIdentity, write: (assertCurrent: () => void) => Promise<T>) => Promise<T>;
  signOut: () => Promise<void>;
  acceptAgreement: () => Promise<void>;
  signInGoogle: () => Promise<boolean>;
  signInApple: () => Promise<void>;
};
const Context = createContext<AuthContextValue | null>(null);
const storageKey = `souq-hamad-session-${getApiBaseUrl().replace(/[^a-z0-9]/gi, "_")}`;
async function readStorage() {
  if (Platform.OS === "web") return null;
  try {
    return await SecureStore.getItemAsync(storageKey);
  } catch {
    return null;
  }
}
async function saveStorage(token: string | null, agreement: string | null) {
  if (Platform.OS === "web") return;
  if (token)
    await SecureStore.setItemAsync(
      storageKey,
      JSON.stringify({ token, agreement }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
  else await SecureStore.deleteItemAsync(storageKey);
}
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthContextValue["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const profileRevision = useRef(0);
  const profileWriteQueue = useRef<{
    identity: ApiIdentity;
    epoch: number;
    tail: Promise<unknown>;
  } | null>(null);
  const restoring = useRef(false);
  const operation = useRef<"login" | "logout" | null>(null);
  const pendingRejection = useRef<RejectedApiSession | null>(null);
  const storageQueue = useRef<Promise<unknown>>(Promise.resolve());
  const sessionRefresh = useRef(createSessionRefresh());
  const queryClient = useQueryClient();
  const persist = useCallback(
    (token: string | null, agreement: string | null) => {
      const pending = storageQueue.current
        .catch(() => {})
        .then(() => saveStorage(token, agreement));
      storageQueue.current = pending;
      return pending;
    },
    [],
  );
  const expireSession = useCallback(async (rejected: RejectedApiSession) => {
    if (!isCurrentApiSession(rejected)) return;
    if (operation.current === "login") {
      pendingRejection.current = rejected;
      return;
    }
    if (operation.current) return;
    operation.current = "logout";
    pendingRejection.current = null;
    const rejectedEpoch = ++epoch.current;
    const pushCleanup = unregisterNativePushBeforeSignOut(rejected.token).catch(() => {});
    setApiIdentity(null, null);
    setUser(null);
    setStatus("loading");
    setError("انتهت صلاحية الجلسة أو لم تعد متاحة. سجّل دخولك مجددًا.");
    await queryClient.cancelQueries().catch(() => {});
    if (rejectedEpoch !== epoch.current) return;
    queryClient.clear();
    try {
      await pushCleanup;
      await persist(null, null);
    } catch {
      if (rejectedEpoch === epoch.current)
        setError("انتهت الجلسة. تعذّر مسح بيانات الدخول من التخزين الآمن.");
    } finally {
      if (rejectedEpoch === epoch.current) {
        operation.current = null;
        setStatus("guest");
      }
    }
  }, [persist, queryClient]);
  useEffect(() => subscribeToSessionRejection((rejected) => {
    void expireSession(rejected);
  }), [expireSession]);
  const finishLoginOperation = useCallback((loginEpoch: number) => {
    if (loginEpoch !== epoch.current) return;
    operation.current = null;
    const rejected = pendingRejection.current;
    pendingRejection.current = null;
    if (rejected) void expireSession(rejected);
  }, [expireSession]);
  const applyProfileUser = useCallback((nextUser: User, identity: ApiIdentity) => {
    try {
      assertApiIdentity(identity);
    } catch {
      return;
    }
    profileRevision.current += 1;
    setUser(current => {
      try {
        assertApiIdentity(identity);
      } catch {
        return current;
      }
      return current?.id === nextUser.id ? nextUser : current;
    });
  }, []);
  // The provider owns ordering so leaving and reopening the editor cannot
  // overlap profile writes. A new account gets its own queue immediately.
  const runProfileWrite = useCallback(async <T,>(identity: ApiIdentity, write: (assertCurrent: () => void) => Promise<T>) => {
    const writeEpoch = epoch.current;
    const assertCurrent = () => {
      assertApiIdentity(identity);
      if (writeEpoch !== epoch.current || operation.current || restoring.current)
        throw new ApiError(409, "account_changed", "تغيّر الحساب. أعد المحاولة.");
    };
    assertCurrent();
    const previous = profileWriteQueue.current;
    const sameSession = previous?.identity.token === identity.token &&
      previous.identity.generation === identity.generation && previous.epoch === writeEpoch;
    const pending = (sameSession ? previous.tail.catch(() => {}) : Promise.resolve()).then(async () => {
      assertCurrent();
      const result = await write(assertCurrent);
      assertCurrent();
      return result;
    });
    const entry = { identity, epoch: writeEpoch, tail: pending };
    profileWriteQueue.current = entry;
    const release = () => {
      if (profileWriteQueue.current === entry) profileWriteQueue.current = null;
    };
    void pending.then(release, release);
    return pending;
  }, []);
  const refresh = useCallback(async (afterWrite = false) => {
    if (restoring.current || operation.current) return;
    const id = epoch.current;
    return sessionRefresh.current({ ...getApiIdentity(), epoch: id }, async () => {
      if (id !== epoch.current || restoring.current || operation.current) return;
      const profileRevisionAtStart = profileRevision.current;
      try {
        const response = await api.get<AuthResult>("/api/auth/session");
        if (id !== epoch.current || profileRevisionAtStart !== profileRevision.current) return;
        if (response.authenticated && response.user) {
          setUser(response.user);
          setStatus("authenticated");
          setError(null);
        } else {
          const identity = getApiIdentity();
          const hadSession = Boolean(identity.token);
          const pushCleanup = hadSession
            ? unregisterNativePushBeforeSignOut(identity.token).catch(() => {}) : Promise.resolve();
          const guestEpoch = ++epoch.current;
          setUser(null);
          setStatus("guest");
          setApiIdentity(null, getAgreementToken());
          if (hadSession) {
            await queryClient.cancelQueries().catch(() => {});
          }
          // A fresh sign-in can finish while cancellation of the expired account
          // is pending. Its cache and stored token belong to the newer epoch.
          if (guestEpoch !== epoch.current) return;
          if (hadSession) queryClient.clear();
          await pushCleanup;
          if (guestEpoch !== epoch.current) return;
          await persist(null, null);
        }
      } catch (e) {
        if (id !== epoch.current || profileRevisionAtStart !== profileRevision.current) return;
        setError(e instanceof Error ? e.message : "تعذّر التحقق من الحساب.");
        setStatus((previous) =>
          previous === "authenticated" ? previous : "guest",
        );
      }
    }, afterWrite);
  }, [queryClient, persist]);
  useEffect(() => {
    let alive = true;
    restoring.current = true;
    const restoreEpoch = epoch.current;
    void (async () => {
      const value = await readStorage();
      // A slow key-store read must never restore the previous account after a
      // login or logout has already started in this mounted provider.
      if (!alive) return;
      if (restoreEpoch !== epoch.current || operation.current) {
        restoring.current = false;
        return;
      }
      if (value) {
        try {
          const parsed = JSON.parse(value) as {
            token: string;
            agreement?: string;
          };
          if (typeof parsed.token === "string")
            setApiIdentity(parsed.token, parsed.agreement || null);
        } catch {
          await persist(null, null).catch(() => {});
        }
      }
      if (!alive) return;
      restoring.current = false;
      if (restoreEpoch !== epoch.current || operation.current) return;
      await refresh();
    })();
    return () => {
      alive = false;
      restoring.current = false;
      epoch.current += 1;
    };
  }, [persist, refresh]);
  const acceptAgreement = useCallback(async () => {
    const result = await api.post<{ agreementToken: string }>(
      "/api/auth/commission-agreement",
      { accepted: true },
    );
    if (!result.agreementToken) throw new Error("تعذّر تسجيل الموافقة.");
    const { getSessionToken } = await import("./api");
    setApiIdentity(getSessionToken(), result.agreementToken);
  }, []);
  const complete = useCallback(
    async (response: AuthResult, expectedEpoch: number) => {
      if (expectedEpoch !== epoch.current) return;
      if (!response.authenticated || !response.user || !response.sessionToken)
        throw new Error("تعذّر إكمال تسجيل الدخول.");
      await queryClient.cancelQueries();
      if (expectedEpoch !== epoch.current) return;
      queryClient.clear();
      await persist(response.sessionToken, getAgreementToken());
      if (expectedEpoch !== epoch.current) return;
      setApiIdentity(response.sessionToken, getAgreementToken());
      setUser(response.user);
      setStatus("authenticated");
      setError(null);
    },
    [queryClient, persist],
  );
  const signInGoogle = useCallback(async () => {
    if (Platform.OS === "ios")
      throw new Error("استخدم تسجيل الدخول باستخدام Apple على آيفون.");
    if (operation.current) return false;
    operation.current = "login";
    const loginEpoch = ++epoch.current;
    try {
      if (
        Platform.OS === "web" ||
        Constants.executionEnvironment === "storeClient"
      )
        throw new Error("تسجيل الدخول متاح من نسخة التطبيق المثبتة.");
      const { clientId } = await api.get<{ clientId: string }>(
        "/api/auth/google/native-config",
      );
      const { GoogleSignin } = await import(
        "@react-native-google-signin/google-signin"
      );
      GoogleSignin.configure({
        webClientId: clientId,
      });
      if (Platform.OS === "android")
        await GoogleSignin.hasPlayServices({
          showPlayServicesUpdateDialog: true,
        });
      const result = await GoogleSignin.signIn();
      if (!isGoogleSignInSuccess(result)) return false;
      const idToken = result.data.idToken;
      if (!idToken) throw new Error("تعذّر الحصول على بيانات تسجيل الدخول.");
      if (loginEpoch !== epoch.current) return false;
      await complete(
        await api.post<AuthResult>("/api/auth/google/native", { idToken }),
        loginEpoch,
      );
      return loginEpoch === epoch.current;
    } finally {
      finishLoginOperation(loginEpoch);
    }
  }, [complete, finishLoginOperation]);
  const signInApple = useCallback(async () => {
    if (operation.current) return;
    operation.current = "login";
    const loginEpoch = ++epoch.current;
    try {
      if (
        Platform.OS !== "ios" ||
        !(await AppleAuthentication.isAvailableAsync())
      )
        throw new Error("تسجيل الدخول باستخدام Apple غير متاح على هذا الجهاز.");
      const codeVerifier =
        `${Crypto.randomUUID()}${Crypto.randomUUID()}`.replaceAll("-", "");
      const codeChallenge = (
        await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          codeVerifier,
          { encoding: Crypto.CryptoEncoding.BASE64 },
        )
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const challenge = await api.post<{
        challengeToken: string;
        nonce: string;
      }>("/api/auth/apple/native/challenge", { codeChallenge });
      const state = Crypto.randomUUID();
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: challenge.nonce,
        state,
      });
      if (
        credential.state !== state ||
        !credential.identityToken ||
        !credential.authorizationCode
      )
        throw new Error("تعذّر التحقق من تسجيل الدخول.");
      const fullName = [
        credential.fullName?.givenName,
        credential.fullName?.familyName,
      ]
        .filter(Boolean)
        .join(" ");
      if (loginEpoch !== epoch.current) return;
      await complete(
        await api.post<AuthResult>("/api/auth/apple/native", {
          challengeToken: challenge.challengeToken,
          codeVerifier,
          identityToken: credential.identityToken,
          authorizationCode: credential.authorizationCode,
          fullName: fullName || undefined,
        }),
        loginEpoch,
      );
    } finally {
      finishLoginOperation(loginEpoch);
    }
  }, [complete, finishLoginOperation]);
  const signOut = useCallback(async () => {
    operation.current = "logout";
    pendingRejection.current = null;
    epoch.current += 1;
    setUser(null);
    setStatus("loading");
    try {
      await unregisterNativePushBeforeSignOut();
    } catch {
      /* Local sign-out still completes when offline. */
    }
    try {
      await api.post("/api/auth/logout", undefined, { timeoutMs: 10000 });
    } catch {
      /* Expired/offline session must not trap the user. */
    }
    setApiIdentity(null, null);
    await queryClient.cancelQueries();
    queryClient.clear();
    try {
      await persist(null, null);
      setError(null);
    } catch {
      setError("خرجت من الحساب. تعذّر تحديث التخزين الآمن على الجهاز.");
    }
    setUser(null);
    setStatus("guest");
    operation.current = null;
    try {
      const history = await import("../features/assistant/history");
      await history.clearAllAssistantHistory();
    } catch {
      /* Stored text remains account and origin scoped if the OS store is unavailable. */
    }
  }, [queryClient, persist]);
  return (
    <Context.Provider
      value={{
        user,
        status,
        error,
        refresh,
        applyProfileUser,
        runProfileWrite,
        signOut,
        acceptAgreement,
        signInGoogle,
        signInApple,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAuth() {
  const context = useContext(Context);
  if (!context) throw new Error("AuthProvider is required.");
  return context;
}
