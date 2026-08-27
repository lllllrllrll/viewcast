function hasVisibleButtonLabel(button) {
  return Boolean(
    button.textContent.replace(/\s+/g, " ").trim()
    || button.getAttribute("aria-label")?.trim()
  );
}

function hideEmptyPrimaryButtons(root = document) {
  root.querySelectorAll?.(".primary-button").forEach((button) => {
    if (hasVisibleButtonLabel(button)) {
      if (button.dataset.emptyLabelHidden === "true") {
        button.hidden = false;
        delete button.dataset.emptyLabelHidden;
      }
      return;
    }

    button.hidden = true;
    button.dataset.emptyLabelHidden = "true";
  });
}

window.addEventListener("resize", redrawThemedCharts);
document.addEventListener("DOMContentLoaded", () => {
  initCharts();
  hideEmptyPrimaryButtons();

  const themeObserver = new MutationObserver(redrawThemedCharts);
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"]
  });

  const emptyButtonObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const button = target?.closest?.(".primary-button");
      if (button) {
        hideEmptyPrimaryButtons(button.parentElement || document);
      } else {
        hideEmptyPrimaryButtons(target || document);
      }
    });
  });

  emptyButtonObserver.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true
  });

  // Notification Toggle Logic
  const notifButton = document.getElementById("notifButton");
  const notifDropdown = document.getElementById("notifDropdown");
  const markRead = document.getElementById("markRead");
  const notifBadge = document.querySelector(".notif-badge");
  const storageKey = "viewcastNotificationsRead";

  if (notifButton && notifDropdown) {
    // Check if notifications were previously read
    if (Number(localStorage.getItem(storageKey) || 0) > 0) {
      if (notifBadge) notifBadge.hidden = true;
      if (markRead) markRead.hidden = true;
      document.querySelectorAll(".notif-item.unread").forEach(item => {
        item.classList.remove("unread");
      });
    }

    notifButton.addEventListener("click", (e) => {
      e.stopPropagation();
      notifDropdown.hidden = !notifDropdown.hidden;
    });

    document.addEventListener("click", (e) => {
      if (!notifDropdown.contains(e.target) && e.target !== notifButton) {
        notifDropdown.hidden = true;
      }
    });

    if (markRead) {
      markRead.addEventListener("click", () => {
        document.querySelectorAll(".notif-item.unread").forEach(item => {
          item.classList.remove("unread");
        });
        if (notifBadge) notifBadge.hidden = true;
        markRead.hidden = true;
        localStorage.setItem(storageKey, String(Date.now()));
      });
    }

    // Reset notifications if a new connection is established (simulating "new upload" trigger)
    window.addEventListener("viewcast:youtube-connected", () => {
      localStorage.removeItem(storageKey);
      if (notifBadge) notifBadge.hidden = false;
      if (markRead) markRead.hidden = false;
      // In a real app, you'd fetch fresh notifications here
    });
  }
});

authInitialization.catch((error) => {
  console.error("Authentication failed to initialize.", error);
  document.body.classList.add("auth-ready");
});
