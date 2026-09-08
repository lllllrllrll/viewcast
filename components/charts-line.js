import {bindLineHover, drawLineHover} from "./charts-line-hover.js?v=1";
import {colors} from "./chart-colors.js?v=1";

export function scaleCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

export function drawLineChart(canvasId, actual, forecast, labels, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Store data for tooltips/resize
  canvas._chartData = { actual, forecast, labels, options };

  const { ctx, width, height } = scaleCanvas(canvas);
  const pad = { top: 18, right: 18, bottom: 34, left: 44 };

  if (width < 2 || height < 2) return;
  ctx.clearRect(0, 0, width, height);

  const hasActual = actual.some(Number.isFinite);
  const hasForecast = forecast.some(Number.isFinite);
  if ((!hasActual && !hasForecast) || !labels.length) {
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
    ctx.fillStyle = colors.muted;
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(canvas.dataset.emptyLabel || "No data for this period", width / 2, height / 2);
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
    const forecastVal = Number.isFinite(forecast[index]) ? forecast[index] : null;
    const yActual = pad.top + (1 - (actualVal - min) / (max - min)) * (height - pad.top - pad.bottom);
    const yForecast = forecastVal === null
      ? null
      : pad.top + (1 - (forecastVal - min) / (max - min)) * (height - pad.top - pad.bottom);

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

  // Small upload diamonds sit on the date axis. Multiple uploads on the same
  // sampled date share one marker and are summarized in the hover tooltip.
  (options.markers || []).forEach((marker) => {
    const point = points[marker.index];
    if (!point) return;
    point.uploads = marker.uploads || [];
    point.uploads.forEach((upload) => {
      if (!upload.thumbnail) return;
      canvas._markerImages ||= new Map();
      if (canvas._markerImages.has(upload.thumbnail)) return;
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        if (canvas._hoverPoint === point) {
          const {actual: nextActual, forecast: nextForecast, labels: nextLabels, options: nextOptions} = canvas._chartData;
          drawLineChart(canvasId, nextActual, nextForecast, nextLabels, {...nextOptions, isInternal: false});
        }
      };
      image.src = upload.thumbnail;
      canvas._markerImages.set(upload.thumbnail, image);
    });
    const markerY = height - pad.bottom + 7;
    ctx.save();
    ctx.translate(point.x, markerY);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = colors.amber;
    ctx.fillRect(-4, -4, 8, 8);
    ctx.restore();
  });

  drawLineHover({canvas, ctx, width, height, pad, options});
  bindLineHover(canvas, () => {
    const data = canvas._chartData;
    drawLineChart(canvasId, data.actual, data.forecast, data.labels, {
      ...data.options, isInternal: false
    });
  });
}
