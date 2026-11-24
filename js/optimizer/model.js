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
  const labels = new Map(baseMetrics);
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
      if (!Number.isFinite(value))
        throw new Error("Invalid actual value for " + key);
      if (rolledIDs.includes(key)) {
        stat.get("maxRolls").set(key, value);
        stat.get("minRolls").set(key, value);
      } else if (
        ["hp", "eDef", "tDef", "wDef", "fDef", "aDef", ...skp_order].includes(
          key,
        )
      ) {
        stat.set(key, value);
      } else throw new Error("Unsupported actual value " + key);
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
  function measurements(build) {
    const stats = new Map(build.statMap);
    for (let i = 0; i < 5; i++)
      stats.set(skp_order[i], build.total_skillpoints[i]);
    stats.set(
      "classDef",
      classDefenseMultipliers.get(build.weapon.statMap.get("type")) ?? 1,
    );
    const defense = getDefenseStats(stats);
    const values = Object.fromEntries(
      [...stats].filter(([, value]) => typeof value === "number"),
    );
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
    baseMetrics,
    label,
    roll,
    prepare,
    fromMap,
    assemble,
    valid,
    measurements,
  };
})();
