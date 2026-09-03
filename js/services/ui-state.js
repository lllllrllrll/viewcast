export function ensureStatusElement({id, parent, tagName = "span", className = ""} = {}) {
  if (!id) return null;

  const existing = document.getElementById(id);
  if (existing) return existing;
  if (!parent) return null;

  const element = document.createElement(tagName);
  element.id = id;
  element.className = className;
  parent.append(element);
  return element;
}

export function createStatusSetter(targets, {
  hideWhenEmpty = false,
  reflectType = false,
  defaultType = "",
  className = "",
  showWhenSet = false
} = {}) {
  const elements = targets && typeof targets !== "string" && Symbol.iterator in Object(targets)
    ? [...targets]
    : [targets];
  return (message, type = defaultType) => {
    const text = String(message || "");
    elements.filter(Boolean).forEach((element) => {
      element.textContent = text;
      if (reflectType) element.dataset.type = type;
      if (className) element.className = typeof className === "function" ? className(type) : className;
      if (hideWhenEmpty) element.hidden = !text;
      else if (showWhenSet) element.hidden = false;
    });
  };
}

export function setControlsDisabled(controls, isDisabled) {
  const elements = controls && typeof controls !== "string" && Symbol.iterator in Object(controls)
    ? [...controls]
    : [controls];
  elements.filter(Boolean).forEach((element) => {
    element.disabled = isDisabled;
  });
}

export function setAriaBusy(element, isBusy) {
  if (!element) return;
  if (isBusy) element.setAttribute("aria-busy", "true");
  else element.removeAttribute("aria-busy");
}

function resolveValue(value, fallback = "") {
  return typeof value === "function" ? value() : value ?? fallback;
}

export function createBusySetter(targets, {
  busyLabel = "Loading...",
  idleLabel = "",
  busyClass = "",
  reflectAriaBusy = false,
  updateLabel = true
} = {}) {
  const entries = (Array.isArray(targets) ? targets : [targets])
    .map((target) => target?.element ? target : {element: target})
    .filter(({element}) => Boolean(element));

  return (isBusy, label = resolveValue(idleLabel)) => {
    entries.forEach(({element, labelElement = element, updateLabel: entryUpdatesLabel = updateLabel}) => {
      setControlsDisabled(element, isBusy);
      if (busyClass) element.classList.toggle(busyClass, isBusy);
      if (reflectAriaBusy) setAriaBusy(element, isBusy);
      if (!entryUpdatesLabel) return;
      const output = typeof labelElement === "function" ? labelElement() : labelElement;
      if (output) output.textContent = isBusy ? resolveValue(busyLabel) : label;
    });
  };
}
