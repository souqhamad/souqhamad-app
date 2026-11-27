type NotificationDestination =
  | `/listings/${string}`
  | `/conversations/${string}`;

/** Server follow notifications append attribution queries to their app links. */
export function notificationDestination(value: unknown): NotificationDestination | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return null;
  try {
    const url = new URL(value, "https://notification.invalid");
    if (url.origin !== "https://notification.invalid") return null;
    // Attribution is not needed for navigation. Only known native screens qualify.
    return /^\/(listings|conversations)\/[A-Za-z0-9_-]+$/.test(url.pathname)
      ? (url.pathname as NotificationDestination)
      : null;
  } catch {
    return null;
  }
}
