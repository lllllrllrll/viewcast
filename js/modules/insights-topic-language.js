const stopWords = new Set([
  "the", "and", "for", "with", "you", "your", "this", "that", "from", "into", "what", "when", "why", "how",
  "are", "was", "were", "will", "can", "about", "after", "before", "video", "short", "shorts", "part", "new",
  "best", "worst", "full", "official", "live", "first", "last", "more", "less", "just", "like", "than",
  "gets", "got", "get", "has", "had", "have", "does", "did", "using", "use", "made", "make", "making"
]);

export function normalizedTitleWords(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter((word) => word.length > 1);
}

export function importantWords(text) {
  return normalizedTitleWords(text).filter((word) => word.length > 2 && !stopWords.has(word));
}

export function titleTopicPhrases(text) {
  const important = normalizedTitleWords(text).filter((word) => word.length > 2 && !stopWords.has(word));
  const phrases = important.length >= 2 && important.length <= 5 ? [important.join(" ")] : [];
  for (let size = Math.min(4, important.length); size >= 2; size -= 1) {
    for (let index = 0; index <= important.length - size; index += 1) {
      phrases.push(important.slice(index, index + size).join(" "));
    }
  }
  return [...new Set(phrases)].filter((phrase) => phrase.length <= 44).slice(0, 8);
}

export function phraseWords(phrase) {
  return importantWords(phrase);
}

export function normalizedPhrase(phrase) {
  return phraseWords(phrase).join(" ");
}

export function stronglyOverlapsSourceTopic(topic, sourceTopics) {
  const topicWords = new Set(phraseWords(topic));
  if (!topicWords.size) return true;
  return sourceTopics.some((sourceTopic) => {
    const sourceWords = new Set(phraseWords(sourceTopic));
    if (!sourceWords.size) return false;
    const shared = [...topicWords].filter((word) => sourceWords.has(word)).length;
    return normalizedPhrase(topic) === normalizedPhrase(sourceTopic) ||
      shared / topicWords.size >= 0.9 ||
      (topicWords.size <= 2 && shared / sourceWords.size >= 0.75);
  });
}

export function addTopicScores(scores, video, weight) {
  const phrases = titleTopicPhrases(video.snippet?.title);
  phrases.forEach((phrase, index) => {
    scores.set(phrase, (scores.get(phrase) || 0) + weight * (phrases.length - index + 1));
  });
  if (!phrases.length) importantWords(video.snippet?.title).forEach((word) => {
    scores.set(word, (scores.get(word) || 0) + weight);
  });
}
