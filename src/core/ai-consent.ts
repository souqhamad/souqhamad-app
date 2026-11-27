import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { assertApiIdentity, getApiBaseUrl, getApiIdentity } from './api';
import { useBootstrap } from './bootstrap';

export const aiConsentHeader = 'x-souq-hamad-ai-consent';
export const aiConsentVersion = 'ai-sharing-2026-11-02-v2';
const description = 'تُرسل رسائلك والصور التي تختارها في محادثة حمد إلى خدمة خارجية للذكاء الاصطناعي لمعالجة طلبك. يمكنك رفض المشاركة، أو سحب الموافقة من حسابي، والاستمرار في تصفح السوق وإنشاء إعلان يدويًا.';

export function resolveAiConsentDisclosure(consent?: { version: string; description: string }) {
  return {
    version: consent?.version ?? aiConsentVersion,
    // An older server's disclosure also mentioned category suggestions. Keep its
    // protocol version for compatibility, but explain the current Hamad scope.
    description: consent?.version === 'deepseek-sharing-2026-11-02-v1'
      ? description : consent?.description ?? description,
  };
}
type Scope = { key: string; ownerId: string; version: string };

// All screens share one session. Serialize storage mutations and invalidate late
// reads/approvals so withdrawing consent cannot be undone by in-flight work.
export function createAiConsentSession(dependencies: {
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
  choose: (explanation: string) => Promise<boolean>;
  identity: () => () => void;
  now?: () => number;
}) {
  const memory = new Map<string, string>();
  const revisions = new Map<string, number>();
  const pending = new Map<string, Promise<boolean>>();
  const writes = new Map<string, Promise<unknown>>();
  const listeners = new Set<() => void>();
  const now = dependencies.now ?? Date.now;
  const notify = () => listeners.forEach(listener => listener());
  const revision = (key: string) => revisions.get(key) ?? 0;
  const bump = (key: string) => { const next = revision(key) + 1; revisions.set(key, next); return next; };
  const persist = <T,>(key: string, operation: () => Promise<T>) => {
    const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    writes.set(key, next);
    void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => {});
    return next;
  };
  return {
    has: (scope: Scope) => Boolean(scope.ownerId) && memory.get(scope.key) === scope.version,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async load(scope: Scope) {
      const started = revision(scope.key);
      if (started > 0) return;
      const value = await dependencies.read(scope.key).catch(() => null);
      if (started !== revision(scope.key) || !scope.ownerId) return;
      try {
        const saved = value ? JSON.parse(value) : null;
        const age = now() - saved?.acceptedAt;
        if (saved?.ownerId === scope.ownerId && saved.version === scope.version && Number.isFinite(age) && age >= 0 && age < 365 * 86400000) {
          memory.set(scope.key, scope.version); notify();
        }
      } catch { /* An invalid receipt requires a new explicit choice. */ }
    },
    request(scope: Scope, explanation: string): Promise<boolean> {
      if (!scope.ownerId) return Promise.resolve(false);
      if (memory.get(scope.key) === scope.version) return Promise.resolve(true);
      const pendingKey = `${scope.key}:${scope.version}`;
      const existing = pending.get(pendingKey);
      if (existing) return existing;
      const assertIdentity = dependencies.identity();
      const started = bump(scope.key);
      const choice = (async () => {
        if (!(await dependencies.choose(explanation))) return false;
        try {
          assertIdentity();
          if (revision(scope.key) !== started) return false;
          const selected = bump(scope.key);
          await persist(scope.key, async () => {
            assertIdentity();
            if (revision(scope.key) !== selected) return;
            await dependencies.write(scope.key, JSON.stringify({ ownerId: scope.ownerId, version: scope.version, acceptedAt: now() }));
          });
          assertIdentity();
          if (revision(scope.key) !== selected) return false;
          memory.set(scope.key, scope.version); notify(); return true;
        } catch { return false; }
      })().finally(() => { if (pending.get(pendingKey) === choice) pending.delete(pendingKey); });
      pending.set(pendingKey, choice);
      return choice;
    },
    async revoke(scope: Scope) {
      bump(scope.key); memory.delete(scope.key); notify();
      await persist(scope.key, () => dependencies.remove(scope.key));
    },
  };
}

const session = createAiConsentSession({
  read: key => Platform.OS === 'web' ? Promise.resolve(null) : SecureStore.getItemAsync(key),
  write: (key, value) => Platform.OS === 'web' ? Promise.resolve() : SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: key => Platform.OS === 'web' ? Promise.resolve() : SecureStore.deleteItemAsync(key),
  identity: () => { const identity = getApiIdentity(); return () => assertApiIdentity(identity); },
  choose: explanation => new Promise<boolean>(resolve => {
    Alert.alert('مشاركة البيانات مع الذكاء الاصطناعي', explanation, [
      { text: 'لاحقًا', style: 'cancel', onPress: () => resolve(false) },
      { text: 'أوافق', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  }),
});

export function useAiConsent(ownerId: string) {
  const bootstrap = useBootstrap();
  const { version, description: explanation } = resolveAiConsentDisclosure(bootstrap.data?.aiConsent);
  const encoded = [...`${getApiBaseUrl()}\n${ownerId}`].map(char => char.codePointAt(0)!.toString(16)).join('_');
  const key = `souq-hamad.ai-consent.${encoded}`;
  const [acceptedKey, setAcceptedKey] = useState('');
  useEffect(() => {
    const scope = { key, ownerId, version };
    const update = () => setAcceptedKey(session.has(scope) ? `${key}:${version}` : '');
    const unsubscribe = session.subscribe(update);
    update(); void session.load(scope);
    return unsubscribe;
  }, [ownerId, key, version]);
  const request = useCallback(() => session.request({ key, ownerId, version }, explanation), [ownerId, key, version, explanation]);
  const revoke = useCallback(() => session.revoke({ key, ownerId, version }), [ownerId, key, version]);
  return { accepted: acceptedKey === `${key}:${version}`, request, revoke, version };
}
