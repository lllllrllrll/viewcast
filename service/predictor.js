(function () {
  const form = document.getElementById("predictorForm");
  const videoUrlInput = document.getElementById("videoUrl");

  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = videoUrlInput.value.trim();
    if (!url) return;

    // Simulate prediction loading state
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = "Predicting...";
    submitBtn.disabled = true;

    setTimeout(() => {
      populateMockPrediction();
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }, 1500);
  });

  function populateMockPrediction() {
    // Update metric cards
    const cards = document.querySelectorAll(".metric-card");
    const mockValues = ["12K - 18K", "6.2%", "Medium", "Positive"];
    const mockTrends = ["+15%", "+0.8%", "Safe", "94%"];

    cards.forEach((card, i) => {
      const valueEl = card.querySelector(".metric-value");
      const trendEl = card.querySelector(".trend");
      if (valueEl) valueEl.textContent = mockValues[i];
      if (trendEl) trendEl.textContent = mockTrends[i];

      const sparkline = card.querySelector(".sparkline");
      if (sparkline) {
        sparkline.dataset.values = Array.from({ length: 12 }, () =>
          Math.floor(Math.random() * 40 + 60)
        ).join(",");
        if (typeof drawSparkline === "function") drawSparkline(sparkline);
      }
    });

    // Update progress bars
    const progressItems = document.querySelectorAll(".progress-item");
    const mockProgress = [
      { label: "High", value: "85%" },
      { label: "Great", value: "92%" },
      { label: "Rising", value: "78%" }
    ];

    progressItems.forEach((item, i) => {
      const span = item.querySelector("span");
      const barInner = item.querySelector(".bar i");
      if (span) span.textContent = mockProgress[i].label;
      if (barInner) barInner.style.setProperty("--value", mockProgress[i].value);
    });
  }
})();
