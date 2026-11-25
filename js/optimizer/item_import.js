/* WynnForge v1: actual displayed values, never inferred roll percentages. */
const WynnForgeItems = (() => {
  const format = "wynnforge.items";
  const maxBytes = 8 * 1024 * 1024;
  function plain(value) {
    return String(value).replace(/§#[a-f\d]{8}|§[0-9a-fk-orx]/gi, "")
      .replace(/[\p{Co}\u{C0000}-\u{EFFFF}\u200b-\u200f\u2060-\u206f]/gu, " ")
      .replace(/[−–]/g, "-").replace(/\s+/g, " ").trim();
  }
  const norm = value => plain(value).toLowerCase().replace(/[.:]/g, "").trim();
  function aliases() {
    const map = new Map();
    const add = (key, unit, ...names) => names.forEach(name => map.set(norm(name) + "|" + unit, key));
    for (const key of rolledIDs) {
      if (typeof idPrefixes !== "undefined" && idPrefixes[key])
        add(key, (idSuffixes[key] || "").trim(), idPrefixes[key].replace(/:\s*$/, ""));
    }
    add("hprRaw", "", "Health Regen", "Health Regeneration");
    add("hprPct", "%", "Health Regen", "Health Regeneration");
    add("hpBonus", "", "Health", "Health Bonus");
    add("mr", "/5s", "Mana Regen", "Mana Regeneration");
    add("ms", "/3s", "Mana Steal");
    add("ls", "/3s", "Life Steal");
    add("spd", "%", "Walk Speed", "Walk Speed Bonus");
    add("atkTier", "tier", "Attack Speed", "Attack Speed Bonus");
    add("xpb", "%", "XP Bonus", "Combat XP Bonus", "Combat Experience");
    add("lb", "%", "Loot Bonus", "Loot");
    add("gXp", "%", "Gathering XP Bonus", "Gathering Experience");
    add("gSpd", "%", "Gathering Speed", "Gathering Speed Bonus");
    add("sprint", "%", "Sprint", "Sprint Bonus");
    add("sprintReg", "%", "Sprint Regen", "Sprint Regen Bonus");
    add("healPct", "%", "Healing Efficiency", "Heal Effectiveness");
    add("critDamPct", "%", "Critical Damage", "Critical Damage Bonus", "Crit Damage Bonus");
    add("mainAttackRange", "%", "Main Attack Range", "Melee Range");
    add("mdRaw", "", "Main Attack Damage", "Melee Damage");
    add("mdPct", "%", "Main Attack Damage", "Melee Damage");
    add("sdRaw", "", "Spell Damage");
    add("sdPct", "%", "Spell Damage");
    add("damRaw", "", "Damage");
    add("damPct", "%", "Damage");
    const elements = [["", ""], ["n", "Neutral "], ["e", "Earth "], ["t", "Thunder "], ["w", "Water "], ["f", "Fire "], ["a", "Air "], ["r", "Elemental "]];
    for (const [prefix, label] of elements) {
      for (const [unit, suffix] of [["", "Raw"], ["%", "Pct"]]) {
        for (const [middle, name] of [["Sd", "Spell Damage"], ["Md", "Main Attack Damage"], ["Dam", "Damage"]]) {
          const key = prefix ? prefix + middle + suffix : middle[0].toLowerCase() + middle.slice(1) + suffix;
          if (rolledIDs.includes(key)) add(key, unit, label + name, label + name.replace("Main Attack", "Melee"));
        }
      }
      if (prefix && prefix !== "n") add(prefix + "DefPct", "%", label + "Defence", label + "Defense");
    }
    const spellNames = [
      ["1st Spell", "Arrow Storm", "Spin Attack", "Bash", "Heal", "Totem"],
      ["2nd Spell", "Escape", "Dash", "Charge", "Teleport", "Haul"],
      ["3rd Spell", "Arrow Bomb", "Multihit", "Uppercut", "Meteor", "Aura"],
      ["4th Spell", "Arrow Shield", "Smoke Bomb", "War Scream", "Ice Snake", "Uproot"],
    ];
    for (const [i, names] of spellNames.entries()) {
      add("spRaw" + (i + 1), "", ...names.map(name => name + " Cost"));
      add("spPct" + (i + 1), "%", ...names.map(name => name + " Cost"));
    }
    return map;
  }
  function readLine(line, lookup) {
    let value = plain(line);
    // Optional Wynntils percentage / range annotations are not item values.
    value = value.replace(/\s*\[[^\]]*\]\s*$/g, "").trim();
    const number = "([+-]\\d[\\d,]*)(%|\\/[35]s| tiers?)?";
    const suffix = new RegExp("^(.+?)\\s*[:：]?\\s*" + number + "$").exec(value);
    const prefix = new RegExp("^" + number + "\\s+(.+)$").exec(value);
    if (!suffix && !prefix) return null;
    const label = suffix ? suffix[1] : prefix[3];
    const amount = Number((suffix ? suffix[2] : prefix[1]).replaceAll(",", ""));
    const unit = (suffix ? suffix[3] : prefix[2])?.trim().replace(/tiers$/, "tier") || "";
    const key = lookup.get(norm(label) + "|" + unit);
    return key ? {key, value: amount} : null;
  }
  function parse(input, catalog) {
    if (typeof input === "string") {
      if (new TextEncoder().encode(input).length > maxBytes) throw Error("Export exceeds the 8 MB limit.");
      try { input = JSON.parse(input); } catch { throw Error("Paste the complete JSON copied by the WynnForge mod."); }
    }
    if (!input || input.format !== format || input.version !== 1)
      throw Error("Expected a WynnForge item export (format wynnforge.items, version 1).");
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 256)
      throw Error("An export must contain 1–256 items.");
    const names = new Map();
    for (const record of catalog.values()) {
      names.set(norm(record.displayName || record.name), record);
      names.set(norm(record.name), record);
    }
    const lookup = aliases();
    return input.items.map((source, index) => {
      const result = {index, name: "Item " + (index + 1), source, actual: {}, warnings: []};
      try {
        if (!source || typeof source.name !== "string" || source.name.length > 512 || !Array.isArray(source.lore) || source.lore.length > 512 || source.lore.some(line => typeof line !== "string" || line.length > 16384))
          throw Error("Invalid item name or lore.");
        result.name = plain(source.name);
        let key = norm(source.name);
        // Exact matches first: Shiny Coin is an ordinary item name.
        const record = names.get(key) || names.get(key.replace(/^shiny /, ""));
        if (!record || record.remapID !== undefined || ![...armorTypes, ...accessoryTypes, ...weaponTypes].includes(record.type))
          throw Error("No equippable template in the loaded WynnBuilder version. Crafted, unidentified and renamed items need manual setup.");
        result.record = record;
        result.name = record.displayName || record.name;
        result.type = record.type;
        const item = new Item(record).statMap;
        const low = item.get("minRolls"), high = item.get("maxRolls");
        const expected = rolledIDs.filter(id => !item.get("fixID") && low.get(id) !== high.get(id));
        for (const line of source.lore) {
          const stat = readLine(line, lookup);
          if (!stat || !expected.includes(stat.key)) continue;
          const previous = result.actual[stat.key];
          if (previous !== undefined && previous !== stat.value) throw Error("Conflicting values for " + stat.key + ". Copy the item's identification page again.");
          const min = Math.min(low.get(stat.key), high.get(stat.key)), max = Math.max(low.get(stat.key), high.get(stat.key));
          if (!Number.isSafeInteger(stat.value) || stat.value < min || stat.value > max)
            throw Error(stat.key + " = " + stat.value + " is outside this version's range (" + min + " … " + max + "). Check the item database version.");
          result.actual[stat.key] = stat.value;
        }
        result.missing = expected.filter(id => !Object.hasOwn(result.actual, id));
        if (result.missing.length) throw Error("Missing identifications: " + result.missing.map(id => OptimizerModel.label(id)).join(", ") + ". Show the identification tooltip page and copy again. Enter hidden zero rolls manually with Edit rolls.");
        result.warnings.push("Set powders in the equipment editor after importing.");
      } catch (error) { result.error = error.message; }
      return result;
    });
  }
  function slotsFor(type) {
    return type === "ring" ? ["ring1", "ring2"] : weaponTypes.includes(type) ? ["weapon"] : armorTypes.concat(["bracelet", "necklace"]).includes(type) ? [type] : [];
  }
  return {format, maxBytes, plain, readLine, aliases, parse, slotsFor};
})();
