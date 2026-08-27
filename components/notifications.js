const STORAGE_KEY = "viewcastNotifications";
const MAX_NOTIFICATIONS = 24;

function clean(value, max = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function readNotifications() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item?.id && item?.href) : [];
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return [];
  }
}

export function addNotification({id, title, message, href, tone = "blue"}) {
  const safeId = clean(id, 220);
  const safeHref = clean(href, 500);
  if (!safeId || !/^pages\/[a-z-]+\.html(?:\?.*)?$/.test(safeHref)) return;

  const next = {
    id: safeId,
    title: clean(title, 56) || "New result",
    message: clean(message, 180),
    href: safeHref,
    tone: ["teal", "blue", "amber", "rose"].includes(tone) ? tone : "blue",
    createdAt: Date.now()
  };
  const notifications = readNotifications().filter((item) => item.id !== safeId);
  notifications.unshift(next);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS)));
  localStorage.removeItem("viewcastNotificationsRead");
}

export function addNotifications(items = []) {
  [...items].reverse().forEach(addNotification);
}
