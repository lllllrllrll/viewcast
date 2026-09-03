const DEFAULT_INTERVAL = 5 * 60 * 1000;
const DEFAULT_MIN_GAP = 60 * 1000;

export function startStudioAutoRefresh(refresh, options = {}) {
  const intervalMs = options.intervalMs || DEFAULT_INTERVAL;
  const minGapMs = options.minGapMs || DEFAULT_MIN_GAP;
  let lastStartedAt = 0;
  let activeRefresh = null;

  const run = (reason) => {
    if (document.hidden || !navigator.onLine) return Promise.resolve(false);
    if (activeRefresh) return activeRefresh;
    if (Date.now() - lastStartedAt < minGapMs) return Promise.resolve(false);
    lastStartedAt = Date.now();
    activeRefresh = Promise.resolve(refresh(reason))
      .then(() => {
        window.dispatchEvent(new CustomEvent("viewcast:studio-refreshed", {
          detail: {reason, refreshedAt: Date.now()}
        }));
        return true;
      })
      .catch((error) => {
        console.warn("Automatic YouTube Studio refresh failed.", error);
        return false;
      })
      .finally(() => { activeRefresh = null; });
    return activeRefresh;
  };

  const onVisibility = () => {
    if (!document.hidden) run("visible");
  };
  const onOnline = () => run("online");
  const timer = window.setInterval(() => run("interval"), intervalMs);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);

  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
  };
}
