(function () {
  const metrics = [
    {
      label: "Best Upload Time",
      color: "teal",
      trend: "good",
      icon: '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>'
    },
    {
      label: "Next Video Length",
      color: "blue",
      trend: "good",
      icon: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'
    },
    {
      label: "Next Short Length",
      color: "amber",
      trend: "warn",
      icon: '<path d="M1 4h6v16H1zM17 4h6v16h-6zM9 9h6v11H9z"></path>'
    }
  ];

  function metricHtml(metric) {
    return `
      <article class="metric-card analyzer-result" data-insights-panel="analysis">
        <div class="metric-head">
          <div class="metric-icon ${metric.color}"><svg viewBox="0 0 24 24">${metric.icon}</svg></div>
          <span class="trend ${metric.trend}">&nbsp;</span>
        </div>
        <div>
          <h3>${metric.label}</h3>
          <div class="metric-value">&nbsp;</div>
        </div>
      </article>
    `;
  }

  document.querySelectorAll("[data-component='insights-metrics']").forEach((mount) => {
    const cards = document.createRange().createContextualFragment(metrics.map(metricHtml).join(""));
    mount.replaceWith(cards);
  });
})();
