export const MAX_FILE_SIZE = 5 * 1024 * 1024;

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};
const RESULT_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_IMAGE_DIMENSION = 960;
const IMAGE_QUALITY = 0.76;

export function imageMimeType(file) {
  if (ALLOWED_TYPES.has(file?.type)) return file.type;
  const extension = String(file?.name || "").split(".").pop().toLowerCase();
  return MIME_BY_EXTENSION[extension] || "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Could not optimize the selected image."));
    element.src = source;
  });
}

export async function optimizedImage(file) {
  const source = await fileToDataUrl(file);
  const bitmap = typeof createImageBitmap === "function"
    ? await createImageBitmap(file)
    : await loadImage(source);
  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
  if (scale === 1 && file.type === "image/webp") {
    bitmap.close?.();
    return {data: source.split(",")[1], mimeType: "image/webp"};
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const optimized = canvas.toDataURL("image/webp", IMAGE_QUALITY);
  return {data: optimized.split(",")[1], mimeType: "image/webp"};
}

export function fileFingerprint(file) {
  return [file?.name || "", file?.size || 0, file?.lastModified || 0].join(":");
}

export function readCachedResult(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved?.value || Date.now() - saved.savedAt > RESULT_CACHE_MAX_AGE) {
      localStorage.removeItem(key);
      return null;
    }
    return saved.value;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export function saveCachedResult(key, value) {
  if (value) localStorage.setItem(key, JSON.stringify({value, savedAt: Date.now()}));
}

export function parseJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function renderList(element, items) {
  element.replaceChildren(...items.slice(0, 5).map((item) => {
    const li = document.createElement("li");
    li.textContent = cleanText(item, 220);
    return li;
  }));
}

export {cleanText};
