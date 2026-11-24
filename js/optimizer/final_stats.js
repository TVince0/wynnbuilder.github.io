/* Evaluate candidates through the same native calculation nodes as the page. */
const OptimizerFinal = (() => {
  const call = (node, entries) => node.compute_func(new Map(Object.entries(entries)));
  function snapshot() {
    if (atree_validate.get_value()?.[0]) throw new Error("Fix the ability tree errors before searching.");
    const interactive = atree_make_interactives.get_value() || [new Map(), new Map()];
    return {
      trees: ATREES,
      characterClass: wep_to_class.get(build_node.get_value().weapon.statMap.get('type')),
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
  function evaluate(build, context) {
    const stats = new Map(build.statMap);
    skp_order.forEach((key, i) => stats.set(key, build.total_skillpoints[i]));
    stats.set('classDef', classDefenseMultipliers.get(build.weapon.statMap.get('type')));
    const raid = call(raid_buff_node, {stats});
    const characterClass = wep_to_class.get(build.weapon.statMap.get('type'));
    const sameClass = characterClass === context.characterClass;
    const order = sameClass ? context.order : get_sorted_class_atree(context.trees, characterClass);
    const active = sameClass ? context.active : new Map(order.map(node => [node.ability.id, {active: false}]));
    const merged = call(atree_merge, {
      'atree-errors': [false, []], 'player-class': characterClass, build,
      'atree-state': active, atree: order, 'final-aspects': sameClass ? context.aspects : [], 'raid-buffs': raid,
    });
    const aggregate = (...maps) => call({compute_func: AggregateStatsNode.prototype.compute_func}, Object.fromEntries(maps.map((map, i) => [i, map])));
    const raw = call(atree_raw_stats, {'atree-merged': merged});
    const pre = aggregate(raid, raw, call({compute_func: PowderSpecialCalcNode.prototype.compute_func}, {'powder-specials': powder_special_input.get_value() || []}));
    const oldBuild = player_build;
    player_build = build;
    let scaled;
    try { scaled = call(radiance_node, {stats: pre}); }
    finally { player_build = oldBuild; }
    const sliders = new Map(), buttons = new Map();
    // Generate native defaults for any controls introduced by a candidate major ID.
    const defaults = call(atree_make_interactives, {'atree-merged': merged, 'atree-order': order, headless: true});
    for (const [key, info] of defaults[0]) sliders.set(key, {slider: {value: context.sliders.get(key) ?? info.slider.value}});
    for (const [key] of defaults[1]) buttons.set(key, {button: {classList: {contains: () => context.buttons.has(key)}}});
    const [tree, extra] = call(atree_scaling, {'atree-merged': merged, 'scale-stats': scaled, 'atree-interactive': [sliders, buttons]});
    const final = aggregate(scaled, extra, armor_powder_node.get_value() || new Map(), boosts_node.get_value() || new Map());
    const spells = call(atree_collect_spells, {'atree-merged': tree});
    return {stats: final, spells};
  }
  function measurements(build, context) {
    const {stats, spells} = evaluate(build, context);
    return values(build, stats, spells);
  }
  function values(build, stats, spells) {
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
    for (const [id, spell] of spells) {
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
      ['health','Total HP'], ['ehp','Effective HP'], ['ehpNoAgi','Effective HP (no agi)'], ['regen','HP Regen (Final)'],
      ...['Earth','Thunder','Water','Fire','Air'].map((name, i) => [skp_elements[i] + 'DefFinal', name + ' Def']),
      ['mr','Mana Regen /5s'], ['manaRegen','Mana Regen with base /5s'], ['ms','Mana Steal /3s'], ['manaPerHit','Mana per hit'],
      ['maxMana','Max Mana bonus'], ['maxManaTotal','Total Mana'], ['poison','Poison /3s'], ['expd','Exploding %'],
      ['spd','Walk Speed Bonus %'], ['jh','Jump Height'], ['xpb','Combat XP Bonus %'], ['lb','Loot Bonus %'],
      ['meleeDps','Melee Average DPS'], ['meleePerAttack','Melee Per Attack'], ['attackSpeed','Attack Speed (0–6)'],
      ['poisonDps','Total Poison DPS'], ['poisonMeleeDps','Melee Poison DPS'], ['poisonSpellDps','Spell Poison DPS'],
    ];
    const spells = atree_collect_spells.get_value() || new Map();
    for (const [id, spell] of spells) {
      if ('cost' in spell) metrics.push(['spell:' + id + ':cost', spell.name + ' · Mana cost'], ['spell:' + id + ':costRaw', spell.name + ' · Uncapped mana cost']);
      for (const part of spell.parts) {
        if (part.display === false) continue;
        metrics.push(['spell:' + id + ':' + part.name, spell.name + ' · ' + part.name]);
      }
    }
    for (const [key, name] of metrics) OptimizerModel.labels.set(key, name);
    return metrics;
  }
  return {snapshot, measurements, values, metrics};
})();
