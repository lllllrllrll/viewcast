const colors = {
  ink: "#1c2430",
  muted: "#667085",
  line: "#d8e0ea",
  teal: "#0f8b8d",
  blue: "#3267d6",
  amber: "#c47f13",
  rose: "#d04d67",
  green: "#2f9b6c"
};

document.body.classList.toggle(
  "settings-dark",
  localStorage.getItem("viewcastDarkMode") === "on"
);

function scaleCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawSparkline(canvas) {
  const { ctx, width, height } = scaleCanvas(canvas);
  const values = (canvas.dataset.values || "")
    .split(",")
    .map(Number)
    .filter(Number.isFinite);

  ctx.clearRect(0, 0, width, height);
  if (values.length < 2) {
    if (canvas.dataset.emptyGraph === "true") {
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i += 1) {
        const y = (i / 4) * height;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 3;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = pad + (index / (values.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / (max - min || 1)) * (height - pad * 2);
    index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = colors.teal;
  ctx.stroke();
}

function drawLineChart(canvasId, actual, forecast, labels, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Store data for tooltips/resize
  canvas._chartData = { actual, forecast, labels, options };

  const { ctx, width, height } = scaleCanvas(canvas);
  const pad = { top: 18, right: 18, bottom: 34, left: 44 };

  if (width < 2 || height < 2) return;
  ctx.clearRect(0, 0, width, height);

  if (!actual.length || !forecast.length || !labels.length) {
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i += 1) {
      const y = pad.top + (i / 4) * (height - pad.top - pad.bottom);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
    }
    for (let i = 0; i < 6; i += 1) {
      const x = pad.left + (i / 5) * (width - pad.left - pad.right);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, height - pad.bottom);
      ctx.stroke();
    }
    return;
  }

  const all = actual.concat(forecast).filter(Number.isFinite);
  if (all.length < 2) return;
  const min = 0;
  const trueMax = Math.max(...all);

  // Calculate a "nice" step that results in whole numbers on the 5 grid lines
  let niceStep = Math.ceil((trueMax * 1.1) / 4);
  if (niceStep < 1) niceStep = 1;

  // For larger numbers, round the step to a "clean" number (multiple of 1, 2, 5, or 10)
  if (niceStep > 5) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(niceStep)));
    const normalized = niceStep / magnitude;
    let rounded;
    if (normalized <= 1.5) rounded = 1;
    else if (normalized <= 3) rounded = 2;
    else if (normalized <= 7) rounded = 5;
    else rounded = 10;
    niceStep = rounded * magnitude;
  }

  const max = niceStep * 4;

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.fillStyle = colors.muted;

  for (let i = 0; i < 5; i += 1) {
    const y = pad.top + (i / 4) * (height - pad.top - pad.bottom);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();

    const tick = niceStep * (4 - i);
    ctx.fillText(`${tick}${options.ySuffix ?? "K"}`, 4, y + 4);
  }

  const points = [];
  labels.forEach((label, index) => {
    const denominator = Math.max(1, labels.length - 1);
    const x = pad.left + (index / denominator) * (width - pad.left - pad.right);
    ctx.fillText(label, x - 10, height - 10);

    // Calculate point positions for tooltip
    const actualVal = actual[index];
    const forecastVal = forecast[index];
    const yActual = pad.top + (1 - (actualVal - min) / (max - min)) * (height - pad.top - pad.bottom);
    const yForecast = pad.top + (1 - (forecastVal - min) / (max - min)) * (height - pad.top - pad.bottom);

    points.push({ x, yActual, yForecast, actualVal, forecastVal, label });
  });
  canvas._chartPoints = points;

  function plot(data, color, dashed) {
    if (data.length < 2) return;
    ctx.beginPath();
    if (dashed) ctx.setLineDash([7, 6]);
    const denominator = Math.max(1, data.length - 1);
    data.forEach((value, index) => {
      const x = pad.left + (index / denominator) * (width - pad.left - pad.right);
      const y = pad.top + (1 - (value - min) / (max - min)) * (height - pad.top - pad.bottom);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  plot(forecast, colors.amber, true);
  plot(actual, colors.teal, false);

  // Hover state handling
  if (canvas._hoverPoint && !options.isInternal) {
    const p = canvas._hoverPoint;

    // Vertical line
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(p.x, pad.top);
    ctx.lineTo(p.x, height - pad.bottom);
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Actual point dot
    ctx.beginPath();
    ctx.arc(p.x, p.yActual, 5, 0, Math.PI * 2);
    ctx.fillStyle = colors.teal;
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Tooltip box
    const tipW = 100;
    const tipH = 45;
    let tipX = p.x + 10;
    let tipY = p.yActual - tipH - 10;

    if (tipX + tipW > width) tipX = p.x - tipW - 10;
    if (tipY < 0) tipY = p.yActual + 10;

    ctx.fillStyle = "rgba(28, 36, 48, 0.95)";
    ctx.beginPath();
    ctx.roundRect(tipX, tipY, tipW, tipH, 6);
    ctx.fill();

    ctx.fillStyle = "white";
    ctx.font = "bold 12px Inter, sans-serif";
    ctx.fillText(p.label, tipX + 8, tipY + 18);
    ctx.font = "12px Inter, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    const valText = Number(p.actualVal).toLocaleString() + (options.ySuffix ?? "K");
    ctx.fillText(valText, tipX + 8, tipY + 36);
  }

  // Attach event listeners once
  if (!canvas._hasListeners) {
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      let closest = null;
      let minDist = 30; // Threshold for snapping

      (canvas._chartPoints || []).forEach(p => {
        const dist = Math.abs(p.x - mx);
        if (dist < minDist) {
          minDist = dist;
          closest = p;
        }
      });

      if (closest !== canvas._hoverPoint) {
        canvas._hoverPoint = closest;
        const { actual, forecast, labels, options } = canvas._chartData;
        drawLineChart(canvasId, actual, forecast, labels, { ...options, isInternal: false });
      }
    });

    canvas.addEventListener("mouseleave", () => {
      canvas._hoverPoint = null;
      const { actual, forecast, labels, options } = canvas._chartData;
      drawLineChart(canvasId, actual, forecast, labels, { ...options, isInternal: false });
    });

    canvas._hasListeners = true;
  }
}


