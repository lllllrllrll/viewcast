const allConnectionsKey = "viewcastYouTubeAllConnections";
const activeConnectionKey = "viewcastYouTubeConnection";
const channelStorageKey = "viewcastYouTubeChannel";
export const tokenStorageKey = "viewcastYouTubeAccessToken";
export const MAX_LINKED_CHANNELS = 5;

export function createYouTubeConnections({getCurrentUser, onUpdate = () => {}}) {
  function readActive() {
    try {
      return JSON.parse(localStorage.getItem(activeConnectionKey) || "null");
    } catch {
      return null;
    }
  }

  function readAll() {
    try {
      let connections = JSON.parse(localStorage.getItem(allConnectionsKey) || "[]");
      if (!connections.length) {
        const active = readActive();
        if (active?.channel) {
          connections = [active];
          localStorage.setItem(allConnectionsKey, JSON.stringify(connections));
        }
      }
      return connections;
    } catch {
      return [];
    }
  }

  function save(connections, activeId = null) {
    const limited = connections.slice(0, MAX_LINKED_CHANNELS);
    localStorage.setItem(allConnectionsKey, JSON.stringify(limited));
    const active = limited.find((connection) => connection.channel.id === activeId) || limited[0] || null;
    if (active) {
      localStorage.setItem(activeConnectionKey, JSON.stringify(active));
      localStorage.setItem(channelStorageKey, JSON.stringify(active.channel));
    } else {
      localStorage.removeItem(activeConnectionKey);
      localStorage.removeItem(channelStorageKey);
    }
    onUpdate();
  }

  function saveAccessToken(accessToken, channelId) {
    const user = getCurrentUser();
    if (!accessToken || !user) return;
    sessionStorage.setItem(tokenStorageKey, JSON.stringify({
      accessToken,
      uid: user.uid,
      channelId,
      expiresAt: Date.now() + 50 * 60 * 1000
    }));
    localStorage.removeItem(tokenStorageKey);
  }

  function clearAccessToken() {
    sessionStorage.removeItem(tokenStorageKey);
    localStorage.removeItem(tokenStorageKey);
  }

  return {clearAccessToken, readActive, readAll, save, saveAccessToken};
}
