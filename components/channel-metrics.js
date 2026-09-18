(function () {
  const metrics = [
    {
      label: "Total Subs",
      field: "subscriber-count",
      color: "teal",
      icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>'
    },
    {
      label: "Watch Hours",
      field: "watch-hours",
      color: "blue",
      icon: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'
    },
    {
      label: "Total Views",
      field: "total-views",
      color: "amber",
      icon: '<line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>'
    },
    {
      label: "Videos",
      field: "video-count",
      color: "rose",
      wide: true,
      icon: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>'
    },
    {
      label: "Estimated Revenue",
      field: "estimated-revenue",
      color: "teal",
      wide: true,
      trend: "28D",
      value: "Not available",
      status: "Checking YouTube revenue access…",
      icon: '<line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>'
    }
  ];

  function metricHtml(metric) {
    const classes = `metric-card channel-metric-card${metric.wide ? " channel-metric-wide" : ""}`;
    const status = metric.status
      ? `<p class="metric-data-status" data-revenue-status>${metric.status}</p>`
      : "";

    return `
      <article class="${classes}">
        <div class="metric-head">
          <div class="metric-icon ${metric.color}"><svg viewBox="0 0 24 24">${metric.icon}</svg></div>
          <span class="trend good">${metric.trend || "&nbsp;"}</span>
        </div>
        <div>
          <h3>${metric.label}</h3>
          <div class="metric-value" data-youtube-field="${metric.field}">${metric.value || "&nbsp;"}</div>
          ${status}
        </div>
      </article>
    `;
  }

  document.querySelectorAll("[data-component='channel-metrics']").forEach((mount) => {
    const cards = document.createRange().createContextualFragment(metrics.map(metricHtml).join(""));
    mount.replaceWith(cards);
  });
})();
