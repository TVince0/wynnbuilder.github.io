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
  "fast_search.js",
);
// Native Build's data dependency. The page sends its currently loaded version.
let sets = new Map();
let MAJOR_IDS = {},
  player_build;
COMPUTE_GRAPH_DEBUG = false;
function prepareOptimizerRequest(data) {
  sets = new Map(data.sets);
  const context = data.config.finalContext;
  if (context) {
    MAJOR_IDS = context.majorIds;
    workerElements.clear();
    for (const [id, value] of Object.entries(context.elements))
      workerElements.set(id, workerElement(value));
    armor_powder_node.value = armor_powder_node.compute_func(new Map());
    boosts_node.value = boosts_node.compute_func(new Map());
    powder_special_input.value = context.powders;
  }
  const pools = data.pools.map((pool) =>
    pool.filter(entry=>!data.config.excludeCrafted||(!entry.map.get('crafted')&&entry.map.get('tier')!=='Crafted')).map((entry) => ({
      ...entry,
      item: OptimizerModel.fromMap(entry.map),
    })),
  );
  if(pools.some(pool=>!pool.length))throw Error('No eligible items remain after excluding crafted gear.');
  const tomes = data.tomes.map(OptimizerModel.fromMap).filter(item=>!data.config.excludeGuildTome||item.statMap.get('type')!=='guildTome');
  return { pools, tomes, config: data.config };
}
const migrants = [];
self.onmessage = async ({ data }) => {
  if (data.type === "migrate") {
    migrants.push(...data.builds);
    return;
  }
  try {
    const { pools, tomes } = prepareOptimizerRequest(data);
    const search =
      data.config.strategy === "fast"
        ? OptimizerFast.search
        : OptimizerSearch.search;
    const result = await search(
      pools,
      tomes,
      data.config,
      (progress) => self.postMessage({ progress }),
      migrants,
    );
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
