(function () {
  const accountDetails = [
    { label: "Account ID", id: "accountId", element: "code", className: "account-id-code" },
    { label: "Member Since", id: "memberSince", element: "span" },
    { label: "Last Sign In", id: "lastSignIn", element: "span" }
  ];

  function createRow(label, valueElement) {
    const row = document.createElement("div");
    const labelElement = document.createElement("span");

    row.className = "settings-row";
    labelElement.textContent = label;
    row.append(labelElement, valueElement);

    return row;
  }

  function createDarkModeRow() {
    const toggle = document.createElement("div");
    toggle.className = "segmented settings-toggle";
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", "Dark mode");
    toggle.dataset.setting = "darkMode";

    [
      { label: "Off", value: "off", active: true },
      { label: "On", value: "on", active: false }
    ].forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.value = option.value;
      button.textContent = option.label;
      button.classList.toggle("active", option.active);
      button.setAttribute("aria-pressed", String(option.active));
      toggle.append(button);
    });

    return createRow("Dark Mode", toggle);
  }

  function createAccountDetailRows() {
    const fragment = document.createDocumentFragment();

    accountDetails.forEach((detail) => {
      const value = document.createElement(detail.element);
      value.id = detail.id;
      value.textContent = "Loading...";
      if (detail.className) value.className = detail.className;
      fragment.append(createRow(detail.label, value));
    });

    return fragment;
  }

  document.querySelectorAll("[data-component='settings-rows']").forEach((mount) => {
    const rows = mount.dataset.group === "account-details"
      ? createAccountDetailRows()
      : createDarkModeRow();
    mount.replaceWith(rows);
  });
})();
