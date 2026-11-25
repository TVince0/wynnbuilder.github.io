// Bounded state shared by the continuous CUDA coordinator.
export class ProgressGate {
  constructor(intervalMs = 250) {
    this.intervalMs = intervalMs;
    this.last = -Infinity;
  }
  due(now) {
    if (now - this.last < this.intervalMs) return false;
    this.last = now;
    return true;
  }
}

export class RollingSet {
  constructor(capacity = 200000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw Error('Invalid cache capacity.');
    this.capacity = capacity;
    this.keys = Array(capacity);
    this.entries = new Set();
    this.cursor = 0;
    this.evictions = 0;
  }
  get size() { return this.entries.size; }
  has(key) { return this.entries.has(key); }
  add(key) {
    if (this.entries.has(key)) return false;
    if (this.entries.size === this.capacity) {
      this.entries.delete(this.keys[this.cursor]);
      this.evictions++;
    }
    this.keys[this.cursor] = key;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.entries.add(key);
    return true;
  }
}

export class RecentRates {
  constructor(now, counters, windowMs = 2000) {
    this.windowMs = windowMs;
    this.samples = [{at: now, ...counters}];
  }
  read(now, counters) {
    const sample = {at: now, ...counters};
    if (this.samples.at(-1).at === now) this.samples[this.samples.length-1] = sample;
    else this.samples.push(sample);
    while (this.samples.length > 2 && this.samples[1].at <= now-this.windowMs) this.samples.shift();
    // Progress is capped at 4 Hz; retain a hard bound if a caller samples faster.
    while (this.samples.length > 32) this.samples.shift();
    const first = this.samples[0], seconds = Math.max(.001, (now-first.at)/1000);
    const delta = key => Math.max(0, (counters[key] || 0)-(first[key] || 0));
    const candidates = delta('candidates');
    return {
      windowSeconds: (now-first.at)/1000,
      gpu: delta('tested')/seconds,
      native: delta('evaluated')/seconds,
      newCandidates: Math.max(0, candidates-delta('duplicates'))/seconds,
      duplicateFraction: candidates ? Math.min(1, delta('duplicates')/candidates) : 0,
    };
  }
}
