(function () {
  const paymentsAvailable = false;
  const paymentsUnavailableMessage = "Paid plans are coming soon. Your Basic plan remains active and no payment will be attempted.";
  const modalHtml = `
    <div class="modal-overlay" id="planModal" hidden>
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="planModalTitle" aria-describedby="modalStatus" tabindex="-1">
        <div class="modal-header">
          <h3 id="planModalTitle">Upgrade Your Plan</h3>
          <button class="close-button" id="closeModal" aria-label="Close modal">&times;</button>
        </div>
        <div class="plans-grid">
          <div class="plan-card" data-plan-card="basic">
            <div class="plan-badge">Current</div>
            <h4>Basic</h4>
            <div class="plan-price">$0<span>/mo</span></div>
            <ul>
              <li>Unlimited feature access</li>
              <li>Link 1 YouTube channel</li>
              <li>Swap channels anytime</li>
              <li>Community support</li>
            </ul>
            <button class="primary-button plan-choice-button" data-plan-choice="basic">Active Plan</button>
          </div>
          <div class="plan-card" data-plan-card="pro">
            <div class="plan-badge">Popular</div>
            <h4>Pro</h4>
            <div class="plan-price">$29<span>/mo</span></div>
            <ul>
              <li><strong>Everything in Basic</strong></li>
              <li>Unlimited video analysis</li>
              <li>Link up to 5 YouTube channels</li>
              <li>Advanced retention heatmaps</li>
              <li>Custom alert rules</li>
              <li>AI prediction (50/mo)</li>
            </ul>
            <button class="primary-button plan-choice-button" data-plan-choice="pro">Upgrade to Pro</button>
          </div>
          <div class="plan-card" data-plan-card="premium">
            <div class="plan-badge"></div>
            <h4>Premium</h4>
            <div class="plan-price">$99<span>/mo</span></div>
            <ul>
              <li><strong>Everything in Pro</strong></li>
              <li>Manage up to 5 channels</li>
              <li>Team collaboration tools</li>
              <li>API access for reporting</li>
              <li>Priority AI support</li>
            </ul>
            <button class="primary-button plan-choice-button" data-plan-choice="premium">Choose Premium</button>
          </div>
        </div>
        <p class="modal-status-message" id="modalStatus" hidden></p>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const modal = document.getElementById("planModal");
  const closeBtn = document.getElementById("closeModal");
  const statusEl = document.getElementById("modalStatus");
  const planCards = document.querySelectorAll("[data-plan-card]");
  const dialog = modal.querySelector("[role='dialog']");
  let previouslyFocused = null;

  function getPlan() {
    // Paid entitlements must come from a trusted billing backend. Ignore and
    // remove legacy client-selected values so localStorage cannot grant access.
    localStorage.removeItem("viewcast:plan");
    return "basic";
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
        badge.hidden = !badge.textContent;
      }

      const btn = card.querySelector("[data-plan-choice]");
      if (btn) {
        const isPaidPlan = planKey !== "basic";
        const isUnavailable = isPaidPlan && !paymentsAvailable;
        btn.disabled = isCurrent || isUnavailable;
        btn.textContent = isCurrent ? "Active Plan" : isUnavailable ? "Coming Soon" : planKey === "pro" ? "Upgrade to Pro" : "Choose Premium";
        if (isUnavailable) {
          btn.title = "Secure checkout is not available yet";
          btn.setAttribute("aria-label", `${planKey === "pro" ? "Pro" : "Premium"} plan — coming soon`);
        } else {
          btn.removeAttribute("title");
          btn.removeAttribute("aria-label");
        }
        btn.classList.toggle("is-current-plan", isCurrent);
        btn.classList.toggle("is-unavailable-plan", isUnavailable && !isCurrent);
      }
    });
  }

  window.showPlanModal = function (message) {
    const statusMessage = message || (!paymentsAvailable ? paymentsUnavailableMessage : "");
    if (statusMessage) {
      statusEl.textContent = statusMessage;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
    previouslyFocused = document.activeElement;
    modal.hidden = false;
    updateDisplay();
    closeBtn.focus();
  };

  function closePlanModal() {
    modal.hidden = true;
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    previouslyFocused = null;
  }

  function focusableControls() {
    return [...dialog.querySelectorAll("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")];
  }

  closeBtn.addEventListener("click", closePlanModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closePlanModal();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePlanModal();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = focusableControls();
    if (!controls.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.querySelectorAll("[data-plan-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.planChoice === "basic") return;
      statusEl.textContent = paymentsUnavailableMessage;
      statusEl.hidden = false;
    });
  });

  updateDisplay();
})();
