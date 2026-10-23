import { collectIndices } from "./collectors.ts";
import { collectQuotes } from "./quote-collectors.ts";
import { collectCredit } from "./credit-collectors.ts";
import { collectFunding } from "./funding-collectors.ts";
import { collectNebius } from "./nebius-collectors.ts";
import { mergeSnapshot, validatePatch, validateReferences } from "./metrics.ts";
async function collectDaily(old, options = {}) {
  const results = [];
  let current = old;
  let patch = {};
  let accumulated = { sources: [], series: [], quotes: [], deals: [], bonds: [], events: [], history: [], treasury: [] };
  const groups = [
    ["gpu", async (snapshot) => {
      const value = await collectIndices(snapshot);
      return { patch: { series: value.series }, results: value.results };
    }],
    ["quotes_tpu", (snapshot) => collectQuotes(snapshot, options)],
    ["nebius_spot", (snapshot) => collectNebius(snapshot, options)],
    ["credit", (snapshot) => collectCredit(snapshot, options)],
    ["funding", (snapshot) => collectFunding(snapshot, options)]
  ];
  for (const [dataset, collect] of groups) {
    try {
      const result = await collect(current);
      const issue = validatePatch(result.patch) || validateReferences(mergeSnapshot(current, result.patch));
      if (issue) throw new Error(`\u6570\u636E\u6821\u9A8C\u672A\u901A\u8FC7\uFF1A${issue}`);
      current = mergeSnapshot(current, result.patch);
      accumulated = mergeSnapshot(accumulated, result.patch);
      for (const key of Object.keys(result.patch)) {
        if (key !== "schedule") patch[key] = accumulated[key];
      }
      results.push(...result.results.map((row) => ({ ...row, dataset })));
    } catch (error) {
      results.push({ source: dataset, dataset, status: "error", detail: error instanceof Error ? error.message : "\u91C7\u96C6\u5931\u8D25\uFF0C\u4FDD\u7559\u539F\u8BB0\u5F55" });
    }
  }
  return { patch, results };
}
export {
  collectDaily
};
