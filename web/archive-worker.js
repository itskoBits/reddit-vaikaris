import {ArchiveIndex} from "./archive-core.mjs";

let loading;
const status = (state, extra = {}) => self.postMessage({type: "status", state, ...extra});

async function unpack(buffer, expectedHash) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expectedHash) throw new Error("Непълни данни. Опитай отново.");
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

async function initialize(manifest) {
  if (manifest.schema !== 1) throw new Error("Обнови страницата, за да заредиш новата версия на архива.");
  if (typeof DecompressionStream === "undefined") throw new Error("За този архив е нужен актуален Chrome, Firefox, Edge или Safari.");
  const base = new URL(".", self.location.href);
  const prefix = `reddit-archive:${base.pathname}:`;
  const cacheName = `${prefix}${manifest.version}`;
  let cache;
  try { cache = await caches.open(cacheName); } catch { /* Storage can be unavailable in private browsing. */ }
  let loaded = 0, cached = 0, next = 0;
  const parts = new Array(manifest.chunks.length);
  status("loading", {loaded, total: manifest.download_bytes});

  async function consume() {
    while (next < manifest.chunks.length) {
      const index = next++;
      const chunk = manifest.chunks[index];
      const url = new URL(chunk.url, base).href;
      let rows;
      try {
        const saved = await cache?.match(url);
        if (saved) { rows = await unpack(await saved.arrayBuffer(), chunk.sha256); cached++; }
      } catch {
        // A stale/corrupt local copy must never make the archive unusable.
        try { await cache?.delete(url); } catch { /* Fetch still works without storage. */ }
      }
      if (!rows) {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Част от архива не се зареди. Провери връзката и опитай отново.");
        const buffer = await response.arrayBuffer();
        rows = await unpack(buffer, chunk.sha256);
        try { await cache?.put(url, new Response(buffer, {headers: {"Content-Type": "application/gzip"}})); } catch { /* Quota errors do not block searching. */ }
      }
      if (rows.length !== chunk.count) throw new Error("Непълни данни. Опитай отново.");
      parts[index] = rows;
      loaded += chunk.bytes;
      status("loading", {loaded, total: manifest.download_bytes});
    }
  }
  // Two downloads in parallel keep memory and connection usage bounded.
  await Promise.all([consume(), consume()]);
  status("indexing", {loaded, total: manifest.download_bytes});
  const rows = parts.flat();
  if (rows.length !== manifest.meta.total) throw new Error("Непълен архив. Опитай отново.");
  const archive = new ArchiveIndex(rows, manifest.tables);
  status("ready", {loaded, total: manifest.download_bytes, cached, chunks: manifest.chunks.length});
  // Only this project's previous generated archive caches are removed.
  if (cache) {
    try {
      for (const name of await caches.keys()) if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
    } catch { /* Cache maintenance is optional. */ }
  }
  return archive;
}

self.onmessage = async ({data}) => {
  if (data.type === "init") {
    loading = initialize(data.manifest);
    loading.catch((error) => status("error", {message: error.message}));
    return;
  }
  try {
    const archive = await loading;
    if (!archive) throw new Error("Архивът още не е зареден.");
    const result = data.type === "query" ? archive.query(data.params) : archive.detail(data.key);
    self.postMessage({id: data.id, result});
  } catch (error) {
    self.postMessage({id: data.id, error: error.message});
  }
};
