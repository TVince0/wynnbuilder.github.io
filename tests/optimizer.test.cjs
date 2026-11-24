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
    setTimeout,
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
    "optimizer/fast_search.js",
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
        const owned = OptimizerModel.prepare(record,'optimistic',{str:999,hp:99999});
        if (owned.statMap.get('str') !== 5 || owned.statMap.get('hp') === 99999) throw Error('Fixed stats were overridden');
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

test('secondary rankings preserve primary ties through branch pruning and order multiple tie breakers', () => {
  const c = context();
  const result = c.eval(`
    const pools = emptyEquipment().concat([weapon()]).map(item => [{key:item.statMap.get('name'),item}]);
    pools[0] = [
      fixture('helmet','a',{hp:100,mr:9}), fixture('helmet','b',{hp:100,mr:2}),
      fixture('helmet','c',{hp:200,mr:8}), fixture('helmet','d',{hp:100,mr:1})
    ].map(item => ({key:item.statMap.get('name'),item}));
    const run = direction => OptimizerSearch.search(pools,[],{level:106,characterClass:'Mage',objective:'hprRaw',direction:'max',limit:2,duplicateRings:true,rules:[],secondary:[{stat:'health',direction},{stat:'mr',direction:'min'}]}).builds.map(build=>build.pieces[0].name);
    [run('max'),run('min')];
  `);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [['c','d'],['d','b']]);
});


test('time-limited search repairs mutually supporting pieces and validates ranked results', async () => {
  const c = context();
  const result = await c.eval(`(async () => {
    const pools = emptyEquipment().concat([weapon()]).map(item => [{key:item.statMap.get('name'),item}]);
    pools[0].push({key:'supportA',item:fixture('helmet','supportA',{strReq:120,dex:100,hp:500})});
    pools[1].push({key:'supportB',item:fixture('chestplate','supportB',{dexReq:120,str:100,hp:500})});
    const config = {level:106,characterClass:'Mage',objective:'health',direction:'max',limit:5,duplicateRings:true,seconds:.15,seed:17,rules:[{stat:'health',min:levelToHPBase(106)+1000}]};
    const result = await OptimizerFast.search(pools,[],config);
    return {result, valid:result.builds.every(row=>row.assigned.every(n=>n<=100)&&row.assigned.reduce((a,b)=>a+b,0)<=200)};
  })()`);
  assert.equal(result.valid, true);
  assert.ok(result.result.builds.length);
  assert.equal(result.result.builds[0].pieces[0].name, 'supportA');
  assert.equal(result.result.builds[0].pieces[1].name, 'supportB');
  assert.equal(result.result.complete, false);
});

test('parallel search merges tie breakers, waits for all workers, and ignores cancelled updates', () => {
  const c = context();
  c.ctx.members = [];
  c.ctx.messages = [];
  vm.runInContext(`class Worker {
    constructor() {this.sent=[]; members.push(this);}
    postMessage(data) {this.sent.push(data);}
    terminate() {this.stopped=true;}
  }`, c.ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'js/optimizer/parallel.js'),'utf8'), c.ctx);
  const result = c.eval(`
    const pool = new OptimizerPool('worker.js');
    pool.onmessage=event=>messages.push(event.data);
    const config={strategy:'fast',workers:3,seconds:1,limit:2,objective:'health',direction:'max',secondary:[{stat:'mr',direction:'max'}]};
    pool.postMessage({config,pools:Array.from({length:9},()=>[1,2]),sets:[],tomes:[]});
    const entry=(signature,mr)=>({signature,score:100,stats:{health:100,mr},pieces:[]});
    members[0].onmessage({data:{result:{builds:[entry('a',1)],examined:'5'}}});
    const early=messages.some(message=>message.result);
    members[1].onmessage({data:{result:{builds:[entry('b',3),entry('a',1)],examined:'6'}}});
    members[2].onmessage({data:{result:{builds:[entry('c',2)],examined:'7'}}});
    const done=messages.at(-1).result;
    const before=messages.length;
    members[0].onmessage({data:{progress:{builds:[entry('late',99)],examined:'999'}}});
    [early,done.builds.map(build=>build.signature),done.examined,members.every(member=>member.stopped),messages.length===before];
  `);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [false,['b','c'],'18',true,true]);
});


test('host compilation of the shared CUDA skill filter agrees with native net allocations', t => {
  const {spawnSync} = require('node:child_process');
  if (spawnSync('g++',['--version']).error) {t.skip('g++ is required for the shared CUDA formula test');return;}
  const directory = fs.mkdtempSync(path.join(root,'.cuda-test-'));
  try {
    const source = path.join(directory,'filter.cpp'), binary = path.join(directory,'filter');
    fs.writeFileSync(source, `
      #include <cmath>
      #include <iostream>
      using std::isfinite;
      #define __device__
      #define WYNN_HOST_TEST
      #include "${path.join(root,'backend/search.cu')}"
      int main() {
        int cases;std::cin>>cases;
        while(cases--) {
          double rows[9*32],base[47],score;int indices[9];
          for(auto &x:rows)std::cin>>x;
          for(auto &x:base)std::cin>>x;
          for(int i=0;i<9;i++)indices[i]=i;
          std::cout<<evaluate_candidate(rows,indices,base,200,2,1,score)<<" ";
        }
      }
    `);
    const compiled = spawnSync('g++',['-std=c++14','-O2',source,'-o',binary],{encoding:'utf8'});
    assert.equal(compiled.status,0,compiled.stderr);
    const c=context();
    vm.runInContext(fs.readFileSync(path.join(root,'backend/native_search.js'),'utf8'),c.ctx);
    const cases=c.eval(`(() => {
      let seed=1729;
      const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
      return Array.from({length:200},(_,index)=>{
        const items=emptyEquipment().concat([weapon()]);
        for(const item of items) {
          const bonus=Array.from({length:5},()=>random(90)-30);
          const reqs=Array.from({length:5},()=>random(170));
          item.statMap.set('skillpoints',bonus);item.statMap.set('reqs',reqs);
          item.statMap.set('crafted',random(5)===0);
        }
        const guild=fixture('guildTome','guild',{str:12,int:-3,strReq:index%4?0:100});
        const tomes=[guild];
        const config={level:106,objective:'health',direction:'max',duplicateRings:true};
        const pools=items.map(item=>[{key:item.statMap.get('name'),item}]);
        const payload=OptimizerCuda.pack({pools,tomes,config});
        const allocation=calculate_skillpoints(items.slice(0,8).concat(tomes).map(item=>item.statMap),items[8].statMap);
        return {payload,valid:allocation[3]<=200&&allocation[1].every(value=>value<=100)};
      });
    })()`);
    const input=cases.length+' '+cases.map(entry=>entry.payload.items.flat().concat(entry.payload.base).join(' ')).join(' ');
    const run=spawnSync(binary,[],{input,encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    assert.deepEqual(run.stdout.trim().split(/\s+/).map(value=>value==='1'),Array.from(cases,entry=>entry.valid));
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
