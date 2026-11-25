const test = require('node:test');
const assert = require('node:assert/strict');

test('native and GPU micro-batches share a strict bounded progress frequency', async () => {
  const {ProgressGate} = await import('../backend/search_state.mjs');
  const gate = new ProgressGate();
  let messages=0;
  // Interleaved native/GPU completions for 20 seconds cannot build an update queue.
  for(let now=0;now<20000;now+=.1) {
    messages += gate.due(now) ? 1 : 0;
    messages += gate.due(now) ? 1 : 0;
  }
  assert.ok(messages>=79 && messages<=80, messages+' progress messages');
});

test('rolling deduplication evicts one old signature while retaining recent history', async () => {
  const {RollingSet} = await import('../backend/search_state.mjs');
  const seen = new RollingSet(3);
  for(const key of ['a','b','c'])assert.equal(seen.add(key),true);
  assert.equal(seen.add('c'),false);
  assert.equal(seen.evictions,0);
  seen.add('d');
  assert.equal(seen.has('a'),false);
  for(const key of ['b','c','d'])assert.equal(seen.has(key),true);
  for(let i=0;i<100000;i++)seen.add(String(i));
  assert.equal(seen.size,3);
  assert.equal(seen.keys.length,3);
  assert.equal(seen.evictions,100001);
  assert.ok(seen.has('99999') && seen.has('99998') && seen.has('99997'));
});

test('recent rates expose a slowdown while keeping lifetime averages separate', async () => {
  const {RecentRates} = await import('../backend/search_state.mjs');
  const recent = new RecentRates(0,{tested:0,evaluated:0,candidates:0,duplicates:0});
  let counters;
  for(let ms=250;ms<=4000;ms+=250){
    const fast=Math.min(ms,2000)/1000,slow=Math.max(0,ms-2000)/1000;
    counters={tested:fast*10000+slow*1000,evaluated:fast*100+slow*10,candidates:fast*100+slow*100,duplicates:slow*90};
    recent.read(ms,counters);
  }
  const rates=recent.read(4000,counters);
  assert.equal(rates.gpu,1000);
  assert.equal(rates.native,10);
  assert.equal(rates.newCandidates,10);
  assert.equal(rates.duplicateFraction,.9);
  assert.equal(counters.tested/4,5500);
  assert.ok(recent.samples.length<=10);
  // Even accidental high-frequency callers cannot grow retained telemetry forever.
  for(let ms=4001;ms<5000;ms++)recent.read(ms,counters);
  assert.ok(recent.samples.length<=32);
});
