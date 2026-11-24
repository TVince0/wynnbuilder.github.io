const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
function context() {
  const ctx = vm.createContext({
    console: { log() {}, warn() {} },
    performance,
    window: {
      location: { protocol: "http:", host: "localhost", pathname: "/builder/" },
    },
    location: { hash: "" },
    navigator: { userAgent: "node" },
    URL,
  });
  const run = (file) =>
    vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), ctx, {
      filename: file,
    });
  for (const file of ["utils.js", "build_utils.js", "powders.js"]) run(file);
  vm.runInContext("class Loader {};", ctx);
  run("load_item.js");
  ctx.raw = JSON.parse(
    fs.readFileSync(path.join(root, "data/2.2.6.0/items.json"), "utf8"),
  );
  vm.runInContext(
    "item_loader.process_old_version(raw); item_loader.init_maps();",
    ctx,
  );
  for (const file of [
    "skillpoints.js",
    "builder/build.js",
    "defense_stats.js",
    "optimizer/model.js",
    "optimizer/search.js",
  ])
    run(file);
  vm.runInContext(
    `
        function fixture(type, name, props={}) {
            const row={name,displayName:name,type,category:weaponTypes.includes(type)?'weapon':accessoryTypes.includes(type)?'accessory':'armor',tier:'Rare',lvl:1,fixID:true,nDam:'0-0',eDam:'0-0',tDam:'0-0',wDam:'0-0',fDam:'0-0',aDam:'0-0',...props};
            clean_item(row);
            return OptimizerModel.prepare(row,'optimistic');
        }
        const emptyEquipment=()=>['helmet','chestplate','leggings','boots','ring','ring','bracelet','necklace'].map((type,i)=>fixture(type,'empty'+i));
        const weapon=()=>fixture('wand','weapon');
    `,
    ctx,
  );
  return { ctx, eval: (code) => vm.runInContext(code, ctx) };
}
test("net allocation accepts mutually supporting pieces independently of order and retains self exclusion", () => {
  const c = context();
  const result = c.eval(`
        const a=fixture('helmet','a',{intReq:60,dex:50});
        const b=fixture('chestplate','b',{dexReq:60,int:50});
        const first=calculate_skillpoints([a.statMap,b.statMap],weapon().statMap);
        const second=calculate_skillpoints([b.statMap,a.statMap],weapon().statMap);
        [first[1],second[1],
         calculate_skillpoints([fixture('helmet','own',{intReq:70,int:50}).statMap],weapon().statMap)[1],
         calculate_skillpoints([fixture('helmet','negative',{intReq:70,int:-20}).statMap],weapon().statMap)[1]]
    `);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    [0, 10, 10, 0, 0],
    [0, 10, 10, 0, 0],
    [0, 0, 70, 0, 0],
    [0, 0, 70, 0, 0],
  ]);
});
test("crafted, weapon and set bonuses cannot unlock requirements; guild bonuses can", () => {
  const c = context();
  assert.equal(
    c.eval(`
        const needing=fixture('helmet','need',{strReq:104});
        const guild=fixture('guildTome','guild',{str:4});guild.statMap.set('category','tome');
        const craft=fixture('boots','craft',{str:100});craft.statMap.set('crafted',true);
        const w=fixture('wand','boost',{str:100});
        calculate_skillpoints([needing.statMap,guild.statMap,craft.statMap],w.statMap)[1][0]
    `),
    100,
  );
  assert.equal(
    c.eval(
      "calculate_skillpoints([needing.statMap,craft.statMap],w.statMap)[1][0]",
    ),
    104,
  );
  assert.equal(
    c.eval(`
        sets.set('Testing',{items:['need'],bonuses:[{str:200}]});
        needing.statMap.set('set','Testing');
        calculate_skillpoints([needing.statMap],w.statMap)[1][0]
    `),
    104,
  );
  assert.equal(
    c.eval("calculate_skillpoints([needing.statMap],w.statMap)[2][0]"),
    404,
  );
});
test("every result obeys the per-skill and level budget", () => {
  const c = context();
  assert.equal(
    c.eval(`
        let gear=emptyEquipment();
        gear[0]=fixture('helmet','too many',{strReq:101});
        OptimizerModel.valid(OptimizerModel.assemble(106,gear,[],weapon()),'Mage')
    `),
    false,
  );
  assert.equal(
    c.eval(`
        gear[0]=fixture('helmet','budget',{strReq:80,dexReq:80,intReq:80});
        OptimizerModel.valid(OptimizerModel.assemble(106,gear,[],weapon()),'Mage')
    `),
    false,
  );
  assert.equal(
    c.eval(`
        gear[0]=fixture('helmet','lowlevel',{strReq:25});
        OptimizerModel.valid(OptimizerModel.assemble(10,gear,[],weapon()),'Mage')
    `),
    false,
  );
});
test("search considers support from future slots and ranks full builds against native Build measurements", () => {
  const c = context();
  const res = c.eval(`
        const base=emptyEquipment();
        base[0]=fixture('helmet','helm',{intReq:110,hprRaw:100});
        const chest=fixture('chestplate','support',{int:20,hprRaw:5});
        const alternative=fixture('chestplate','bad',{int:0,hprRaw:200});
        const pool=base.concat([weapon()]).map((item,i)=>[{key:String(i),item}]);
        pool[1]=[{key:'good',item:chest},{key:'bad',item:alternative}];
        OptimizerSearch.search(pool,[],{level:106,characterClass:'Mage',objective:'regen',rules:[{stat:'regen',min:100}],limit:10})
    `);
  assert.equal(res.builds.length, 1);
  assert.equal(res.builds[0].pieces[1].key, "good");
  assert.equal(res.builds[0].assigned[2], 90);
  assert.equal(res.builds[0].stats.regen, 105);
});
test("native roll scenarios retain fixed IDs, reversed spell costs, signed regen and zero overrides", () => {
  const c = context();
  const res = c.eval(`
        const record={name:'roll',displayName:'roll',type:'helmet',category:'armor',tier:'Rare',str:5,hprRaw:100,spRaw1:-5,hprPct:-20};
        clean_item(record);
        const modes=['pessimistic','realistic','optimistic'].map(mode=>{
            const item=OptimizerModel.prepare(record,mode);
            return [item.statMap.get('str'),item.statMap.get('maxRolls').get('hprRaw'),item.statMap.get('maxRolls').get('spRaw1')];
        });
        modes.push([OptimizerModel.prepare(record,'optimistic',{hprRaw:0}).statMap.get('maxRolls').get('hprRaw')]);
        modes
    `);
  assert.deepEqual(JSON.parse(JSON.stringify(res)), [
    [5, 30, -1],
    [5, 80, -3],
    [5, 130, -6],
    [0],
  ]);
});
test("representative real builds use the same stat and skill machinery as the normal builder", () => {
  const c = context();
  const data = c.eval(`
        const names=['Third Eye','Aquarius','Vaward','Memento','Concentration','Prism','Prowess','Diamond Hydro Necklace','Cascade'];
        const pieces=names.map(name=>OptimizerModel.prepare(itemMap.get(name),'realistic'));
        const build=OptimizerModel.assemble(106,pieces.slice(0,8),[],pieces[8]);
        const pool=pieces.map((item,i)=>[{key:names[i],item}]);
        const result=OptimizerSearch.search(pool,[],{level:106,characterClass:'Mage',objective:'regen',limit:1});
        ({valid:OptimizerModel.valid(build,'Mage'),stats:OptimizerModel.measurements(build),result})
    `);
  assert.ok(data.valid);
  assert.equal(data.result.builds.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(data.result.builds[0].stats)),
    JSON.parse(JSON.stringify(data.stats)),
  );
});

