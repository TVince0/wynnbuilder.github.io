/** Shared by the builder graph and the optimizer. */
function getDefenseStats(stats) {
    let defenseStats = [];
    let def_pct = skillPointsToPercentage(stats.get('def')) * skillpoint_final_mult[3];
    let agi_pct = skillPointsToPercentage(stats.get('agi')) * skillpoint_final_mult[4];
    //total hp
    let totalHp = stats.get("hp") + stats.get("hpBonus");
    if (totalHp < 5) totalHp = 5;
    defenseStats.push(totalHp);
    //EHP
    let ehp = [totalHp, totalHp];
    let defMult = (2 - stats.get("classDef"));
    for (const [k, v] of stats.get("defMult").entries()) {
        defMult *= (1 - v / 100);
    }
    // agility bonuses
    let agi_reduction = (100 - stats.get("agiDef")) / 100;
    // newehp = oldehp / [A'(x) * A(x) + (1 - A(x)) * (1 - D(x))]
    ehp[0] = ehp[0] / (agi_reduction * agi_pct + (1 - agi_pct) * (1 - def_pct));
    ehp[0] /= defMult;
    // ehp[0] /= (1-def_pct)*(1-agi_pct)*defMult;
    ehp[1] /= (1 - def_pct) * defMult;
    defenseStats.push(ehp);
    //HPR
    let totalHpr = rawToPct(stats.get("hprRaw"), stats.get("hprPct") / 100.);
    defenseStats.push(totalHpr);
    //EHPR
    let ehpr = [totalHpr, totalHpr];
    ehpr[0] = ehpr[0] / (agi_reduction * agi_pct + (1 - agi_pct) * (1 - def_pct));
    ehpr[0] /= defMult;
    ehpr[1] /= (1 - def_pct) * defMult;
    defenseStats.push(ehpr);
    //skp stats
    defenseStats.push([def_pct * 100, agi_pct * 100]);
    //eledefs - TODO POWDERS
    let eledefs = [0, 0, 0, 0, 0];
    for (const i in skp_elements) { //kinda jank but ok
        eledefs[i] = rawToPctUncapped(stats.get(skp_elements[i] + "Def"), (stats.get(skp_elements[i] + "DefPct") + stats.get("rDefPct")) / 100.);
    }
    defenseStats.push(eledefs);

    //[total hp, [ehp w/ agi, ehp w/o agi], total hpr, [ehpr w/ agi, ehpr w/o agi], [def%, agi%], [edef,tdef,wdef,fdef,adef]]
    return defenseStats;
}
