import {buildGeminiChatReply} from "../insights-gemini-page.js?v=5";
import {createBusySetter} from "../services/ui-state.js?v=1";

export function createInsightsChat({messages, input, getSummary}) {
  const setBusy = createBusySetter(input, {updateLabel: false});
  let history = [];

  function append(role, message, addToHistory = true) {
    if (!messages) return null;
    const bubble = document.createElement("div");
    bubble.className = `chat-message ${role}`;
    bubble.textContent = message;
    messages.append(bubble);
    messages.scrollTop = messages.scrollHeight;
    if (addToHistory) history.push({
      role: role === "user" ? "user" : "model",
      parts: [{text: message}]
    });
    return bubble;
  }

  function seed(message = "Hi! I'm your ViewCast assistant. To give you the best advice, should we focus on growing your views, increasing your subscribers, or improving your retention today?") {
    if (!messages) return;
    messages.innerHTML = "";
    history = [];
    append("assistant", message);
  }

  async function send(question) {
    if (!question) return;
    append("user", question);
    if (input) input.value = "";
    const thinking = append("assistant", "Thinking...", false);
    setBusy(true);
    try {
      const reply = await buildGeminiChatReply(question, getSummary(), history);
      if (thinking) {
        thinking.textContent = reply;
        history.push({role: "model", parts: [{text: reply}]});
      }
    } catch (error) {
      console.warn("Gemini advice failed.", error);
      if (thinking) thinking.textContent = "I'm having trouble connecting to my brain right now.";
    } finally {
      if (input) {
        setBusy(false);
        input.focus();
      }
    }
  }

  return {seed, send};
}
