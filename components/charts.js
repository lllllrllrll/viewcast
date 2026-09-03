import {drawBarChart} from "./charts-bar.js?v=1";
import {drawLineChart} from "./charts-line.js?v=1";

window.drawBarChart = drawBarChart;
window.drawLineChart = drawLineChart;

function initCharts() {
  if (document.getElementById("viewsChart")) {
    drawLineChart("viewsChart", [], [], []);
  }
}

function redrawThemedCharts() {
  document.querySelectorAll("canvas").forEach((canvas) => {
    if (!canvas.id || !canvas._chartData) return;
    const {actual, forecast, labels, options} = canvas._chartData;
    drawLineChart(canvas.id, actual, forecast, labels, options);
  });
}
