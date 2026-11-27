export type FeedbackTone = "success" | "error" | "info" | "warning";
export type FeedbackMessage = { id: number; tone: FeedbackTone; message: string };
export type FeedbackButton = { text?: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void };
export type FeedbackDialog = { id: number; title: string; message?: string; buttons: FeedbackButton[] };
export type FeedbackState = { message: FeedbackMessage | null; dialog: FeedbackDialog | null; host: number | null };

// A bounded, account-scoped presentation store. It never observes API requests
// or creates persistent/push notifications.
export function createFeedbackStore() {
  let state: FeedbackState = { message: null, dialog: null, host: null };
  let epoch = 0;
  let serial = 0;
  let identity = "";
  let pendingIdentity: { epoch: number; message: string } | null = null;
  const queue: FeedbackMessage[] = [];
  const hosts = new Map<number, number>();
  const listeners = new Set<() => void>();
  const update = (next: FeedbackState) => { state = next; listeners.forEach(listener => listener()); };
  const dismiss = (id: number) => {
    if (state.message?.id === id) update({ ...state, message: queue.shift() ?? null });
  };
  const enqueue = (tone: FeedbackTone, message: string, scope = epoch) => {
    if (scope !== epoch || !message.trim()) return;
    if ([state.message, ...queue].some(item => item?.message === message && item.tone === tone)) return;
    const next = { id: ++serial, tone, message };
    // An error is visible immediately; do not bury it behind routine successes.
    if (tone === "error") { queue.length = 0; update({ ...state, message: next }); }
    else if (!state.message) update({ ...state, message: next });
    else { if (queue.length >= 3) queue.shift(); queue.push(next); }
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    scope: () => epoch,
    identity: () => identity,
    isCurrent: (scope: number) => scope === epoch,
    setIdentity(key: string, guest: boolean) {
      if (key === identity) return;
      const notice = pendingIdentity?.epoch === epoch && guest ? pendingIdentity.message : null;
      pendingIdentity = null;
      identity = key;
      epoch++;
      queue.length = 0;
      update({ ...state, message: null, dialog: null });
      if (notice) enqueue("success", notice);
    },
    expectSignOut(message: string) { pendingIdentity = { epoch, message }; },
    cancelSignOut() { pendingIdentity = null; },
    enqueue,
    dismiss,
    openDialog(title: string, message: string | undefined, buttons: FeedbackButton[]) {
      update({ ...state, dialog: { id: ++serial, title, message, buttons } });
    },
    closeDialog(id: number, button?: FeedbackButton) {
      if (state.dialog?.id !== id) return;
      update({ ...state, dialog: null });
      button?.onPress?.();
    },
    registerHost(priority: number) {
      const id = ++serial;
      hosts.set(id, priority);
      const select = () => update({ ...state, host: [...hosts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null });
      select();
      return { id, remove: () => { hosts.delete(id); select(); } };
    },
    clear() { queue.length = 0; pendingIdentity = null; update({ ...state, message: null, dialog: null }); },
  };
}

export const feedbackStore = createFeedbackStore();
