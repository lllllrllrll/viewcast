(function () {
  const form = document.getElementById("videoAnalysisForm");
  const videoUrlInput = document.getElementById("videoUrl");

  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = videoUrlInput.value.trim();
    if (!url) return;

    // Simulate analysis loading state
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = "Analyzing...";
    submitBtn.disabled = true;

    setTimeout(() => {
      populateMockData();
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }, 1200);
  });

  function populateMockData() {
    // Update metric cards
    const cards = document.querySelectorAll(".metric-card");
    const mockValues = ["84/100", "14:22", "8.4%", "92%"];
    const mockTrends = ["+12%", "+4%", "-2%", "+5%"];

    cards.forEach((card, i) => {
      const valueEl = card.querySelector(".metric-value");
      const trendEl = card.querySelector(".trend");
      if (valueEl) valueEl.textContent = mockValues[i];
      if (trendEl) trendEl.textContent = mockTrends[i];

      const sparkline = card.querySelector(".sparkline");
      if (sparkline) {
        sparkline.dataset.values = Array.from({ length: 12 }, () =>
          Math.floor(Math.random() * 50 + 50)
        ).join(",");
        if (typeof drawSparkline === "function") drawSparkline(sparkline);
      }
    });

    // Update retention chart
    const actual = [100, 92, 85, 82, 78, 75, 72, 70, 68, 65, 62, 60];
    const forecast = [100, 95, 90, 88, 85, 82, 80, 78, 76, 74, 72, 70];
    const labels = ["0:00", "1:00", "2:00", "3:00", "4:00", "5:00", "6:00", "7:00", "8:00", "9:00", "10:00", "End"];

    if (typeof drawLineChart === "function") {
      drawLineChart("retentionChart", actual, forecast, labels);
    }

    // Update key moments
    const activityItems = document.querySelectorAll(".activity-item");
    const moments = [
      { title: "Hook Success", desc: "92% retention at 0:30", time: "0:30" },
      { title: "Segment Drop", desc: "Tutorial section pacing too slow", time: "4:15" },
      { title: "Peak Interest", desc: "Viewers replaying the climax", time: "8:45" }
    ];

    activityItems.forEach((item, i) => {
      if (moments[i]) {
        item.querySelector("b").textContent = moments[i].title;
        item.querySelector("span").textContent = moments[i].desc;
        item.querySelector("time").textContent = moments[i].time;
      }
    });

    // Update recommended edits table
    const tbody = document.querySelector("table tbody");
    if (tbody) {
      const rows = [
        ["0:00 - 0:45", "Hook Pacing", "Shorten intro by 5 seconds", "High"],
        ["4:15 - 5:30", "Mid-roll Drop", "Add chapters for better navigation", "Medium"],
        ["End Screen", "Low Conversion", "Move CTA 10 seconds earlier", "High"]
      ];

      tbody.innerHTML = rows.map(row => `
        <tr>
          <td>${row[0]}</td>
          <td>${row[1]}</td>
          <td>${row[2]}</td>
          <td><span class="trend ${row[3] === 'High' ? 'good' : 'warn'}">${row[3]}</span></td>
        </tr>
      `).join("");
    }
  }
})();
