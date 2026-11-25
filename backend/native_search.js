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
      manaRegen: "mr",
      manaPerHit: "ms",
      poisonDps: "poison",
      poisonMeleeDps: "poison",
      poisonSpellDps: "poison",
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
    // All GPU target checks are guidance. Native evaluation remains authoritative
    // for abilities, sets, buffs, powders and final damage calculations.
    const derived = {genericSpellHit: 1, health: 2, regen: 3, ehp: 4, ehpNoAgi: 4, maxManaTotal: 6, manaRegen: 7, assigned: 15};
    skp_order.forEach((key, i) => { derived[key] = 10 + i; derived['final' + key] = 10 + i; });
    const additive = new Set(OptimizerModel.componentKeys);
    const guidance = (config.rules || []).filter(rule => rule.min != null || rule.max != null)
      .filter(rule => derived[rule.stat] !== undefined || additive.has(rule.stat))
      .map(rule => ({...rule, kind: derived[rule.stat] ?? 0}));
    const combatFamily = config.objective.startsWith('melee') && !guidance.some(rule => rule.stat === 'genericSpellHit') ? 'Md' : 'Sd';
    function combatRow(item, weapon = false) {
      const map = item.statMap, result = Array(42).fill(0);
      ['n', ...skp_elements].forEach((element, i) => {
        if (weapon) {
          const range = map.get(element + 'Dam_');
          const pair = Array.isArray(range?.[1]) ? range[1] : range;
          const speed = baseDamageMultiplier[attackSpeeds.indexOf(map.get('atkSpd'))] || 1;
          if (Array.isArray(pair)) {result[i*6] = pair[0]*speed; result[i*6+1] = pair[1]*speed;}
        }
        result[i*6+2] = number(map, element+'DamAddMin'); result[i*6+3] = number(map, element+'DamAddMax');
        result[i*6+4] = number(map, element+combatFamily+'Pct') + number(map, element+'DamPct');
        result[i*6+5] = number(map, element+combatFamily+'Raw') + number(map, element+'DamRaw');
      });
      result[36] = number(map,'r'+combatFamily+'Pct') + number(map,'rDamPct');
      result[37] = number(map,'r'+combatFamily+'Raw') + number(map,'rDamRaw');
      result[38] = number(map,'critDamPct');
      result[39] = number(map,combatFamily.toLowerCase()+'Pct') + number(map,'damPct');
      result[40] = number(map,combatFamily.toLowerCase()+'Raw') + number(map,'damRaw');
      return result;
    }
    const combat = [], combatBase = Array(42).fill(0);
    const ruleFeatures = [], ruleBase = guidance.map(rule => rule.stat === 'hp' ? levelToHPBase(config.level) : 0);
    const rules = guidance.map(rule => [rule.kind, rule.min ?? -1e300, rule.max ?? 1e300,
      Math.max(1, Math.abs(rule.min ?? 0), Math.abs(rule.max ?? 0))]);
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
        combat.push(combatRow(entry.item, slot === 8));
        ruleFeatures.push(guidance.map(rule => rule.kind === 0 ? number(entry.item.statMap, rule.stat) : 0));
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
      combatRow(item).forEach((value, i) => combatBase[i] += value);
      guidance.forEach((rule, i) => { if (rule.kind === 0) ruleBase[i] += number(item.statMap, rule.stat); });
      for (let k = 0; k < 5; k++) base[5 + k] += values[k];
      for (let k = 11; k < 32; k++) base[15 + k] += values[k];
      if (item === guild) {
        for (let k = 0; k < 5; k++) {
          base[k] = item.statMap.get("crafted") ? 0 : values[k];
          base[10 + k] = values[5 + k];
        }
      }
    }
    const ringKeys = pools[4].map((entry) => entry.key);
    config.ringSymmetric =
      !!config.ringSymmetric &&
      ringKeys.length === pools[5].length &&
      ringKeys.every((key, index) => key === pools[5][index].key);
    const ringKeySet = new Set(ringKeys);
    const intersection = pools[5].filter((entry) =>
      ringKeySet.has(entry.key),
    ).length;
    const ringPairs = config.ringSymmetric
      ? (BigInt(ringKeys.length) *
          BigInt(ringKeys.length + (config.duplicateRings ? 1 : -1))) /
        2n
      : BigInt(pools[4].length) * BigInt(pools[5].length) -
        BigInt(config.duplicateRings ? 0 : intersection);
    const total = pools.reduce(
      (value, pool, slot) =>
        slot === 4 || slot === 5 ? value : value * BigInt(pool.length),
      ringPairs,
    );
    return {
      items, ruleFeatures, ruleBase, rules, combat, combatBase,
      guidedRules: guidance.map(rule => rule.stat),
      total: String(total),
      ringSymmetric: config.ringSymmetric,
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
      const functioning = OptimizerModel.valid(build, config.characterClass);
      const skillError = Math.max(0, build.assigned_skillpoints - levelToSkillPoints(config.level))
        + build.base_skillpoints.reduce((sum, value) => sum + Math.max(0, value - 100), 0);
      // Retain near-feasible states so two-piece repairs can cross skill gaps.
      if (!functioning && skillError === 0) continue;
      let stats;
      if(functioning){
        stats = OptimizerFinal.measurements(build,config.finalContext,requested);
      }else{
        // Illegal equipment allocations cannot produce an accepted result.
        // Retain cheap aggregate guidance without running the full ability graph.
        const baseStats=new Map(build.statMap);
        skp_order.forEach((key,i)=>baseStats.set(key,build.total_skillpoints[i]));
        baseStats.set('classDef',classDefenseMultipliers.get(build.weapon.statMap.get('type')));
        stats=OptimizerFinal.values(build,baseStats,new Map(),requested);
        for(const key of requested)if(!Number.isFinite(stats[key]))stats[key]=0;
      }
      if (keys.some((key) => !Number.isFinite(stats[key]))) continue;
      const shortfalls = [];
      if (skillError > 0) shortfalls.push({stat:'assigned', value:build.assigned_skillpoints, skillError});
      let violation = (functioning?0:1) + skillError / Math.max(1, levelToSkillPoints(config.level));
      for (const rule of config.rules || []) {
        const value = stats[rule.stat];
        if (!Number.isFinite(value)) {
          violation = Infinity;
          break;
        }
        const below = rule.min == null ? 0 : Math.max(0, rule.min - value);
        const above = rule.max == null ? 0 : Math.max(0, value - rule.max);
        if (below || above) shortfalls.push({stat:rule.stat, value, min:rule.min, max:rule.max, below, above});
        violation += below / Math.max(1, Math.abs(rule.min ?? 1)) + above / Math.max(1, Math.abs(rule.max ?? 1));
      }
      if (!Number.isFinite(violation)) continue;
      const identity = choices.map((choice) => choice.key);
      if (config.ringSymmetric && identity[4] > identity[5])
        [identity[4], identity[5]] = [identity[5], identity[4]];
      output.push({
        signature: JSON.stringify(identity),
        indices: tuple,
        violation, functioning, shortfalls, evaluationStage:functioning?'full-native':'skill-only',
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
