import {MAX_FILE_SIZE, imageMimeType} from "./thumbnail-images.js?v=1";

export function createImageUpload({
  input,
  dropzone,
  preview,
  image,
  name,
  size,
  remove,
  invalidTypeMessage = "Choose a JPG, PNG, or WebP image.",
  oversizedMessage = "That image is larger than 5 MB. Choose a smaller file.",
  setStatus = () => {},
  onChange = () => {}
}) {
  let file = null;
  let previewUrl = "";

  function clear() {
    file = null;
    input.value = "";
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    image.removeAttribute("src");
    preview.hidden = true;
    dropzone.hidden = false;
    onChange(null);
  }

  function select(nextFile) {
    if (!nextFile) return false;
    if (!imageMimeType(nextFile)) {
      setStatus(invalidTypeMessage, "error");
      return false;
    }
    if (nextFile.size > MAX_FILE_SIZE) {
      setStatus(oversizedMessage, "error");
      return false;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    file = nextFile;
    previewUrl = URL.createObjectURL(nextFile);
    image.src = previewUrl;
    name.textContent = nextFile.name;
    size.textContent = `${(nextFile.size / 1024 / 1024).toFixed(2)} MB`;
    preview.hidden = false;
    dropzone.hidden = true;
    onChange(nextFile);
    return true;
  }

  input.addEventListener("change", () => select(input.files?.[0]));
  remove.addEventListener("click", clear);
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  ["dragenter", "dragover"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  }));
  dropzone.addEventListener("drop", (event) => select(event.dataTransfer?.files?.[0]));

  return {
    clear,
    select,
    selectedFile: () => file
  };
}
