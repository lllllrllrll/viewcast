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
  const { ctx, width, height } = scaleCanvas(canvas);
  const pad = { top: 18, right: 18, bottom: 34, left: 44 };

  if (width < 2 || height < 2) return;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;

  if (!actual.length || !forecast.length || !labels.length) {
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
  const min = Math.min(...all) - 8;
  const max = Math.max(...all) + 10;

  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.fillStyle = colors.muted;

  for (let i = 0; i < 5; i += 1) {
    const y = pad.top + (i / 4) * (height - pad.top - pad.bottom);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    const tick = Math.round(max - (i / 4) * (max - min));
    ctx.fillText(`${tick}${options.ySuffix ?? "K"}`, 4, y + 4);
  }

  labels.forEach((label, index) => {
    const denominator = Math.max(1, labels.length - 1);
    const x = pad.left + (index / denominator) * (width - pad.left - pad.right);
    ctx.fillText(label, x - 10, height - 10);
  });

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
}

function drawBarChart(canvasId, data, maxVal = 80) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const { ctx, width, height } = scaleCanvas(canvas);
  if (!data.length) {
    ctx.clearRect(0, 0, width, height);
    return;
  }

  const pad = { top: 18, right: 12, bottom: 36, left: 34 };
  const plotHeight = height - pad.top - pad.bottom;
  const gap = 14;
  const barWidth = (width - pad.left - pad.right - gap * (data.length - 1)) / data.length;

  ctx.clearRect(0, 0, width, height);
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.strokeStyle = colors.line;
  ctx.fillStyle = colors.muted;

  for (let i = 0; i < 4; i += 1) {
    const y = pad.top + (i / 3) * plotHeight;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  data.forEach(([label, value, color], index) => {
    const x = pad.left + index * (barWidth + gap);
    const barHeight = (value / maxVal) * plotHeight;
    const y = pad.top + plotHeight - barHeight;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, barWidth, barHeight, 7);
    ctx.fill();
    ctx.fillStyle = colors.muted;
    ctx.fillText(label, x + Math.max(0, barWidth / 2 - 16), height - 12);
  });
}

function initCharts() {
  document.querySelectorAll(".sparkline").forEach(drawSparkline);

  if (document.getElementById("viewsChart")) {
    drawLineChart("viewsChart", [], [], []);
  }

  if (document.getElementById("mixChart")) {
    drawBarChart("mixChart", []);
  }
}

window.addEventListener("resize", initCharts);
document.addEventListener("DOMContentLoaded", initCharts);

import("./auth.js").catch((error) => {
  console.error("Authentication failed to initialize.", error);
  document.body.classList.add("auth-ready");
});
