export function numberValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function compactNumber(value) {
  const number = numberValue(value);
  if (number === null) return "";
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: number >= 1000 ? 1 : 0
  }).format(number);
}

export function wholeNumber(value) {
  const number = numberValue(value);
  return number === null ? "" : new Intl.NumberFormat("en").format(Math.round(number));
}

export function durationFromSeconds(value) {
  const number = numberValue(value);
  if (number === null) return "";
  const totalSeconds = Math.max(0, Math.round(number));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function secondsFromIso(value = "") {
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

export function durationFromIso(value = "") {
  const seconds = secondsFromIso(value);
  return seconds === null ? "" : durationFromSeconds(seconds);
}

export function dateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {month: "short", day: "numeric", year: "numeric"}).format(date);
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const youtubeCategoryNames = {
  "1": "Film & Animation", "2": "Autos & Vehicles", "10": "Music",
  "15": "Pets & Animals", "17": "Sports", "19": "Travel & Events",
  "20": "Gaming", "22": "People & Blogs", "23": "Comedy",
  "24": "Entertainment", "25": "News & Politics", "26": "Howto & Style",
  "27": "Education", "28": "Science & Technology"
};

export function shortText(value = "", max = 280) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function youtubeCategoryName(categoryId) {
  return youtubeCategoryNames[String(categoryId || "")] || "";
}

export function bestThumbnail(thumbnails = {}) {
  return thumbnails.maxres?.url || thumbnails.standard?.url || thumbnails.high?.url
    || thumbnails.medium?.url || thumbnails.default?.url || "";
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}
