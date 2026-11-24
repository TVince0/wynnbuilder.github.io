/* Continuous population search. Native calculations validate every returned build. */
const OptimizerFast = (() => {
  async function search(pools, tomes, config, progress, inbox = [], shouldStop = () => false) {
    const compare = OptimizerSearch.createComparator(config);
    const ranks = [config.objective, ...(config.secondary || []).map(rank => rank.stat)];
    const requested = new Set([...ranks, ...(config.rules || []).map(rule => rule.stat)]);
    const limit = config.limit || 10;
    const start = performance.now();
    const total = pools.reduce((product, pool) => product * BigInt(pool.length), 1n);
    const maps = pools.map(pool => new Map(pool.map((entry, index) => [entry.key, index])));
    const mutable = pools.map((pool, index) => pool.length > 1 ? index : -1).filter(index => index >= 0);
    const guild = tomes.find(item => item.statMap.get('type') === 'guildTome');
    const budget = levelToSkillPoints(config.level);
    const population = [], best = [], seen = new Set();
    let attempts = 0, evaluated = 0, matched = 0;
    let randomState = (config.seed ?? Date.now()) >>> 0 || 1;
    const random = () => {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return (randomState >>> 0) / 4294967296;
    };
    const pick = values => values[Math.floor(random() * values.length)];
    const compareStates = (a, b) => a.violation - b.violation || (a.stats && b.stats ? compare(a, b) : 0);
    function evaluate(indices) {
      attempts++;
      const choices = indices.map((index, slot) => pools[slot][index]);
      if (!config.duplicateRings && choices[4].key === choices[5].key) return;
      const identity = choices.map(choice => choice.key);
      if (config.ringSymmetric && identity[4] > identity[5]) [identity[4], identity[5]] = [identity[5], identity[4]];
      const signature = JSON.stringify(identity);
      if (seen.has(signature)) return;
      if (seen.size >= 25000) seen.clear();
      seen.add(signature);
      const equipment = choices.slice(0, 8).map(choice => choice.item);
      const weapon = choices[8].item;
      // Only reject complete allocations. Infeasible states remain available for repair.
      const allocation = calculate_skillpoints(equipment.concat(guild ? [guild] : []).map(item => item.statMap), weapon.statMap);
      const skillViolation = Math.max(0, allocation[3] - budget)
        + allocation[1].reduce((sum, value) => sum + Math.max(0, value - 100), 0);
      let violation = skillViolation ? 1 + skillViolation / Math.max(1, budget) : 0;
      let stats;
      if (!skillViolation) {
        const build = OptimizerModel.assemble(config.level, equipment, tomes, weapon);
        if (!OptimizerModel.valid(build, config.characterClass)) return;
        evaluated++;
        stats = config.finalContext ? OptimizerFinal.measurements(build, config.finalContext, requested) : OptimizerModel.measurements(build);
        if (ranks.some(key => !Number.isFinite(stats[key]))) return;
        for (const rule of config.rules || []) {
          const value = stats[rule.stat];
          if (!Number.isFinite(value)) return;
          if (rule.min != null) violation += Math.max(0, rule.min - value) / Math.max(1, Math.abs(rule.min));
          if (rule.max != null) violation += Math.max(0, value - rule.max) / Math.max(1, Math.abs(rule.max));
        }
        if (violation === 0) {
          matched++;
          if (!best.some(result => result.signature === signature)) {
            best.push({signature, score: stats[config.objective], stats,
              assigned: build.base_skillpoints, totals: build.total_skillpoints,
              pieces: choices.map(choice => ({key: choice.key, pinned: !!choice.pinned, name: choice.item.statMap.get('displayName')}))});
            best.sort(compare);
            best.length = Math.min(limit, best.length);
          }
        }
      }
      population.push({indices, violation, stats});
      population.sort(compareStates);
      // Preserve a separate exploratory reservoir alongside the strongest states.
      if (population.length > 80) population.splice(random() < .8 ? 64 : 32 + Math.floor(random() * 32), 1);
    }
    const randomIndices = () => pools.map(pool => Math.floor(random() * pool.length));
    const fromPieces = pieces => pieces.map((piece, slot) => maps[slot].get(piece.key));
    function importBuild(pieces) {
      const indices = fromPieces(pieces);
      if (indices.every(index => index !== undefined)) evaluate(indices);
    }
    if (config.initial?.length === pools.length) importBuild(config.initial.map(key => ({key})));
    let nextReport = start;
    while (!shouldStop()) {
      const sliceEnd = performance.now() + 25;
      while (inbox.length && performance.now() < sliceEnd) importBuild(inbox.shift().pieces);
      do {
        let indices;
        if (population.length < 16 || random() < .18) indices = randomIndices();
        else {
          const parent = pick(population);
          indices = parent.indices.slice();
          if (random() < .25) {
            const other = pick(population);
            for (const slot of mutable) if (random() < .5) indices[slot] = other.indices[slot];
          }
          // Multi-piece moves can cross skill and set dependencies.
          const roll = random();
          const changes = roll < .6 ? 1 : roll < .9 ? 2 : 4;
          for (let i = 0; i < changes && mutable.length; i++) {
            const slot = pick(mutable);
            indices[slot] = Math.floor(random() * pools[slot].length);
          }
        }
        evaluate(indices);
      } while (performance.now() < sliceEnd);
      const now = performance.now();
      if (now >= nextReport) {
        progress?.({builds: best.slice(), examined: String(attempts), evaluated, matched: String(matched), total: String(total), elapsed: (now - start) / 1000, fast: true});
        nextReport = now + 250;
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return {builds: best, examined: String(attempts), evaluated, matched: String(matched), total: String(total), fast: true, complete: false};
  }
  return {search};
})();
