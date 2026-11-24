/* Native WynnBuilder packing and final validation shared by backend validator threads. */
const OptimizerCuda = (() => {
  const number = (map, key) => {
    const value = map.get("maxRolls")?.get(key) ?? map.get(key) ?? 0;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  function objective(config) {
    const key = config.objective;
    if (
      key === "genericSpellHit" ||
      key === "meleeDps" ||
      key === "meleePerAttack" ||
      (key.startsWith("spell:") && !key.includes("cost"))
    )
      return [1, ""];
    if (key === "health") return [2, ""];
    if (key === "regen" || key === "ehpr") return [3, ""];
    if (key === "ehp" || key === "ehpNoAgi") return [4, ""];
    if (key.startsWith("spell:") && key.includes("cost")) {
      const id = key.split(":")[1];
      return [5, "spRaw" + id];
    }
    if (key === "maxManaTotal") return [6, "maxMana"];
    const aliases = {
      manaRegen: "mr", manaPerHit: "ms", poisonDps: "poison",
      poisonMeleeDps: "poison", poisonSpellDps: "poison",
    };
    return [0, aliases[key] || key.replace(/DefFinal$/, "Def")];
  }
  function pack(prepared) {
    const { pools, tomes, config } = prepared;
    const [mode, rawObjective] = objective(config);
    function row(item, supports, weapon = false) {
      const map = item.statMap;
      const values = Array(32).fill(0);
      const bonus = map.get("skillpoints") || [0, 0, 0, 0, 0];
      const reqs = map.get("reqs") || [0, 0, 0, 0, 0];
      for (let k = 0; k < 5; k++) {
        values[k] = bonus[k];
        values[k + 5] = reqs[k];
      }
      values[10] = supports && !map.get("crafted") ? 1 : 0;
      const names = [
        "hp",
        "hprRaw",
        "hprPct",
        config.objective.startsWith("melee") ? "mdRaw" : "sdRaw",
        config.objective.startsWith("melee") ? "mdPct" : "sdPct",
        "damRaw",
        "damPct",
        "mr",
        "ms",
      ];
      for (let k = 0; k < names.length; k++)
        values[11 + k] = number(map, names[k]);
      values[11] += number(map, "hpBonus");
      if (weapon) {
        const damages = damage_keys.map((key) => map.get(key));
        const mean = damages.reduce((sum, range) => {
          const pair = Array.isArray(range?.[1]) ? range[1] : range;
          return sum + (Array.isArray(pair) ? (pair[0] + pair[1]) / 2 : 0);
        }, 0);
        values[20] =
          mean *
          (baseDamageMultiplier[attackSpeeds.indexOf(map.get("atkSpd"))] || 1);
      }
      values[21] = rawObjective ? number(map, rawObjective) : 0;
      values[22] = number(map, "maxMana");
      skp_elements.forEach(
        (key, k) => (values[23 + k] = number(map, key + "Def")),
      );
      return values;
    }
    const items = [],
      offsets = [],
      sizes = [],
      rings = [],
      ids = new Map();
    for (const [slot, pool] of pools.entries()) {
      offsets.push(items.length);
      sizes.push(pool.length);
      for (const entry of pool) {
        items.push(row(entry.item, slot !== 8, slot === 8));
        if (!ids.has(entry.key)) ids.set(entry.key, ids.size);
        rings.push(ids.get(entry.key));
      }
    }
    const base = Array(47).fill(0);
    base[26] = levelToHPBase(config.level);
    const guild = tomes.find(
      (item) => item.statMap.get("type") === "guildTome",
    );
    for (const item of tomes) {
      if (item.statMap.has("NONE")) continue;
      const values = row(item, false);
      for (let k = 0; k < 5; k++) base[5 + k] += values[k];
      for (let k = 11; k < 32; k++) base[15 + k] += values[k];
      if (item === guild) {
        for (let k = 0; k < 5; k++) {
          base[k] = item.statMap.get("crafted") ? 0 : values[k];
          base[10 + k] = values[5 + k];
        }
      }
    }
    return {
      items,
      offsets,
      sizes,
      rings,
      base,
      budget: levelToSkillPoints(config.level),
      objective: mode,
      direction: config.direction === "min" ? -1 : 1,
      duplicateRings: config.duplicateRings,
      blocks: config.cudaBlocks || 256,
    };
  }
  function evaluateBatch(prepared, payload, indices) {
    const { pools, tomes, config } = prepared;
    const keys = [
      config.objective,
      ...(config.secondary || []).map((rank) => rank.stat),
    ];
    const requested = new Set([
      ...keys,
      ...(config.rules || []).map((rule) => rule.stat),
    ]);
    const output = [];
    for (const tuple of indices) {
      const choices = tuple.map(
        (index, slot) => pools[slot][index - payload.offsets[slot]],
      );
      if (choices.some((choice) => !choice))
        throw new Error("CUDA returned an out-of-range item index.");
      if (!config.duplicateRings && choices[4].key === choices[5].key) continue;
      const build = OptimizerModel.assemble(
        config.level,
        choices.slice(0, 8).map((choice) => choice.item),
        tomes,
        choices[8].item,
      );
      if (!OptimizerModel.valid(build, config.characterClass)) continue;
      const stats = OptimizerFinal.measurements(
        build,
        config.finalContext,
        requested,
      );
      if (keys.some((key) => !Number.isFinite(stats[key]))) continue;
      let violation = 0;
      for (const rule of config.rules || []) {
        const value = stats[rule.stat];
        if (!Number.isFinite(value)) {
          violation = Infinity;
          break;
        }
        if (rule.min != null)
          violation +=
            Math.max(0, rule.min - value) / Math.max(1, Math.abs(rule.min));
        if (rule.max != null)
          violation +=
            Math.max(0, value - rule.max) / Math.max(1, Math.abs(rule.max));
      }
      if (!Number.isFinite(violation)) continue;
      const identity = choices.map((choice) => choice.key);
      if (config.ringSymmetric && identity[4] > identity[5])
        [identity[4], identity[5]] = [identity[5], identity[4]];
      output.push({
        signature: JSON.stringify(identity),
        indices: tuple,
        violation,
        score: stats[config.objective],
        stats,
        assigned: build.base_skillpoints,
        totals: build.total_skillpoints,
        pieces: choices.map((choice) => ({
          key: choice.key,
          pinned: !!choice.pinned,
          name: choice.item.statMap.get("displayName"),
        })),
      });
    }
    return output;
  }
  return { pack, evaluateBatch };
})();
