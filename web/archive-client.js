export class ArchiveClient {
  constructor(manifest, onStatus) {
    this.manifest = manifest;
    this.onStatus = onStatus;
    this.pending = new Map();
    this.sequence = 0;
    this.state = "idle";
  }

  start() {
    if (this.worker && this.state !== "error") return;
    this.worker?.terminate();
    for (const request of this.pending.values()) request.reject(new Error("Зареждането се рестартира."));
    this.pending.clear();
    this.state = "loading";
    try {
      this.worker = new Worker(new URL("./archive-worker.js", import.meta.url), {type: "module"});
      this.worker.onmessage = ({data}) => {
        if (data.type === "status") {
          this.state = data.state;
          this.onStatus(data);
          if (data.state === "error") this.fail(new Error(data.message));
          return;
        }
        const request = this.pending.get(data.id);
        if (!request) return;
        this.pending.delete(data.id);
        data.error ? request.reject(new Error(data.error)) : request.resolve(data.result);
      };
      this.worker.onerror = () => this.fail(new Error("Търсенето не се зареди. Провери връзката и обнови страницата."));
      const {schema, version, meta, tables, chunks, download_bytes} = this.manifest;
      this.worker.postMessage({type: "init", manifest: {schema, version, meta, tables, chunks, download_bytes}});
    } catch (error) { this.fail(error); }
  }

  fail(error) {
    this.state = "error";
    this.worker?.terminate();
    this.onStatus({state: "error", message: error.message});
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  request(type, payload, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    this.start();
    if (this.state === "error") return Promise.reject(new Error("Търсенето не се зареди. Опитай отново."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const abort = () => { this.pending.delete(id); reject(new DOMException("Aborted", "AbortError")); };
      const settle = (callback) => (value) => { signal?.removeEventListener("abort", abort); callback(value); };
      this.pending.set(id, {resolve: settle(resolve), reject: settle(reject)});
      signal?.addEventListener("abort", abort, {once: true});
      this.worker.postMessage({type, id, ...payload});
    });
  }

  query(params, signal) {
    // Initial pages need only bootstrap.json, independent of the full archive.
    if (!params.q && !params.subreddit && !params.year && params.sort === "newest" && Number(params.page) === 1) {
      return Promise.resolve(this.manifest.previews[params.type]);
    }
    return this.request("query", {params}, signal);
  }

  detail(key, signal) { return this.request("detail", {key}, signal); }
}
