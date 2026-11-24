/**
 * Allocate the minimum manual points for a complete Fruma loadout.
 *
 * Requirements use the net bonuses of all non-crafted armour/accessories and
 * the equipped guild tome. A piece cannot pay its own requirement. Crafted,
 * weapon and set bonuses affect final skills but cannot unlock requirements.
 * No equip-order search or partial-loadout rejection is involved.
 *
 * Return layout is shared with Build and its skill-point display.
 */
function calculate_skillpoints(equipment, weapon) {
  const all = equipment.concat(weapon ? [weapon] : []);
  const eligible = equipment.filter((item) => !item.get("crafted"));
  const support = [0, 0, 0, 0, 0];
  const assigned = [0, 0, 0, 0, 0];
  const itemSkills = [0, 0, 0, 0, 0];
  const activeSets = new Map();
  const values = (item) =>
    item.get("skillpoints") || skp_order.map((key) => item.get(key) || 0);

  for (const item of eligible) {
    const bonus = values(item);
    for (let i = 0; i < 5; i++) support[i] += bonus[i];
  }
  for (const item of all) {
    const reqs =
      item.get("reqs") || skp_order.map((key) => item.get(key + "Req") || 0);
    const bonus = values(item);
    const ownCounts = item !== weapon && !item.get("crafted");
    for (let i = 0; i < 5; i++) {
      if (reqs[i] > 0) {
        const available = support[i] - (ownCounts ? bonus[i] : 0);
        assigned[i] = Math.max(assigned[i], Math.ceil(reqs[i] - available));
      }
      itemSkills[i] += bonus[i];
    }
    const name = item.get("set");
    if (name && !item.has("NONE"))
      activeSets.set(name, (activeSets.get(name) || 0) + 1);
  }
  for (const [name, count] of activeSets) {
    const tiers = sets.get(name)?.bonuses;
    const bonus = tiers?.[Math.min(count, tiers.length) - 1] || {};
    for (let i = 0; i < 5; i++) itemSkills[i] += bonus[skp_order[i]] || 0;
  }
  const totals = assigned.map((points, i) => points + itemSkills[i]);
  return [
    equipment.slice(),
    assigned,
    totals,
    assigned.reduce((a, b) => a + b, 0),
    activeSets,
    itemSkills,
  ];
}
