import {doc, getDoc, serverTimestamp, setDoc} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {createBusySetter, createStatusSetter} from "../services/ui-state.js?v=1";

const storagePrefix = "viewcastChannelContext:";

export function createChannelContextController({getCurrentUser, getDb}) {
  const form = document.getElementById("channelContextForm");
  const topicInput = document.getElementById("channelTopic");
  const contextInput = document.getElementById("channelContext");
  const setStatus = createStatusSetter(document.getElementById("channelContextStatus"));
  const setBusy = createBusySetter(document.getElementById("saveChannelContext"), {updateLabel: false});
  const storageKey = (user) => user ? `${storagePrefix}${user.uid}` : "";

  function render(value = {}) {
    if (topicInput) topicInput.value = value.channelTopic || "";
    if (contextInput) contextInput.value = value.channelContext || "";
  }

  function cache(user, value) {
    const key = storageKey(user);
    if (key) sessionStorage.setItem(key, JSON.stringify(value));
  }

  function clearInsights(user) {
    const prefix = `viewcastAiInsights:${user.uid}:`;
    Object.keys(localStorage)
      .filter((key) => key.startsWith(prefix))
      .forEach((key) => localStorage.removeItem(key));
  }

  async function load(user) {
    const key = storageKey(user);
    let localValue = {};
    const hasLocalValue = Boolean(sessionStorage.getItem(key));
    try {
      localValue = JSON.parse(sessionStorage.getItem(key) || "{}");
      render(localValue);
    } catch {
      sessionStorage.removeItem(key);
    }
    try {
      const snapshot = await getDoc(doc(getDb(), "users", user.uid));
      const data = snapshot.exists() ? snapshot.data() : {};
      const value = {
        channelTopic: String(hasLocalValue ? localValue.channelTopic || "" : data.channelTopic || "").slice(0, 120),
        channelContext: String(hasLocalValue ? localValue.channelContext || "" : data.channelContext || "").slice(0, 1000)
      };
      cache(user, value);
      render(value);
    } catch (error) {
      render(localValue);
      console.warn("Could not load saved channel context.", error);
    }
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const user = getCurrentUser();
    const db = getDb();
    if (!user || !db) return;
    const value = {
      channelTopic: topicInput?.value.trim().slice(0, 120) || "",
      channelContext: contextInput?.value.trim().slice(0, 1000) || ""
    };
    cache(user, value);
    clearInsights(user);
    render(value);
    setBusy(true);
    setStatus("Saving...");
    try {
      await setDoc(doc(db, "users", user.uid), {...value, updatedAt: serverTimestamp()}, {merge: true});
      setStatus("Saved. New AI insights will use this context.");
    } catch (error) {
      console.error("Could not save channel context.", error);
      setStatus("Saved on this device. Cloud sync is unavailable.");
    } finally {
      setBusy(false);
    }
  });

  return {load};
}
