(function () {
  const form = document.getElementById("channelLinkForm");
  const input = document.getElementById("channelUrl");
  const openLink = document.getElementById("openChannelLink");
  const storageKey = "viewcastChannelUrl";

  if (!form || !input || !openLink) return;

  function normalizeUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  function setOpenLink(url) {
    if (!url) {
      openLink.hidden = true;
      openLink.removeAttribute("href");
      return;
    }

    openLink.href = url;
    openLink.hidden = false;
  }

  const savedUrl = localStorage.getItem(storageKey) || "";
  input.value = savedUrl;
  setOpenLink(savedUrl);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = normalizeUrl(input.value);

    if (!url) {
      localStorage.removeItem(storageKey);
      input.value = "";
      setOpenLink("");
      return;
    }

    try {
      const parsedUrl = new URL(url);
      localStorage.setItem(storageKey, parsedUrl.href);
      input.value = parsedUrl.href;
      setOpenLink(parsedUrl.href);
    } catch (error) {
      input.setCustomValidity("Enter a valid channel URL.");
      input.reportValidity();
      input.setCustomValidity("");
    }
  });
})();