function drawBarChart(canvasId, data, maxVal = 80) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const { ctx, width, height } = scaleCanvas(canvas);
  const pad = { top: 28, right: 16, bottom: 38, left: 44 };

  function drawGrid() {
    const plotHeight = height - pad.top - pad.bottom;
    ctx.strokeStyle = colors.line;
    ctx.fillStyle = colors.muted;
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= 4; i += 1) {
      const tickValue = Math.round(maxVal - (i / 4) * maxVal);
      const y = pad.top + (i / 4) * plotHeight;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
      ctx.fillText(String(tickValue), pad.left - 8, y);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  ctx.clearRect(0, 0, width, height);
  drawGrid();

  if (!data.length) {
    return;
  }

  const plotHeight = height - pad.top - pad.bottom;
  const gap = 14;
  const barWidth = (width - pad.left - pad.right - gap * (data.length - 1)) / data.length;

  data.forEach(([label, value, color, displayValue], index) => {
    const x = pad.left + index * (barWidth + gap);
    const safeValue = Math.max(0, Math.min(maxVal, value));
    const barHeight = (safeValue / maxVal) * plotHeight;
    const y = pad.top + plotHeight - barHeight;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, barWidth, barHeight, 7);
    ctx.fill();
    ctx.fillStyle = colors.ink;
    ctx.textAlign = "center";
    ctx.font = "700 12px Inter, system-ui, sans-serif";
    ctx.fillText(displayValue || String(value), x + barWidth / 2, Math.max(13, y - 8));
    ctx.fillStyle = colors.muted;
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(label, x + barWidth / 2, height - 12);
  });
  ctx.textAlign = "left";
}

function initCharts() {
  document.querySelectorAll(".sparkline").forEach(drawSparkline);

  if (document.getElementById("viewsChart")) {
    drawLineChart("viewsChart", [], [], []);
  }
}

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

window.addEventListener("resize", initCharts);
document.addEventListener("DOMContentLoaded", () => {
  initCharts();
  hideEmptyPrimaryButtons();

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

const authModuleUrl = new URL("auth.js?v=14", document.currentScript.src);
import(authModuleUrl.href).catch((error) => {
  console.error("Authentication failed to initialize.", error);
  document.body.classList.add("auth-ready");
});
