/* Same-origin transport to the local CUDA service. Disconnecting cancels the GPU job. */
class OptimizerCudaClient {
  constructor() {
    this.controller = new AbortController();
    this.stopped = false;
  }
  terminate() {
    this.stopped = true;
    this.controller.abort();
  }
  async postMessage(request) {
    const encode = (_key, value) =>
      value instanceof Map
        ? { __wynnType: "Map", value: [...value] }
        : value instanceof Set
          ? { __wynnType: "Set", value: [...value] }
          : value;
    try {
      const response = await fetch("/api/cuda/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request, encode),
        signal: this.controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        let detail;
        try {
          detail = JSON.parse(text).error;
        } catch {}
        throw Error(
          detail ||
            `CUDA backend returned HTTP ${response.status}. Run pnpm dev from the repository with CUDA configured.`,
        );
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        finished = false;
      while (!this.stopped) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const data = JSON.parse(line);
          if (data.result || data.error) finished = true;
          if (!this.stopped) this.onmessage?.({ data });
        }
        if (done) break;
      }
      if (!this.stopped && !finished)
        throw Error("CUDA backend disconnected before finishing.");
    } catch (error) {
      if (!this.stopped)
        this.onmessage?.({ data: { error: error.message || String(error) } });
    }
  }
}
