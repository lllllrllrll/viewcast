(function () {
  const modalHtml = `
    <div class="modal-overlay" id="planModal" hidden>
      <div class="modal-card">
        <div class="modal-header">
          <h3>Upgrade Your Plan</h3>
          <button class="close-button" id="closeModal" aria-label="Close modal">&times;</button>
        </div>
        <div class="plans-grid">
          <div class="plan-card" data-plan-card="basic">
            <div class="plan-badge">Current</div>
            <h4>Basic</h4>
            <div class="plan-price">$0<span>/mo</span></div>
            <ul>
              <li>5 Video analyses / day</li>
              <li>Basic channel tracking</li>
              <li>1 Channel connection</li>
              <li>Community support</li>
            </ul>
            <button class="primary-button" data-plan-choice="basic" style="width: 100%;">Active Plan</button>
          </div>
          <div class="plan-card" data-plan-card="pro">
            <div class="plan-badge">Popular</div>
            <h4>Pro</h4>
            <div class="plan-price">$29<span>/mo</span></div>
            <ul>
              <li><strong>Everything in Basic</strong></li>
              <li>Unlimited video analysis</li>
              <li>Advanced retention heatmaps</li>
              <li>Custom alert rules</li>
              <li>AI prediction (50/mo)</li>
            </ul>
            <button class="primary-button" data-plan-choice="pro" style="width: 100%;">Upgrade to Pro</button>
          </div>
          <div class="plan-card" data-plan-card="premium">
            <div class="plan-badge"></div>
            <h4>Premium</h4>
            <div class="plan-price">$99<span>/mo</span></div>
            <ul>
              <li><strong>Everything in Pro</strong></li>
              <li>Manage up to 10 channels</li>
              <li>Team collaboration tools</li>
              <li>API access for reporting</li>
              <li>Priority AI support</li>
            </ul>
            <button class="primary-button" data-plan-choice="premium" style="width: 100%;">Choose Premium</button>
          </div>
        </div>
        <p id="modalStatus" style="text-align: center; padding: 0 32px 24px; color: var(--rose); font-size: 13px; font-weight: 600;" hidden></p>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const modal = document.getElementById("planModal");
  const closeBtn = document.getElementById("closeModal");
  const statusEl = document.getElementById("modalStatus");
  const planCards = document.querySelectorAll("[data-plan-card]");

  function getPlan() {
    return localStorage.getItem("viewcast:plan") || "basic";
  }

  function setPlan(plan) {
    const oldPlan = localStorage.getItem("viewcast:plan");
    localStorage.setItem("viewcast:plan", plan);

    // Dispatch event for same-window listeners (like settings.js)
    window.dispatchEvent(new StorageEvent("storage", {
      key: "viewcast:plan",
      oldValue: oldPlan,
      newValue: plan,
      storageArea: localStorage
    }));

    updateDisplay();
  }

  function updateDisplay() {
    const currentPlan = getPlan();
    planCards.forEach((card) => {
      const planKey = card.dataset.planCard;
      const isCurrent = planKey === currentPlan;
      card.classList.toggle("current", isCurrent);

      const badge = card.querySelector(".plan-badge");
      if (badge) {
        badge.textContent = isCurrent ? "Current" : planKey === "pro" ? "Popular" : "";
        badge.style.display = badge.textContent ? "block" : "none";
      }

      const btn = card.querySelector("[data-plan-choice]");
      if (btn) {
        btn.disabled = isCurrent;
        btn.textContent = isCurrent ? "Active Plan" : planKey === "basic" ? "Switch to Basic" : planKey === "pro" ? "Upgrade to Pro" : "Choose Premium";
        if (isCurrent) {
          btn.style.background = "var(--line)";
          btn.style.color = "var(--muted)";
        } else {
          btn.style.background = "var(--teal)";
          btn.style.color = "white";
        }
      }
    });
  }

  window.showPlanModal = function (message) {
    if (message) {
      statusEl.textContent = message;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
    modal.hidden = false;
    updateDisplay();
  };

  closeBtn.addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });

  document.querySelectorAll("[data-plan-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setPlan(btn.dataset.planChoice);
      setTimeout(() => (modal.hidden = true), 600);
    });
  });

  updateDisplay();
})();
