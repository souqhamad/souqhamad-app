import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import { getApiBaseUrl } from './api';
import { createAppUsageTracker } from './app-usage-session';

const installationKey = 'souqhamad.analytics.installation.v1';
const tracker = Platform.OS === 'ios' || Platform.OS === 'android' ? createAppUsageTracker({
  platform: Platform.OS,
  readId: () => SecureStore.getItemAsync(installationKey),
  writeId: id => SecureStore.setItemAsync(installationKey, id, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  uuid: randomUUID,
  async send(receipt) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await expoFetch(`${getApiBaseUrl()}/api/analytics/visit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(receipt), credentials: 'omit', signal: controller.signal,
      });
      return response.ok;
    } finally { clearTimeout(timeout); }
  },
}) : null;

export function useAppUsage() {
  useEffect(() => {
    if (!tracker) return;
    if (AppState.currentState === 'active') tracker.foreground();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') tracker.foreground();
      else tracker.background();
    });
    // A light foreground check also captures a new Saudi day during a long session.
    const interval = setInterval(() => { void tracker.pulse(); }, 60_000);
    return () => { subscription.remove(); clearInterval(interval); tracker.background(); };
  }, []);
}
