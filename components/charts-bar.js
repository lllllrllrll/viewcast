import {scaleCanvas} from "./charts-line.js?v=1";
import {colors} from "./chart-colors.js?v=1";

export function drawBarChart(canvasId, data, maxVal = 80) {
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
