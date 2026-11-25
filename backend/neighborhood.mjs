import {RollingSet} from './search_state.mjs';

// Cheap local guidance only. Every submitted neighbor receives native validation.
const fraction = points => points <= 0 ? 0 : (.9908/(1-.9908)*(1-Math.pow(.9908,Math.min(150,points))))/100;
export function tupleKey(payload, tuple) {
  const local=tuple.map((index,slot)=>index-payload.offsets[slot]);
  if(payload.ringSymmetric && local[4]>local[5])[local[4],local[5]]=[local[5],local[4]];
  return local.join(',');
}
export function guide(payload, tuple) {
  const stats=Array(32).fill(0),support=payload.base.slice(0,5),skills=payload.base.slice(5,10),manual=Array(5).fill(0);
  for(let k=11;k<32;k++)stats[k]=payload.base[15+k];
  for(let slot=0;slot<9;slot++){
    const item=payload.items[tuple[slot]];
    for(let k=0;k<5;k++){skills[k]+=item[k];if(slot!==8&&item[10])support[k]+=item[k];}
    for(let k=11;k<32;k++)stats[k]+=item[k];
  }
  for(let slot=0;slot<9;slot++){
    const item=payload.items[tuple[slot]];
    for(let k=0;k<5;k++)if(item[5+k]>0)manual[k]=Math.max(manual[k],Math.ceil(item[5+k]-support[k]+(slot!==8&&item[10]?item[k]:0)-1e-9));
  }
  for(let k=0;k<5;k++)if(payload.base[10+k]>0)manual[k]=Math.max(manual[k],Math.ceil(payload.base[10+k]-support[k]+payload.base[k]-1e-9));
  const assigned=manual.reduce((sum,n)=>sum+n,0);
  const skillError=(Math.max(0,assigned-payload.budget)+manual.reduce((sum,n)=>sum+Math.max(0,n-100),0))/Math.max(1,payload.budget);
  for(let k=0;k<5;k++)skills[k]+=manual[k];
  let generic=Math.max(0,stats[20]*(1+(stats[15]+stats[17])/100)+stats[14]+stats[16])*(1+fraction(skills[0])+fraction(skills[1]));
  if(payload.combat){
    const data=payload.combatBase.slice();
    for(const index of tuple)for(let k=0;k<42;k++)data[k]+=payload.combat[index][k];
    const base=Array.from({length:6},(_,e)=>(data[e*6]+data[e*6+1])*.5+(data[e*6]||data[e*6+1]?(data[e*6+2]+data[e*6+3])*.5:0));
    const total=base.reduce((sum,n)=>sum+n,0),elemental=total-base[0];
    generic=base.reduce((sum,n,e)=>{
      const present=data[e*6]||data[e*6+1];
      const boost=1+data[39]/100+data[e*6+4]/100+(e?data[36]/100+fraction(skills[e-1])*[1,1,1,.867,.951][e-1]:0);
      const raw=(present?data[e*6+5]:0)+(total>0?n/total*data[40]:0)+(e&&elemental>0?n/elemental*data[37]:0);
      return sum+Math.max(0,n*boost+raw);
    },0)*(1+fraction(skills[0])+fraction(skills[1])*(1+data[38]/100));
  }
  const health=Math.max(5,stats[11]);
  const regen=stats[12]>=0?stats[12]*Math.max(0,1+stats[13]/100):stats[12]*(1+Math.abs(stats[13])/100);
  const derived={1:generic,2:health,3:regen,4:health/Math.max(.02,(1-fraction(skills[3])*.867)*(1-fraction(skills[4])*.951)),
    5:stats[21]-fraction(skills[2])*100,6:100+stats[22]+Math.floor(fraction(skills[2])*100),7:stats[18]+25,15:assigned};
  skills.forEach((value,k)=>derived[10+k]=value);
  const values=(payload.rules||[]).map((rule,r)=>rule[0]===0?tuple.reduce((sum,index)=>sum+payload.ruleFeatures[index][r],payload.ruleBase[r]):derived[rule[0]]);
  return {skillError,values,score:(payload.objective?derived[payload.objective]:stats[21])*payload.direction};
}
function rank(payload, tuple, base, native) {
  const estimate=guide(payload,tuple);
  let violation=estimate.skillError;
  for(let r=0;r<payload.rules.length;r++){
    const rule=payload.rules[r],key=payload.guidedRules[r];
    // Native anchor residuals carry its actual buffs/abilities into local ordering.
    const value=Number.isFinite(native?.stats[key])?native.stats[key]+estimate.values[r]-base.values[r]:estimate.values[r];
    violation+=(Math.max(0,rule[1]-value)+Math.max(0,value-rule[2]))/rule[3];
  }
  return {tuple,key:tupleKey(payload,tuple),violation,proxy:estimate.score,skillError:estimate.skillError,source:'local'};
}
const compare=(a,b)=>a.violation-b.violation||b.proxy-a.proxy||a.key.localeCompare(b.key);
export function neighborhood(payload, anchor, limit=8192) {
  const base=guide(payload,anchor.indices),singles=[],alternatives=[];
  for(let slot=0;slot<9;slot++){
    const options=[],size=payload.sizes[slot],stride=Math.max(1,Math.ceil(size/1500));
    for(let local=0;local<size;local+=stride){
      const index=payload.offsets[slot]+local;if(index===anchor.indices[slot])continue;
      const tuple=anchor.indices.slice();tuple[slot]=index;
      if(!payload.duplicateRings&&payload.rings[tuple[4]]===payload.rings[tuple[5]])continue;
      options.push(rank(payload,tuple,base,anchor));
    }
    options.sort(compare);singles.push(...options);
    const diverse=new Map(options.slice(0,8).map(row=>[row.key,row]));
    for(const row of options.slice().sort((a,b)=>a.skillError-b.skillError||compare(a,b)).slice(0,2))diverse.set(row.key,row);
    for(const row of options.slice().sort((a,b)=>b.proxy-a.proxy).slice(0,2))diverse.set(row.key,row);
    alternatives.push([...diverse.values()]);
  }
  singles.sort(compare);
  const pairs=[];
  for(let a=0;a<9;a++)for(let b=a+1;b<9;b++)for(const first of alternatives[a])for(const second of alternatives[b]){
    const tuple=anchor.indices.slice();tuple[a]=first.tuple[a];tuple[b]=second.tuple[b];
    if(!payload.duplicateRings&&payload.rings[tuple[4]]===payload.rings[tuple[5]])continue;
    pairs.push(rank(payload,tuple,base,anchor));
  }
  pairs.sort(compare);
  const unique=new Map();
  for(const row of [...singles.slice(0,128),...pairs.slice(0,2048),...singles.slice(128)]){
    if(row.key!==tupleKey(payload,anchor.indices))unique.set(row.key,row);
    if(unique.size>=limit)break;
  }
  return [...unique.values()];
}
export class NeighborhoodQueue {
  constructor(payload){this.payload=payload;this.pending=[];this.expanded=new RollingSet(128);this.rows=[];this.cursor=0;this.evaluated=0;}
  offer(anchor){
    const key=tupleKey(this.payload,anchor.indices);
    if(this.expanded.has(key)||this.pending.some(row=>row.key===key))return;
    this.pending.push({key,anchor});
    if(this.pending.length>8)this.pending.shift();
  }
  get hasWork(){return this.cursor<this.rows.length||this.pending.length>0;}
  take(limit,seen){
    const chosen=[],chosenKeys=new Set();
    while(chosen.length<limit){
      if(this.cursor>=this.rows.length){
        const next=this.pending.shift();if(!next)break;
        // Recent expanded anchors roll out gradually; long runs can keep improving.
        this.expanded.add(next.key);this.rows=neighborhood(this.payload,next.anchor);this.cursor=0;
      }
      const row=this.rows[this.cursor++];if(row&&!seen.has(row.key)&&!chosenKeys.has(row.key)){chosen.push(row);chosenKeys.add(row.key);this.evaluated++;}
    }
    return chosen;
  }
}
