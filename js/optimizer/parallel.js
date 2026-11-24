/* Worker pool with bounded result merging, live migration and immediate cancellation. */
class OptimizerPool {
  constructor(url) {
    this.url = url;
    this.workers = [];
    this.stopped = false;
  }
  terminate() {
    this.stopped = true;
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
  postMessage(request) {
    const config = request.config;
    const total = request.pools.reduce((value, pool) => value * BigInt(pool.length), 1n);
    const small = total <= 256n;
    const fast = config.strategy !== 'exhaustive' && !small;
    const count = fast ? Math.max(1, Math.min(8, config.workers || 1)) : 1;
    const compare = OptimizerSearch.createComparator(config);
    const states = Array.from({length: count}, () => ({examined: '0', evaluated: 0}));
    let builds = [], finished = 0, lastMigration = 0;
    const started = performance.now();
    const merge = incoming => {
      const bySignature = new Map(builds.map(build => [build.signature, build]));
      for (const build of incoming || []) bySignature.set(build.signature, build);
      builds = [...bySignature.values()].sort(compare).slice(0, config.limit || 10);
    };
    const fail = error => {
      if (this.stopped) return;
      this.onmessage?.({data: {error}});
      this.terminate();
    };
    for (let index = 0; index < count; index++) {
      if (this.stopped) break;
      const worker = new Worker(this.url);
      this.workers.push(worker);
      worker.onerror = event => fail(event.message || 'A search worker failed.');
      worker.onmessage = ({data}) => {
        if (this.stopped) return;
        if (data.error) { fail(data.error); return; }
        const update = data.result || data.progress;
        if (!update) return;
        states[index] = update;
        merge(update.builds);
        const now = performance.now();
        if (fast && now - lastMigration > 750 && builds.length) {
          lastMigration = now;
          const migrants = builds.slice(0, 8).map(build => ({pieces: build.pieces}));
          for (const member of this.workers) member.postMessage({type: 'migrate', builds: migrants});
        }
        const aggregate = {
          builds, examined: String(states.reduce((sum, state) => sum + BigInt(state.examined || 0), 0n)),
          evaluated: states.reduce((sum, state) => sum + (state.evaluated || 0), 0),
          total: String(total), elapsed: (now - started) / 1000, fast, workers: count,
        };
        if (data.result) finished++;
        if (finished === count) {
          this.onmessage?.({data: {result: {...aggregate, complete: !fast}}});
          this.terminate();
        } else this.onmessage?.({data: {progress: aggregate}});
      };
      worker.postMessage({...request, config: {...config, strategy: fast ? 'fast' : 'exhaustive', seed: ((Date.now() >>> 0) + index * 2654435761) >>> 0}});
    }
  }
}
