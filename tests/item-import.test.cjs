const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
  const ctx = vm.createContext({console, TextEncoder, window: {location:{protocol:'http:',host:'localhost',pathname:'/builder/'}}, location:{hash:''}, navigator:{userAgent:'node'}, URL});
  const run = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), ctx, {filename:file});
  for (const file of ['utils.js','build_utils.js','powders.js','display_constants.js']) run(file);
  vm.runInContext('class Loader {}', ctx);
  run('load_item.js');
  ctx.raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/2.2.6.0/items.json'), 'utf8'));
  vm.runInContext('item_loader.process_old_version(raw); item_loader.init_maps();', ctx);
  run('optimizer/model.js');
  run('optimizer/item_import.js');
  return code => vm.runInContext(code, ctx);
}

test('current and legacy lore preserve actual values, signs, units and glyph spacing', () => {
  const run = setup();
  const rows = run(`(() => {
    const look = WynnForgeItems.aliases();
    return ['Health Regen +145', '+145 Health Regen', 'Health Regen −25%',
      '\\uE001Mana Regen\\uDB00\\uDC02+7/5s\\uE020', '+3/3s Mana Steal',
      '1st Spell Cost -2', '3rd Spell Cost -17%', 'Spell Damage +2,015 [72%]',
      'Earth Main Attack Damage +12%', 'Healing Efficiency +8%',
      'Combat Experience +24%', 'Strength Min: 40', 'Damage: 100-150',
      'Meteor Cost -2', 'Heal Cost -10%', 'Uppercut Cost +12%']
      .map(line => WynnForgeItems.readLine(line, look));
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    {key:'hprRaw',value:145}, {key:'hprRaw',value:145}, {key:'hprPct',value:-25},
    {key:'mr',value:7}, {key:'ms',value:3}, {key:'spRaw1',value:-2},
    {key:'spPct3',value:-17}, {key:'sdRaw',value:2015}, {key:'eMdPct',value:12},
    {key:'healPct',value:8}, {key:'xpb',value:24}, null, null,
    {key:'spRaw3',value:-2}, {key:'spPct1',value:-10}, {key:'spPct3',value:12},
  ]);
});

test('real database item uses copied rolls and refuses incomplete or out-of-range exports', () => {
  const run = setup();
  const result = run(`(() => {
    const source = {name:'Third Eye', lore:['Mana Regen +7/5s', 'Water Defence +20%', '1st Spell Cost -10%', '2nd Spell Cost -11%', '3rd Spell Cost -12%', '4th Spell Cost -13%', 'Elemental Defence +40%']};
    const parse = row => WynnForgeItems.parse({format:'wynnforge.items',version:1,items:[row]},itemMap)[0];
    const ready = parse(source);
    const missing = parse({...source,lore:source.lore.slice(0,2)});
    const bad = parse({...source,lore:[...source.lore,'Mana Regen +900/5s']});
    const conflict = parse({...source,lore:[...source.lore,'Mana Regen +8/5s']});
    const native = ready.error ? null : OptimizerModel.prepare(ready.record, 'optimistic', ready.actual).statMap;
    return {ready,missing:missing.error,bad:bad.error,conflict:conflict.error,
      mr:native?.get('maxRolls').get('mr'),cost:native?.get('maxRolls').get('spPct1')};
  })()`);
  assert.equal(result.ready.error, undefined, result.ready.error);
  assert.equal(result.mr, 7);
  assert.equal(result.cost, -10);
  assert.match(result.missing, /Missing identifications/);
  assert.match(result.bad, /Conflicting|outside/);
  assert.match(result.conflict, /Conflicting/);
});

test('same-name copies remain separate and malformed or unsupported exports fail clearly', () => {
  const run = setup();
  const result = run(`(() => {
    const input = {format:'wynnforge.items',version:1,items:[
      {name:'Third Eye',lore:['Mana Regen +7/5s','Water Defence +20%','1st Spell Cost -10%','2nd Spell Cost -11%','3rd Spell Cost -12%','4th Spell Cost -13%','Elemental Defence +40%']},
      {name:'Third Eye',lore:['Mana Regen +8/5s','Water Defence +22%','1st Spell Cost -11%','2nd Spell Cost -12%','3rd Spell Cost -13%','4th Spell Cost -10%','Elemental Defence +41%']},
      {name:'<img src=x onerror=alert(1)>',lore:[]},
      {name:'Third Eye',lore:[null]},
    ]};
    return WynnForgeItems.parse(input,itemMap).map(row=>({actual:row.actual,error:row.error}));
  })()`);
  assert.equal(result[0].error,undefined);
  assert.equal(result[1].error,undefined);
  assert.notEqual(result[0].actual.mr,result[1].actual.mr);
  assert.match(result[2].error,/No equippable template/);
  assert.match(result[3].error,/Invalid/);
  assert.throws(()=>run(`WynnForgeItems.parse('{',itemMap)`), /complete JSON/);
  assert.throws(()=>run(`WynnForgeItems.parse({format:'wynnforge.items',version:2,items:[]},itemMap)`), /version 1/);
  assert.throws(()=>run(`WynnForgeItems.parse({format:'wynnforge.items',version:1,items:new Array(257)},itemMap)`), /1–256/);
  assert.deepEqual(Array.from(run(`WynnForgeItems.slotsFor('ring')`)), ['ring1','ring2']);
});
