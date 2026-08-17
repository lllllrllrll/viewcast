const settingsUrl = new URL("settings.html", window.location.href);
settingsUrl.search = window.location.search;
settingsUrl.hash = window.location.hash;
window.location.replace(settingsUrl.href);
