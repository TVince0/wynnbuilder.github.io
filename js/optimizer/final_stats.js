/* Evaluate candidates through the same native calculation nodes as the page. */
const OptimizerFinal = (() => {
  const call = (node, entries) => node.compute_func(new Map(Object.entries(entries)));
  function snapshot() {
    if (atree_validate.get_value()?.[0]) throw new Error("Fix the ability tree errors before searching.");
    const interactive = atree_make_interactives.get_value() || [new Map(), new Map()];
    return {
      trees: ATREES,
      characterClass: wep_to_class.get(build_node.get_value()?.weapon.statMap.get('type')),
      order: (atree_node.get_value() || []).map(node => ({ability: node.ability})),
      active: new Map([...(atree_state_node.get_value() || [])].map(([id, value]) => [id, {active: value.active}])),
      aspects: aspect_agg_node.get_value() || [],
      sliders: new Map([...interactive[0]].map(([key, info]) => [key, info.slider.value])),
      buttons: new Set([...interactive[1]].filter(([, info]) => info.button.classList.contains('toggleOn')).map(([key]) => key)),
      elements: Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, {
        value: el.value, on: el.classList.contains('toggleOn'),
        children: [...el.children].map(child => ({id: child.id, on: child.classList.contains('toggleOn')})),
      }])),
      majorIds: MAJOR_IDS,
      powders: powder_special_input.get_value(),
    };
  }
  const compiledContexts = new WeakMap();
  function evaluate(build, context, requested) {
    const stats = new Map(build.statMap);
    skp_order.forEach((key, i) => stats.set(key, build.total_skillpoints[i]));
    stats.set('classDef', classDefenseMultipliers.get(build.weapon.statMap.get('type')));
    const raid = call(raid_buff_node, {stats});
    const characterClass = wep_to_class.get(build.weapon.statMap.get('type'));
    const sameClass = characterClass === context.characterClass;
    let cache = compiledContexts.get(context);
    if (!cache) { cache = new Map(); compiledContexts.set(context, cache); }
    const key = JSON.stringify([characterClass, [...raid.get('activeMajorIDs')].sort()]);
    let compiled = cache.get(key);
    if (!compiled) {
      const order = sameClass ? context.order : get_sorted_class_atree(context.trees, characterClass);
      const active = sameClass ? context.active : new Map(order.map(node => [node.ability.id, {active: false}]));
      const merged = call(atree_merge, {
        'atree-errors': [false, []], 'player-class': characterClass, build,
        'atree-state': active, atree: order, 'final-aspects': sameClass ? context.aspects : [], 'raid-buffs': raid,
      });
      const raw = call(atree_raw_stats, {'atree-merged': merged});
      const defaults = call(atree_make_interactives, {'atree-merged': merged, 'atree-order': order, headless: true});
      const sliders = new Map(), buttons = new Map();
      for (const [name, info] of defaults[0]) sliders.set(name, {slider: {value: context.sliders.get(name) ?? info.slider.value}});
      for (const [name] of defaults[1]) buttons.set(name, {button: {classList: {contains: () => context.buttons.has(name)}}});
      compiled = {merged, raw, sliders, buttons};
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(key, compiled);
    } else {
      // Retain frequently used ability/major-ID contexts across long searches.
      cache.delete(key);
      cache.set(key, compiled);
    }
    const {merged, raw, sliders, buttons} = compiled;
    const aggregate = (...maps) => call({compute_func: AggregateStatsNode.prototype.compute_func}, Object.fromEntries(maps.map((map, i) => [i, map])));
    const pre = aggregate(raid, raw, call({compute_func: PowderSpecialCalcNode.prototype.compute_func}, {'powder-specials': powder_special_input.get_value() || []}));
    const oldBuild = player_build;
    player_build = build;
    let scaled;
    try { scaled = call(radiance_node, {stats: pre}); }
    finally { player_build = oldBuild; }
    const [tree, extra] = call(atree_scaling, {'atree-merged': merged, 'scale-stats': scaled, 'atree-interactive': [sliders, buttons]});
    const final = aggregate(scaled, extra, armor_powder_node.get_value() || new Map(), boosts_node.get_value() || new Map());
    const needsSpells = !requested || [...requested].some(key => key.startsWith('spell:') || key === 'meleeDps' || key === 'meleePerAttack');
    const spells = needsSpells ? call(atree_collect_spells, {'atree-merged': tree}) : new Map();
    return {stats: final, spells};
  }
  function measurements(build, context, requested) {
    const {stats, spells} = evaluate(build, context, requested);
    return values(build, stats, spells, requested);
  }
  function values(build, stats, spells, requested) {
    const result = OptimizerModel.measurements(build, stats);
    const defense = getDefenseStats(stats);
    result.ehpNoAgi = defense[1][1];
    skp_elements.forEach((key, i) => result[key + 'DefFinal'] = defense[5][i]);
    const speed = Math.max(0, Math.min(6, attackSpeeds.indexOf(stats.get('atkSpd')) + stats.get('atkTier')));
    result.attackSpeed = speed;
    result.manaPerHit = Math.round((stats.get('ms') || 0) / 3 / baseDamageMultiplier[speed] * 10) / 10;
    let mult = 1;
    for (const value of (stats.get('poisonMult') || new Map()).values()) mult *= 1 + value / 100;
    result.poisonSpellDps = Math.max(0, Math.floor((stats.get('poison') || 0) * 2 * mult));
    result.poisonMeleeDps = Math.max(0, Math.floor((stats.get('poison') || 0) * baseDamageMultiplier[speed] * [2.6239,2.1198,1.3125,1.0083,.75,.5333,.3333][speed] * 3 * mult));
    result.poisonDps = result.poisonSpellDps + result.poisonMeleeDps;
    const crit = skillPointsToPercentage(stats.get('dex'));
    // A 100% spell hit with the weapon's existing element distribution.
    // Omitting a spell part excludes all native part-specific multipliers/conversions.
    if (!requested || requested.has('genericSpellHit')) {
      const generic = calculateSpellDamage(stats, build.weapon.statMap, [100, 0, 0, 0, 0, 0], true);
      result.genericSpellHit = (1 - crit) * (generic[0][0] + generic[0][1]) / 2
        + crit * (generic[1][0] + generic[1][1]) / 2;
    }
    for (const [id, spell] of spells) {
      if (requested && ![...requested].some(key => key.startsWith('spell:' + id + ':') || (id === 0 && (key === 'meleeDps' || key === 'meleePerAttack')))) continue;
      if ('cost' in spell) {
        result['spell:' + id + ':cost'] = getSpellCost(stats, spell);
        result['spell:' + id + ':costRaw'] = getSpellCost(stats, spell, false);
      }
      const parts = SpellDamageCalcNode.prototype.compute_func.call({spell}, new Map([['build', build], ['stats', stats]]));
      for (const part of parts) {
        const average = part.type === 'damage' ? (1-crit)*(part.normal_total[0]+part.normal_total[1])/2 + crit*(part.crit_total[0]+part.crit_total[1])/2 : part.heal_amount ?? part.poison_amount;
        result['spell:' + id + ':' + part.name] = average;
        if (id === 0 && part.name === spell.display) {
          result.meleePerAttack = average;
          result.meleeDps = calculateMeleeAverageDps(stats, spell, parts, average, speed);
        }
      }
    }
    return result;
  }
  function metrics() {
    const metrics = [
      ['genericSpellHit','Generic spell hit'],
      ['health','Total HP'], ['ehp','Effective HP'], ['ehpNoAgi','Effective HP (no agi)'],
      ['regen','HP Regen (Final)'], ['ehpr','Effective HP Regen'],
      ...['Earth','Thunder','Water','Fire','Air'].map((name, i) => [skp_elements[i] + 'DefFinal', name + ' Def (Final)']),
      ['manaRegen','Mana Regen with base /5s'], ['manaPerHit','Mana per hit'], ['maxManaTotal','Total Mana'],
      ['meleeDps','Melee Average DPS'], ['meleePerAttack','Melee Per Attack'], ['attackSpeed','Attack Speed (0–6)'],
      ['poisonDps','Total Poison DPS'], ['poisonMeleeDps','Melee Poison DPS'], ['poisonSpellDps','Spell Poison DPS'],
    ].map(([key, name]) => [key, name, 'Final and combined stats']);
    metrics.push(...OptimizerModel.componentMetrics());
    metrics.push(['assigned', 'Assigned skill points', 'Skill points']);
    ['Strength','Dexterity','Intelligence','Defense','Agility'].forEach((name, i) => metrics.push([skp_order[i], name, 'Skill points']));
    const spells = atree_collect_spells.get_value() || new Map();
    for (const [id, spell] of spells) {
      if ('cost' in spell) metrics.push(['spell:' + id + ':cost', spell.name + ' · Mana cost'], ['spell:' + id + ':costRaw', spell.name + ' · Uncapped mana cost']);
      for (const part of spell.parts) {
        if (part.display === false) continue;
        metrics.push(['spell:' + id + ':' + part.name, spell.name + ' · ' + part.name]);
      }
    }
    for (const metric of metrics) {
      if (!metric[2]) metric[2] = 'Ability tree outputs';
      OptimizerModel.labels.set(metric[0], metric[1]);
    }
    return metrics;
  }
  return {snapshot, measurements, values, metrics};
})();
