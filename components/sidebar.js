(function () {
  const pages = [
    {
      id: "overview",
      label: "Overview",
      file: "index.html",
      icon: '<path d="M3 13h8V3H3z" /><path d="M13 21h8V11h-8z" /><path d="M13 3h8v6h-8z" /><path d="M3 21h8v-6H3z" />'
    },
    {
      id: "trends",
      label: "Trends",
      file: "trends.html",
      icon: '<path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />'
    },
    {
      id: "analyzer",
      label: "Video Analyzer",
      file: "analyzer.html",
      icon: '<path d="M21 15V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9" /><path d="M7 20h10" /><path d="M12 16v4" />'
    },
    {
      id: "channel",
      label: "My Channel",
      file: "channel.html",
      icon: '<rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3z" />'
    },
    {
      id: "insights",
      label: "AI Insights",
      file: "insights.html",
      icon: '<path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" /><path d="M9 21h6" /><path d="M10 17h4" />'
    },
    {
      id: "audience",
      label: "Audience",
      file: "audience.html",
      icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />'
    },
    {
      id: "retention",
      label: "Retention",
      file: "retention.html",
      icon: '<path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" />'
    },
    {
      id: "settings",
      label: "Settings",
      file: "settings.html",
      icon: '<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.23.36.6.6 1 .6h.6a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" />'
    }
  ];

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hrefFor(page, root) {
    if (page.file === "index.html") return root === ".." ? "../index.html" : "index.html";
    return root === ".." ? page.file : `pages/${page.file}`;
  }

  function renderSidebar(mount) {
    const active = mount.dataset.active || "overview";
    const root = mount.dataset.root || ".";
    const footerTitle = mount.dataset.footerTitle || "Workspace";
    const footerText = mount.dataset.footerText || "Manage your creator analytics workspace.";
    const links = pages.map((page) => `
      <a href="${hrefFor(page, root)}"${page.id === active ? ' class="active"' : ""}>
        <svg viewBox="0 0 24 24">${page.icon}</svg>
        ${page.label}
      </a>
    `).join("");

    mount.outerHTML = `
      <aside class="sidebar" aria-label="Dashboard navigation">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 19V5" />
              <path d="M4 19h16" />
              <path d="m8 15 3-4 3 2 4-7" />
            </svg>
          </div>
          <div>
            <h1>ViewCast</h1>
            <span>Audience Studio</span>
          </div>
        </div>
        <nav class="nav">${links}</nav>
        <div class="sidebar-footer">
          <strong>${escapeHtml(footerTitle)}</strong>
          <span>${escapeHtml(footerText)}</span>
        </div>
      </aside>
    `;
  }

  document.querySelectorAll("[data-component='sidebar']").forEach(renderSidebar);
})();
