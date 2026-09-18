(function () {
  const items = [
    {
      title: "Audience segments",
      description: "Track returning viewers, subscribers, new viewers, and high-intent commenters."
    },
    {
      title: "Publishing cadence",
      description: "Monitor upload consistency, content pillars, and format balance."
    },
    {
      title: "Channel health",
      description: "Watch engagement quality, retention stability, and subscriber conversion."
    }
  ];

  function createShowcaseItem(item) {
    const container = document.createElement("div");
    const title = document.createElement("b");
    const description = document.createElement("span");

    container.className = "showcase-item";
    title.textContent = item.title;
    description.textContent = item.description;
    container.append(title, description);

    return container;
  }

  document.querySelectorAll("[data-component='channel-showcase']").forEach((mount) => {
    const itemsFragment = document.createDocumentFragment();
    items.forEach((item) => itemsFragment.append(createShowcaseItem(item)));
    mount.replaceWith(itemsFragment);
  });
})();
