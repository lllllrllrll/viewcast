function themeColor(variable, fallback) {
  return getComputedStyle(document.body).getPropertyValue(variable).trim() || fallback;
}

export const colors = {
  get ink() { return themeColor("--ink", "#1c2430"); },
  get surface() { return themeColor("--surface", "#ffffff"); },
  get muted() { return themeColor("--muted", "#667085"); },
  get line() { return themeColor("--line", "#d8e0ea"); },
  get teal() { return themeColor("--teal", "#0f8b8d"); },
  get blue() { return themeColor("--blue", "#3267d6"); },
  get amber() { return themeColor("--amber", "#c47f13"); },
  get rose() { return themeColor("--rose", "#d04d67"); },
  get green() { return themeColor("--green", "#2f9b6c"); }
};
