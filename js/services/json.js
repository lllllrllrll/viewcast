export function parseJsonObject(value) {
  const cleaned = String(value || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const object = cleaned.match(/\{[\s\S]*\}/)?.[0];
    if (!object) return null;
    try {
      return JSON.parse(object.replace(/,[ \t\r\n]*([\]\}])/g, "$1"));
    } catch {
      return null;
    }
  }
}
