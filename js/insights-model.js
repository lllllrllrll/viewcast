import {setCreatorContext} from "./services/insights-creator-context.js?v=1";

export * from "./modules/insights-topic-language.js?v=1";
export * from "./modules/insights-performance.js?v=1";
export * from "./modules/insights-trend-selection.js?v=1";
export * from "./modules/insights-lane.js?v=1";
export * from "./modules/insights-fetch.js?v=1";
export * from "./modules/insights-signals.js?v=1";
export * from "./modules/insights-suggestions.js?v=1";
export * from "./modules/insights-summary.js?v=1";

export function setInsightsCreatorContext(value = {}) {
  setCreatorContext(value);
}