test("signed bounds and set tiers preserve exhaustive rankings across roll scenarios and target ranges", () => {
  const c = context();
  const comparison = c.eval(`
        sets.set('Signed',{
            items:[],bonuses:[{hprRaw:-90,hprPct:25,mr:1},{hprRaw:150,hprPct:-70,mr:9},
                {hprRaw:20,hprPct:110,mr:-1},{hprRaw:40,hprPct:-20,mr:0}]
        });
        let randomState=527103;
        const random=()=>{randomState=(randomState*1664525+1013904223)>>>0;return randomState/4294967296;};
        const types=['helmet','chestplate','leggings','boots','ring','ring','bracelet','necklace','wand'];
        let checks=[];
        for(const metric of ['regen','health','hprRaw','mr'])for(const direction of ['max','min']){
            const pools=types.map((type,slot)=>[0,1].map(n=>{
                const item=fixture(type,'slot'+slot+'-'+n,{
                    hp:Math.floor(random()*500)-200,hprRaw:Math.floor(random()*280)-140,
                    hprPct:Math.floor(random()*300)-150,mr:Math.floor(random()*12)-4,
                    str:Math.floor(random()*50)-15,strReq:Math.floor(random()*125),
                    set:slot<3?'Signed':null
                });
                return {key:String(slot)+'-'+n,item};
            }));
            const config={level:106,characterClass:'Mage',objective:metric,direction,limit:7,
                duplicateRings:true,rules:[{stat:'regen',min:-450,max:1200},{stat:'mr',min:0}]};
            const expected=[];
            const picked=[];
            function enumerate(depth){
                if(depth===9){
                    const build=OptimizerModel.assemble(config.level,picked.slice(0,8),[],picked[8]);
                    if(!OptimizerModel.valid(build,'Mage'))return;
                    const stats=OptimizerModel.measurements(build);
                    if(config.rules.every(r=>(r.min==null||stats[r.stat]>=r.min)&&(r.max==null||stats[r.stat]<=r.max)))expected.push(stats[metric]);
                    return;
                }
                for(const choice of pools[depth]){picked.push(choice.item);enumerate(depth+1);picked.pop();}
            }
            enumerate(0);
            expected.sort((a,b)=>direction==='min'?a-b:b-a);
            const actual=OptimizerSearch.search(pools,[],config).builds.map(b=>b.score);
            checks.push({actual,expected:expected.slice(0,7),metric,direction});
        }
        checks
    `);
  for (const check of comparison)
    assert.deepEqual(
      Array.from(check.actual),
      Array.from(check.expected),
      check.metric + " " + check.direction,
    );
});

test("guild tome skill support requires its unlocked slot", () => {
  const c = context();
  assert.equal(
    c.eval(`
    const gear = emptyEquipment();
    const tome = fixture('guildTome','guild',{str:4});
    tome.statMap.set('category','tome');
    OptimizerModel.valid(OptimizerModel.assemble(104,gear,[tome],weapon()),'Mage')
  `),
    false,
  );
  assert.equal(
    c.eval(
      "OptimizerModel.valid(OptimizerModel.assemble(105,gear,[tome],weapon()),'Mage')",
    ),
    true,
  );
});
