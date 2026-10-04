import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {ArchiveIndex} from "../web/archive-core.mjs";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);
const manifest = JSON.parse(readFileSync(new URL("bootstrap.json", dist)));
const rows = manifest.chunks.flatMap((chunk) => {
  const bytes = readFileSync(new URL(chunk.url, dist));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), chunk.sha256);
  assert.equal(bytes.length, chunk.bytes);
  const rows = JSON.parse(gunzipSync(bytes));
  assert.equal(rows.length, chunk.count);
  return rows;
});
const index = new ArchiveIndex(rows, manifest.tables);

test("built archive contains every unique record, preserves previews and full text", () => {
  assert.equal(rows.length, manifest.meta.total);
  assert.equal(new Set(rows.map((row) => row[0])).size, rows.length);
  for (const type of ["all", "post", "comment"]) {
    const page = index.query({type});
    assert.equal(page.total, manifest.previews[type].total);
    assert.deepEqual(page.items.map((x) => x.id), manifest.previews[type].items.map((x) => x.id));
  }
  const long = rows.find((row) => row[4].length > 1000);
  assert.equal(index.detail(long[0]).body, long[4]);
  assert.equal(index.public(index.ids.get(long[0]), true).body.length, 900);
  assert.throws(() => index.detail("missing"), /не е намерен/);
});

test("search, Cyrillic, literal punctuation, sorting and pagination match the Python reference", () => {
  const cases = [
    ...["all", "post", "comment"].flatMap((type) => ["newest", "oldest", "top", "bottom"].map((sort) => ({type, sort, page: 2}))),
    {q: "БЪЛГАРИЯ", year: "2025", sort: "top"}, {q: "роди", sort: "oldest"},
    {q: 'роди "', sort: "oldest"}, {q: "евро България", type: "comment"},
    {q: "[", sort: "bottom"}, {q: "несъществуващазаявка123456"},
    {subreddit: "bulgaria", type: "post", year: "2023"}, {subreddit: "missing"},
    {page: 999999}, {type: "post", page: -5},
  ];
  const reference = spawnSync("python3", ["-c", `
import json, sys
from archive import Archive
a = Archive()
results = []
for params in json.load(sys.stdin):
    result = a.query(params)
    result['items'] = [x['id'] for x in result['items']]
    results.append(result)
print(json.dumps(results))
`], {cwd: root, input: JSON.stringify(cases), encoding: "utf8"});
  assert.equal(reference.status, 0, reference.stderr);
  const expected = JSON.parse(reference.stdout);
  cases.forEach((params, n) => {
    const actual = index.query(params);
    actual.items = actual.items.map((item) => item.id);
    assert.deepEqual(actual, expected[n], JSON.stringify(params));
  });
});

test("linked post and parent navigation preserve real archive records", () => {
  const row = rows.find((row) => index.ids.has(row[10]) && index.ids.has(row[11]) && row[10] !== row[11]);
  assert.ok(row);
  const item = index.detail(row[0]);
  assert.equal(item.post.id, row[10]);
  assert.equal(item.parent.id, row[11]);
  assert.equal(item.post.body, rows[index.ids.get(row[10])][4]);
  assert.equal(item.parent.body, rows[index.ids.get(row[11])][4]);
});

// Exercise the actual browser worker, including gzip decoding and cache behavior.
const cacheStores = new Map();
const messages = [];
let downloads = 0, failNetwork = false, failStorage = false;
globalThis.self = {location: {href: "https://example.test/reddit-vaikaris/archive-worker.js"}, postMessage: (message) => messages.push(message)};
globalThis.caches = {
  async open(name) {
    if (failStorage) throw new Error("Storage unavailable");
    if (!cacheStores.has(name)) cacheStores.set(name, new Map());
    const store = cacheStores.get(name);
    return {
      async match(url) { return store.get(url)?.clone(); },
      async put(url, response) { store.set(url, response.clone()); },
      async delete(url) { return store.delete(url); },
    };
  },
  async keys() { return [...cacheStores.keys()]; },
  async delete(name) { return cacheStores.delete(name); },
};
globalThis.fetch = async (url) => {
  if (failNetwork) throw new Error("Offline");
  const path = new URL(url).pathname;
  assert.ok(path.startsWith("/reddit-vaikaris/data/"), "Chunk URLs must retain the Pages repository prefix");
  downloads++;
  return new Response(readFileSync(new URL(path.slice("/reddit-vaikaris/".length), dist)));
};
await import("../web/archive-worker.js");

async function loadWorker(id) {
  await self.onmessage({data: {type: "init", manifest}});
  await self.onmessage({data: {id, type: "query", params: {q: "роди", sort: "oldest"}}});
  return messages.findLast((message) => message.id === id);
}

test("worker loads at a project subpath, then reuses cached chunks with zero downloads", async () => {
  const first = await loadWorker(1);
  assert.equal(first.result.total, index.query({q: "роди"}).total);
  assert.equal(downloads, manifest.chunks.length);
  downloads = 0;
  failNetwork = true;
  const cached = await loadWorker(2);
  assert.equal(cached.result.total, first.result.total);
  assert.equal(downloads, 0);
  assert.equal(messages.findLast((message) => message.state === "ready").cached, manifest.chunks.length);
  failNetwork = false;
});

test("worker repairs a corrupt cached chunk and removes only its own old cache", async () => {
  const cacheName = `reddit-archive:/reddit-vaikaris/:${manifest.version}`;
  const key = `https://example.test/reddit-vaikaris/${manifest.chunks[0].url}`;
  cacheStores.get(cacheName).set(key, new Response("broken"));
  cacheStores.set("reddit-archive:/reddit-vaikaris/:old", new Map());
  cacheStores.set("another-project", new Map());
  downloads = 0;
  const result = await loadWorker(3);
  assert.ok(result.result);
  assert.equal(downloads, 1);
  assert.ok(!cacheStores.has("reddit-archive:/reddit-vaikaris/:old"));
  assert.ok(cacheStores.has("another-project"));
});

test("worker reports network failure and recovers even when persistent storage is blocked", async () => {
  failStorage = true;
  failNetwork = true;
  const failed = await loadWorker(4);
  assert.ok(failed.error);
  assert.ok(messages.find((message) => message.state === "error"));
  failNetwork = false;
  downloads = 0;
  const retried = await loadWorker(5);
  assert.ok(retried.result);
  assert.equal(downloads, manifest.chunks.length);
  failStorage = false;
});
