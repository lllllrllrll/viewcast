import {colors} from "./chart-colors.js?v=1";

export function drawLineHover({canvas, ctx, width, height, pad, options}) {
  const point = canvas._hoverPoint;
  if (!point || options.isInternal) return;
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(point.x, pad.top);
  ctx.lineTo(point.x, height - pad.bottom);
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(point.x, point.yActual, 5, 0, Math.PI * 2);
  ctx.fillStyle = colors.teal;
  ctx.fill();
  ctx.strokeStyle = colors.surface;
  ctx.lineWidth = 2;
  ctx.stroke();

  const uploadCount = point.uploads?.length || 0;
  const tipW = uploadCount ? 260 : 100;
  const tipH = uploadCount ? 94 : 45;
  let tipX = point.x + 10;
  let tipY = point.yActual - tipH - 10;
  if (tipX + tipW > width) tipX = point.x - tipW - 10;
  if (tipY < 0) tipY = point.yActual + 10;
  tipX = Math.max(4, Math.min(tipX, width - tipW - 4));
  tipY = Math.max(4, Math.min(tipY, height - tipH - 4));
  ctx.fillStyle = "rgba(28, 36, 48, 0.95)";
  ctx.beginPath();
  ctx.roundRect(tipX, tipY, tipW, tipH, 6);
  ctx.fill();
  ctx.fillStyle = "white";
  ctx.font = "bold 12px Inter, sans-serif";
  ctx.fillText(point.label, tipX + 8, tipY + 18);
  ctx.font = "12px Inter, sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.fillText(`${Number(point.actualVal).toLocaleString()}${options.ySuffix ?? "K"}`, tipX + 8, tipY + 36);
  if (!uploadCount) return;
  const upload = point.uploads[0];
  const thumbnail = canvas._markerImages?.get(upload.thumbnail);
  const imageX = tipX + 8;
  const imageY = tipY + 47;
  if (thumbnail?.complete && thumbnail.naturalWidth) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(imageX, imageY, 64, 36, 4);
    ctx.clip();
    ctx.drawImage(thumbnail, imageX, imageY, 64, 36);
    ctx.restore();
  } else {
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.fillRect(imageX, imageY, 64, 36);
  }
  const limit = uploadCount > 1 ? 25 : 31;
  const title = upload.title.length > limit ? `${upload.title.slice(0, limit - 1)}…` : upload.title;
  ctx.fillStyle = "white";
  ctx.font = "600 11px Inter, sans-serif";
  ctx.fillText(title, tipX + 80, tipY + 62);
  ctx.fillStyle = colors.amber;
  ctx.font = "600 10px Inter, sans-serif";
  const more = uploadCount > 1 ? `+${uploadCount - 1} more upload${uploadCount === 2 ? "" : "s"}` : "Uploaded";
  ctx.fillText(more, tipX + 80, tipY + 79);
}

export function bindLineHover(canvas, redraw) {
  if (canvas._hasListeners) return;
  canvas.addEventListener("mousemove", (event) => {
    const mouseX = event.clientX - canvas.getBoundingClientRect().left;
    let closest = null;
    let distance = 30;
    (canvas._chartPoints || []).forEach((point) => {
      const nextDistance = Math.abs(point.x - mouseX);
      if (nextDistance < distance) {
        distance = nextDistance;
        closest = point;
      }
    });
    if (closest !== canvas._hoverPoint) {
      canvas._hoverPoint = closest;
      redraw();
    }
  });
  canvas.addEventListener("mouseleave", () => {
    canvas._hoverPoint = null;
    redraw();
  });
  canvas._hasListeners = true;
}
