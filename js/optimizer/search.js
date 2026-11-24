/**
 * Exact top-K search. Bounds only reject branches proven unable to qualify.
 * Skill support from every unselected armour slot is included before pruning.
 */
const OptimizerSearch = (() => {
  function search(pools, tomes, config, progress) {
    const limit = config.limit || 10;
    const direction = config.direction === "min" ? -1 : 1;
    const rankings = [{stat: config.objective, direction: config.direction}, ...(config.secondary || [])];
    const compare = (a, b) => {
      for (const rank of rankings) {
        const difference = (rank.direction === "min" ? 1 : -1) * (a.stats[rank.stat] - b.stats[rank.stat]);
        if (difference) return difference;
      }
      return 0;
    };
    const rules = config.rules || [];
    const metrics = new Set([
      ...rankings.map(rank => rank.stat),
      ...rules.map((rule) => rule.stat),
    ]);
    const measure = build => config.finalContext ? OptimizerFinal.measurements(build, config.finalContext) : OptimizerModel.measurements(build);
    const tracked = new Set();
    for (const metric of metrics) {
      if (metric === "health") {
        tracked.add("hp");
        tracked.add("hpBonus");
      } else if (metric === "regen" || metric === "ehpr") {
        tracked.add("hprRaw");
        tracked.add("hprPct");
      } else if (metric === "manaRegen") tracked.add("mr");
      else if (
        ![
          "ehp",
          "assigned",
          "maxManaTotal",
          ...skp_order,
          ...skp_order.map((k) => "final" + k),
        ].includes(metric)
      )
        tracked.add(metric);
    }
    const keys = [...tracked];
    const totals = keys.map((key) =>
      tomes.reduce(
        (sum, item) =>
          sum +
          (item.statMap.get("maxRolls").get(key) ?? item.statMap.get(key) ?? 0),
        0,
      ),
    );
    const lowTotals = totals.slice(),
      highTotals = totals.slice();
    const setShares = new Map();
    for (const [name, definition] of sets) {
      const low = keys.map(() => 0),
        high = keys.map(() => 0);
      for (let n = 1; n <= 9; n++) {
        const tier =
          definition.bonuses[Math.min(n, definition.bonuses.length) - 1] || {};
        for (let k = 0; k < keys.length; k++) {
          const share = (tier[keys[k]] || 0) / n;
          low[k] = Math.min(low[k], Math.floor(share));
          high[k] = Math.max(high[k], Math.ceil(share));
        }
      }
      setShares.set(name, { low, high });
    }
    const choices = pools.map((pool, position) =>
      pool.map((source) => {
        const stat = source.item.statMap;
        const values = keys.map(
          (key) => stat.get("maxRolls").get(key) ?? stat.get(key) ?? 0,
        );
        const share = setShares.get(stat.get("set"));
        return {
          ...source,
          position,
          values,
          low: values.map((value, k) => value + (share?.low[k] || 0)),
          high: values.map((value, k) => value + (share?.high[k] || 0)),
          bonus: stat.get("skillpoints") || [0, 0, 0, 0, 0],
          needs: stat.get("reqs") || [0, 0, 0, 0, 0],
          supports: position !== 8 && !stat.get("crafted"),
        };
      }),
    );
    if (choices.some((pool) => pool.length === 0))
      return { builds: [], examined: "0", total: "0", matched: "0" };
    const index = (key) => keys.indexOf(key);
    const val = (row, key) => (index(key) < 0 ? 0 : row[index(key)]);
    function bounds(metric, lo, hi) {
      if (config.finalContext) return [-Infinity, Infinity];
      if (metric === "health") {
        const base = levelToHPBase(config.level);
        return [
          Math.max(5, base + val(lo, "hp") + val(lo, "hpBonus")),
          Math.max(5, base + val(hi, "hp") + val(hi, "hpBonus")),
        ];
      }
      if (metric === "regen") {
        const raw = [val(lo, "hprRaw"), val(hi, "hprRaw")];
        if (raw[0] < 0 && raw[1] > 0) raw.push(0);
        const pct = [val(lo, "hprPct"), val(hi, "hprPct")];
        const values = raw.flatMap((r) => pct.map((p) => rawToPct(r, p / 100)));
        return [Math.min(...values), Math.max(...values)];
      }
      if (metric === "manaRegen")
        return [val(lo, "mr") + 25, val(hi, "mr") + 25];
      if (metric === "ehp" || metric === "maxManaTotal") return [0, Infinity];
      if (
        metric === "ehpr" ||
        skp_order.includes(metric) ||
        metric.startsWith("final")
      )
        return [-Infinity, Infinity];
      if (metric === "assigned") return [0, levelToSkillPoints(config.level)];
      return [val(lo, metric), val(hi, metric)];
    }
    function scoreOrder(choice) {
      const [lo, hi] = bounds(config.objective, choice.low, choice.high);
      const score = direction > 0 ? hi : lo;
      return Number.isFinite(score) ? score : 0;
    }
    for (const pool of choices)
      pool.sort((a, b) => direction * (scoreOrder(b) - scoreOrder(a)));
    const count = choices.length;
    const remainingLow = Array.from({ length: count + 1 }, () =>
      keys.map(() => 0),
    );
    const remainingHigh = remainingLow.map((row) => row.slice());
    const supportHigh = Array.from({ length: count + 1 }, () => [
      0, 0, 0, 0, 0,
    ]);
    const suffix = Array(count + 1).fill(1n);
    for (let depth = count - 1; depth >= 0; depth--) {
      const pool = choices[depth];
      suffix[depth] = suffix[depth + 1] * BigInt(pool.length);
      for (let k = 0; k < keys.length; k++) {
        let low = Infinity,
          high = -Infinity;
        for (const choice of pool) {
          low = Math.min(low, choice.low[k]);
          high = Math.max(high, choice.high[k]);
        }
        remainingLow[depth][k] = low + remainingLow[depth + 1][k];
        remainingHigh[depth][k] = high + remainingHigh[depth + 1][k];
      }
      for (let k = 0; k < 5; k++) {
        let best = -Infinity;
        for (const choice of pool)
          best = Math.max(best, choice.supports ? choice.bonus[k] : 0);
        supportHigh[depth][k] = best + supportHigh[depth + 1][k];
      }
    }
    const support = [0, 0, 0, 0, 0];
    for (const tome of tomes) {
      if (tome.statMap.get("type") === "guildTome") {
        const points = tome.statMap.get("skillpoints");
        for (let k = 0; k < 5; k++) support[k] += points[k];
      }
    }
    const selected = [];
    let examined = 0n,
      matched = 0n,
      nextReport = 0;
    const builds = [],
      signatures = new Set();
    const start = performance.now();
    let revision = 0,
      reportedRevision = -1;
    function report() {
      const now = performance.now();
      if (now >= nextReport) {
        const update = {
          examined: String(examined),
          total: String(suffix[0]),
          matched: String(matched),
          elapsed: (now - start) / 1000,
        };
        if (revision !== reportedRevision) {
          update.builds = builds.slice();
          reportedRevision = revision;
        }
        progress?.(update);
        nextReport = now + 160;
      }
    }
    function possibleSkills(depth) {
      const minimum = [0, 0, 0, 0, 0];
      for (const choice of selected) {
        for (let k = 0; k < 5; k++)
          if (choice.needs[k] > 0) {
            const optimistic =
              support[k] +
              supportHigh[depth][k] -
              (choice.supports ? choice.bonus[k] : 0);
            minimum[k] = Math.max(minimum[k], choice.needs[k] - optimistic);
          }
      }
      return (
        minimum.every((n) => n <= 100) &&
        minimum.reduce((a, b) => a + b, 0) <= levelToSkillPoints(config.level)
      );
    }
    function retain(build, stats) {
      const score = stats[config.objective];
      if (!Number.isFinite(score)) return;
      const identity = selected.map((choice) => choice.key);
      if (config.ringSymmetric && identity[4] > identity[5])
        [identity[4], identity[5]] = [identity[5], identity[4]];
      const signature = JSON.stringify(identity);
      if (signatures.has(signature)) return;
      if (rankings.some(rank => !Number.isFinite(stats[rank.stat]))) return;
      const result = {
        signature,
        score,
        stats,
        assigned: build.base_skillpoints,
        totals: build.total_skillpoints,
        pieces: selected.map((choice) => ({
          key: choice.key,
          pinned: !!choice.pinned,
          name: choice.item.statMap.get("displayName"),
        })),
      };
      builds.push(result);
      builds.sort(compare);
      signatures.add(signature);
      for (const removed of builds.splice(limit))
        signatures.delete(removed.signature);
      revision++;
    }
    // Fast feasible incumbents make the full search's score bounds useful.
    // Seeding never removes candidates or changes the exhaustive completion.
    function seed() {
      let randomState = 0x3bd39e10;
      function random() {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return (randomState >>> 0) / 4294967296;
      }
      for (let attempt = 0; attempt < 1800; attempt++) {
        selected.length = 0;
        for (const pool of choices) {
          const rank = random();
          selected.push(
            pool[
              Math.min(
                pool.length - 1,
                Math.floor((attempt % 2 ? rank : rank * rank) * pool.length),
              )
            ],
          );
        }
        if (!config.duplicateRings && selected[4].key === selected[5].key)
          continue;
        const build = OptimizerModel.assemble(
          config.level,
          selected.slice(0, 8).map((choice) => choice.item),
          tomes,
          selected[8].item,
        );
        if (!OptimizerModel.valid(build, config.characterClass)) continue;
        const stats = measure(build);
        if (
          rules.some(
            (rule) =>
              !Number.isFinite(stats[rule.stat]) || (rule.min != null && stats[rule.stat] < rule.min) ||
              (rule.max != null && stats[rule.stat] > rule.max),
          )
        )
          continue;
        const score = stats[config.objective];
        if (!Number.isFinite(score)) continue;
        if (
          builds.length < limit ||
          compare({stats}, builds.at(-1)) < 0
        )
          retain(build, stats);
        report();
      }
      selected.length = 0;
      // Always publish seed results before potentially large exhaustive work.
      nextReport = 0;
      report();
    }
    function visit(depth) {
      const span = suffix[depth];
      if (!possibleSkills(depth)) {
        examined += span;
        report();
        return;
      }
      const lo = keys.map((_, k) => lowTotals[k] + remainingLow[depth][k]);
      const hi = keys.map((_, k) => highTotals[k] + remainingHigh[depth][k]);
      if (
        rules.some((rule) => {
          const [min, max] = bounds(rule.stat, lo, hi);
          return (
            (rule.min != null && max < rule.min) ||
            (rule.max != null && min > rule.max)
          );
        })
      ) {
        examined += span;
        report();
        return;
      }
      if (builds.length === limit) {
        const [min, max] = bounds(config.objective, lo, hi),
          cutoff = builds.at(-1).score;
        const best = direction > 0 ? max : min;
        const margin = direction * (best - cutoff);
        const cannotImprove = config.secondary?.length ? margin < 0 : margin <= 0;
        if (cannotImprove) {
          examined += span;
          report();
          return;
        }
      }
      if (depth === count) {
        examined++;
        const equipment = selected.slice(0, 8).map((choice) => choice.item);
        const build = OptimizerModel.assemble(
          config.level,
          equipment,
          tomes,
          selected[8].item,
        );
        if (OptimizerModel.valid(build, config.characterClass)) {
          const stats = measure(build);
          if (
            rules.every(
              (rule) =>
                (rule.min == null || stats[rule.stat] >= rule.min) &&
                (rule.max == null || stats[rule.stat] <= rule.max),
            )
          ) {
            matched++;
            const score = stats[config.objective];
            if (!Number.isFinite(score)) return;
            if (
              builds.length < limit ||
              compare({stats}, builds.at(-1)) < 0
            ) {
              retain(build, stats);
            }
          }
        }
        report();
        return;
      }
      for (const choice of choices[depth]) {
        if (
          depth === 5 &&
          ((!config.duplicateRings && selected[4].key === choice.key) ||
            (config.ringSymmetric && choice.key < selected[4].key))
        ) {
          examined += suffix[depth + 1];
          continue;
        }
        selected.push(choice);
        for (let k = 0; k < keys.length; k++) {
          lowTotals[k] += choice.low[k];
          highTotals[k] += choice.high[k];
        }
        if (choice.supports)
          for (let k = 0; k < 5; k++) support[k] += choice.bonus[k];
        visit(depth + 1);
        if (choice.supports)
          for (let k = 0; k < 5; k++) support[k] -= choice.bonus[k];
        for (let k = 0; k < keys.length; k++) {
          lowTotals[k] -= choice.low[k];
          highTotals[k] -= choice.high[k];
        }
        selected.pop();
      }
    }
    if (suffix[0] > 1800n) seed();
    visit(0);
    progress?.({
      examined: String(examined),
      total: String(suffix[0]),
      matched: String(matched),
      elapsed: (performance.now() - start) / 1000,
    });
    return {
      builds,
      examined: String(examined),
      total: String(suffix[0]),
      matched: String(matched),
    };
  }
  return { search };
})();
