self.window = { location: self.location };
importScripts(
  "worker_dom.js",
  "../utils.js",
  "../computation_graph.js",
  "../damage_calc.js",
  "../display.js",
  "../build_utils.js",
  "../powders.js",
  "../skillpoints.js",
  "../builder/build.js",
  "../defense_stats.js",
  "../builder/builder_constants.js",
  "../builder/atree.js",
  "../builder/aspects.js",
  "../builder/builder_graph.js",
  "model.js",
  "final_stats.js",
  "search.js",
);
// Native Build's data dependency. The page sends its currently loaded version.
let sets = new Map();
let MAJOR_IDS = {}, player_build;
COMPUTE_GRAPH_DEBUG = false;
self.onmessage = ({ data }) => {
  try {
    sets = new Map(data.sets);
    const context = data.config.finalContext;
    if (context) {
      MAJOR_IDS = context.majorIds;
      workerElements.clear();
      for (const [id, value] of Object.entries(context.elements)) workerElements.set(id, workerElement(value));
      armor_powder_node.value = armor_powder_node.compute_func(new Map());
      boosts_node.value = boosts_node.compute_func(new Map());
      powder_special_input.value = context.powders;
    }
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
