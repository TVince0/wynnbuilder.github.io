/* Shared native-item preparation and measurements for the page and Worker. */
const OptimizerModel = (() => {
  const slots = [
    "helmet",
    "chestplate",
    "leggings",
    "boots",
    "ring1",
    "ring2",
    "bracelet",
    "necklace",
    "weapon",
  ];
  const baseMetrics = [
    ["health", "Health"],
    ["regen", "Health regen"],
    ["ehp", "Effective HP"],
    ["ehpr", "Effective health regen"],
    ["manaRegen", "Mana regen with base /5s"],
    ["maxManaTotal", "Maximum mana"],
    ["assigned", "Assigned skill points"],
  ];
  const componentGroups = [
    ["Health and defense components", [
      "hprRaw", "hprPct", "hp", "hpBonus", "ls", "healPct",
      ...skp_elements.flatMap(key => [key + "Def", key + "DefPct"]), "rDefPct",
    ]],
    ["Spell damage components", ["sdRaw", "sdPct", ...[...skp_elements, "n", "r"].flatMap(key => [key + "SdRaw", key + "SdPct"])]],
    ["Melee damage components", ["mdRaw", "mdPct", ...[...skp_elements, "n", "r"].flatMap(key => [key + "MdRaw", key + "MdPct"])]],
    ["Damage components", [
      "damRaw", "damPct", "damAddMin", "damAddMax", "critDamPct",
      ...[...skp_elements, "n", "r"].flatMap(key => [key + "DamRaw", key + "DamPct", key + "DamAddMin", key + "DamAddMax"]),
    ]],
    ["Mana and spell cost components", ["mr", "ms", "maxMana", ...[1, 2, 3, 4].flatMap(id => ["spRaw" + id, "spPct" + id, "spPct" + id + "Final"])]],
  ];
  const groupedKeys = new Set(componentGroups.flatMap(([, keys]) => keys));
  componentGroups.push(["Other identifications", rolledIDs.filter(key => !groupedKeys.has(key))]);
  const componentKeys = [...new Set(componentGroups.flatMap(([, keys]) => keys))];
  const labels = new Map([
    ...baseMetrics,
    ["hprRaw", "HP Regen (Raw)"], ["hprPct", "HP Regen %"],
    ["hp", "HP before HP Bonus"], ["hpBonus", "HP Bonus"],
    ["sdPct", "Spell Damage %"], ["sdRaw", "Raw Spell Damage"],
    ["mdPct", "Melee Damage %"], ["mdRaw", "Raw Melee Damage"],
    ["damPct", "Damage %"], ["damRaw", "Raw Damage"],
    ["mr", "Mana Regen /5s"], ["ms", "Mana Steal /3s"], ["maxMana", "Max Mana bonus"],
    ["poison", "Poison /3s"], ["expd", "Exploding %"], ["spd", "Walk Speed Bonus %"],
    ["jh", "Jump Height"], ["xpb", "Combat XP Bonus %"], ["lb", "Loot Bonus %"],
    ["atkTier", "Attack Speed Bonus (tiers)"],
  ]);
  for (const [prefix, name] of [["", ""], ...skp_elements.map((key, i) => [key, ["Earth", "Thunder", "Water", "Fire", "Air"][i]]), ["n", "Neutral"], ["r", "Elemental"]]) {
    const damage = prefix ? prefix + "Dam" : "dam";
    labels.set(damage + "AddMin", (name ? name + " " : "") + "Added Damage (Min)");
    labels.set(damage + "AddMax", (name ? name + " " : "") + "Added Damage (Max)");
    if (skp_elements.includes(prefix)) labels.set(prefix + "Def", name + " Def (Raw)");
  }
  for (let id = 1; id <= 4; id++) labels.set("spPct" + id + "Final", "Spell " + id + " Final Cost Modifier %");
  function componentMetrics() {
    return componentGroups.flatMap(([group, keys]) => keys.map(key => {
      let name = label(key);
      const suffix = typeof idSuffixes !== "undefined" ? idSuffixes[key]?.trim() : "";
      if (suffix && !name.includes(suffix)) name += " " + suffix;
      return [key, name, group];
    }));
  }
  function label(key) {
    return (
      labels.get(key) ||
      (typeof idPrefixes !== "undefined" &&
        idPrefixes[key]?.replace(/:\s*$/, "")) ||
      key
    );
  }
  function roll(item, mode, actual = {}) {
    const stat = item.statMap;
    const editable = new Set(rolledIDs.filter(key => !stat.get("fixID") && stat.get("minRolls").get(key) !== stat.get("maxRolls").get(key)));
    for (const key of rolledIDs) {
      const lo = stat.get("minRolls").get(key) || 0;
      const hi = stat.get("maxRolls").get(key) || 0;
      const value =
        mode === "optimistic"
          ? hi
          : mode === "pessimistic"
            ? lo
            : Math.round((lo + hi) / 2);
      stat.get("maxRolls").set(key, value);
      stat.get("minRolls").set(key, value);
    }
    for (const [key, value] of Object.entries(actual)) {
      if (!editable.has(key)) continue;
      if (!Number.isFinite(value))
        throw new Error("Invalid actual value for " + key);
      stat.get("maxRolls").set(key, value);
      stat.get("minRolls").set(key, value);
    }
    stat.set(
      "skillpoints",
      skp_order.map((key) => stat.get(key) || 0),
    );
    stat.set(
      "has_negstat",
      stat.get("skillpoints").some((value) => value < 0),
    );
    return item;
  }
  function prepare(record, mode, actual = {}, powders = []) {
    const item = roll(new Item(record), mode, actual);
    if (
      item.statMap.get("category") === "armor" ||
      item.statMap.get("category") === "weapon"
    ) {
      item.statMap.set(
        "powders",
        powders.slice(0, item.statMap.get("slots") || 0),
      );
      if (item.statMap.get("category") === "weapon")
        apply_weapon_powders(item.statMap);
      else applyArmorPowders(item.statMap);
    }
    return item;
  }
  function fromMap(map) {
    const item = new Item();
    item.statMap = new Map(map);
    // Map/array values must belong to this candidate after powder application.
    item.statMap.set("maxRolls", new Map(map.get("maxRolls")));
    item.statMap.set("minRolls", new Map(map.get("minRolls")));
    return item;
  }
  function assemble(level, equipment, tomes, weapon) {
    const guild = tomes.find(
      (item) => item.statMap.get("type") === "guildTome",
    );
    const support = equipment.concat(guild ? [guild] : []);
    return new Build(level, equipment, tomes, weapon, support);
  }
  function valid(build, characterClass) {
    const available = levelToSkillPoints(build.level);
    if (
      build.assigned_skillpoints > available ||
      build.base_skillpoints.some((value) => value > 100)
    )
      return false;
    const weaponClass = wep_to_class.get(build.weapon.statMap.get("type"));
    if (characterClass && weaponClass !== characterClass) return false;
    return build.items.every(
      (item) =>
        item.statMap.has("NONE") ||
        ((item.statMap.get("lvl") || 0) <= build.level &&
          (item.statMap.get("type") !== "guildTome" || build.level >= 105) &&
          (!item.statMap.get("classReq") ||
            String(item.statMap.get("classReq")).toLowerCase() ===
              weaponClass?.toLowerCase())),
    );
  }
  function seedFeatures(map) {
    const keys=[...new Set([...componentKeys,...skp_order,...skp_order.map(key=>key+'Req')])];
    const features=Object.fromEntries(keys.map(key=>[key,map.get('maxRolls')?.get(key)??map.get(key)??0]).filter(([,value])=>Number.isFinite(value)));
    if(map.get('category')==='weapon'){
      const speed=baseDamageMultiplier[attackSpeeds.indexOf(map.get('atkSpd'))]||1;
      features._weaponDps=damage_keys.reduce((sum,key)=>{
        const range=map.get(key),pair=Array.isArray(range?.[1])?range[1]:range;
        return sum+(Array.isArray(pair)?(pair[0]+pair[1])*.5*speed:0);
      },0);
    }
    return features;
  }
  function seedDistance(map, source) {
    const features=seedFeatures(map);
    const scales={_weaponDps:500,hp:1000,hpBonus:1000,hprRaw:500,hprPct:100,mr:10,ms:10,maxMana:30,sdRaw:100,sdPct:100,mdRaw:100,mdPct:100,damRaw:100,damPct:100,rSdRaw:100};
    for(const key of skp_order){scales[key]=30;scales[key+'Req']=100;}
    for(const key of skp_elements)scales[key+'DamPct']=100;
    return Object.entries(scales).reduce((sum,[key,scale])=>sum+Math.abs((features[key]||0)-(source[key]||0))/scale,0);
  }
  function measurements(build, finalStats) {
    const stats = new Map(finalStats || build.statMap);
    if (!finalStats) for (let i = 0; i < 5; i++)
      stats.set(skp_order[i], build.total_skillpoints[i]);
    stats.set(
      "classDef",
      classDefenseMultipliers.get(build.weapon.statMap.get("type")) ?? 1,
    );
    const defense = getDefenseStats(stats);
    const values = Object.fromEntries(
      [...stats].filter(([, value]) => typeof value === "number"),
    );
    // Missing numeric IDs represent zero, so zero/negative targets remain usable.
    for (const key of componentKeys) values[key] ??= 0;
    values.health = defense[0];
    values.ehp = defense[1][0];
    values.regen = defense[2];
    values.ehpr = defense[3][0];
    values.manaRegen = (stats.get("mr") || 0) + 25;
    values.maxManaTotal =
      100 +
      (stats.get("maxMana") || 0) +
      Math.floor(skillPointsToPercentage(stats.get("int")) * 100);
    values.assigned = build.assigned_skillpoints;
    for (let i = 0; i < 5; i++)
      values["final" + skp_order[i]] = build.total_skillpoints[i];
    return values;
  }
  return {
    slots,
    labels,
    baseMetrics,
    componentKeys,
    componentMetrics,
    seedFeatures, seedDistance,
    label,
    roll,
    prepare,
    fromMap,
    assemble,
    valid,
    measurements,
  };
})();
