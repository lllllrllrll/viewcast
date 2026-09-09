import {requestGeminiText} from "../gemini-client.js?v=8";
import {createBusySetter, createStatusSetter} from "../services/ui-state.js?v=1";

export function createThumbnailChat({getFile, getTitle}) {
  const form = document.querySelector("#thumbnailChatForm");
  const input = document.querySelector("#thumbnailChatInput");
  const send = document.querySelector("#thumbnailChatSend");
  const messages = document.querySelector("#thumbnailChatMessages");
  const setStatus = createStatusSetter(
    document.querySelector("#thumbnailChatStatus"),
    {reflectType: true}
  );
  const setBusy = createBusySetter([input, send], {updateLabel: false});
  let analysis = null;
  let history = [];

  function append(role, text) {
    const message = document.createElement("div");
    message.className = `chat-message ${role}`;
    message.textContent = text;
    messages.append(message);
    messages.scrollTop = messages.scrollHeight;
  }

  function reset() {
    analysis = null;
    history = [];
    messages.replaceChildren();
    append("assistant", "I’ve reviewed this thumbnail. Ask me anything about the score or how I would improve it.");
    input.value = "";
    setStatus("");
  }

  document.querySelectorAll("#thumbnailChatPrompts button").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.textContent;
      input.focus();
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || !getFile() || !analysis) return;
    append("user", question);
    history.push({role: "user", text: question});
    input.value = "";
    setBusy(true);
    setStatus("Gemini is thinking…", "loading");
    try {
      const recentConversation = history.slice(-2)
        .map((message) => `${message.role === "user" ? "User" : "Gemini"}: ${message.text}`)
        .join("\n");
      const reply = await requestGeminiText({
        systemInstruction: "Answer thumbnail follow-ups concisely using only the supplied analysis. Be specific and honest about uncertainty.",
        contents: [{role: "user", parts: [{text: `Analysis:${JSON.stringify({score: analysis.score, verdict: analysis.verdict, titleAlignment: analysis.titleAlignment, improvements: analysis.improvements, recommendation: analysis.recommendation})}\nTitle:${getTitle()}\nRecent chat:${recentConversation}\nAnswer the latest question directly.`}]}],
        generationConfig: {temperature: 0.3, maxOutputTokens: 96}
      });
      const answer = reply || "I could not produce a useful answer for that question.";
      append("assistant", answer);
      history.push({role: "assistant", text: answer});
      setStatus("");
    } catch (error) {
      console.error("Thumbnail follow-up failed.", error);
      append("assistant", "I couldn’t answer that right now. Please try again.");
      setStatus("Gemini could not answer this question.", "error");
    } finally {
      setBusy(false);
      input.focus();
    }
  });

  reset();
  return {
    reset,
    setAnalysis(value) { analysis = value; }
  };
}
