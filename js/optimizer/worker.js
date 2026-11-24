self.window = { location: self.location };
importScripts(
  "../utils.js",
  "../build_utils.js",
  "../powders.js",
  "../skillpoints.js",
  "../builder/build.js",
  "../defense_stats.js",
  "model.js",
  "search.js",
);
// Native Build's data dependency. The page sends its currently loaded version.
let sets = new Map();
self.onmessage = ({ data }) => {
  try {
    sets = new Map(data.sets);
    const pools = data.pools.map((pool) =>
      pool.map((entry) => ({
        ...entry,
        item: OptimizerModel.fromMap(entry.map),
      })),
    );
    const tomes = data.tomes.map(OptimizerModel.fromMap);
    const result = OptimizerSearch.search(
      pools,
      tomes,
      data.config,
      (progress) => self.postMessage({ progress }),
    );
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
