type SessionIdentity = { token: string | null; generation: number; epoch: number };

/** Share only concurrent reads of the same session; never cache the result. */
export function createSessionRefresh() {
  let pending: { identity: SessionIdentity; promise: Promise<void>; next?: () => Promise<void> } | undefined;
  return (identity: SessionIdentity, request: () => Promise<void>, afterWrite = false): Promise<void> => {
    if (pending && pending.identity.token === identity.token &&
      pending.identity.generation === identity.generation && pending.identity.epoch === identity.epoch) {
      if (afterWrite) pending.next = request;
      return pending.promise;
    }
    const entry: NonNullable<typeof pending> = { identity, promise: Promise.resolve() };
    pending = entry;
    entry.promise = Promise.resolve().then(async () => {
      let read: (() => Promise<void>) | undefined = request;
      do {
        entry.next = undefined;
        await read();
        read = pending === entry ? entry.next : undefined;
      } while (read);
    }).finally(() => {
      if (pending === entry) pending = undefined;
    });
    return entry.promise;
  };
}
