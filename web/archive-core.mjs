// Pure search engine, shared by the browser worker and the Node regression tests.
export const PAGE_SIZE = 20;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function searchTerms(query) {
  const text = String(query);
  if (!text.trim()) return [];
  const terms = text.trim().split(/\s+/);
  // Keep intentional outer spaces on the first and last search terms.
  // Internal separators retain the existing "all words, any order" behavior.
  terms[0] = text.match(/^\s*/)[0] + terms[0];
  terms[terms.length - 1] += text.match(/\s*$/)[0];
  return terms;
}

export class ArchiveIndex {
  constructor(rows, tables) {
    this.rows = rows;
    this.tables = tables;
    this.ids = new Map();
    this.search = new Array(rows.length);
    this.years = new Uint16Array(rows.length);
    rows.forEach((row, index) => {
      this.ids.set(row[0], index);
      this.search[index] = [row[3], row[4], tables.communities[row[1]], row[12]].join(" ").toLowerCase();
      this.years[index] = new Date(row[5] * 1000).getUTCFullYear();
    });
    const ids = Array.from(rows, (_, index) => index);
    const newest = (a, b) => rows[b][5] - rows[a][5] || compare(rows[b][0], rows[a][0]);
    this.ordered = {
      newest: ids.slice().sort(newest),
      oldest: ids.slice().sort((a, b) => -newest(a, b)),
      top: ids.slice().sort((a, b) => rows[b][6] - rows[a][6] || newest(a, b)),
      bottom: ids.slice().sort((a, b) => rows[a][6] - rows[b][6] || rows[b][5] - rows[a][5] || compare(rows[a][0], rows[b][0])),
    };
  }

  public(index, preview = false) {
    const row = this.rows[index];
    const item = {
      id: row[0], kind: row[0].startsWith("t3_") ? "post" : "comment",
      subreddit: this.tables.communities[row[1]], author: this.tables.authors[row[2]],
      title: row[3], body: preview ? row[4].slice(0, 900) : row[4],
      created: row[5], year: this.years[index], score: row[6], num_comments: row[7],
      reddit_url: row[8] ? `https://www.reddit.com${row[8]}` : "",
      source_url: row[9], link_id: row[10], parent_id: row[11], context: row[12],
    };
    if (preview) item.truncated = row[4].length > 900;
    return item;
  }

  query(params = {}) {
    const {type = "all", sort = "newest", subreddit = "", year = "", q = ""} = params;
    if (!["all", "post", "comment"].includes(type) || !Object.hasOwn(this.ordered, sort)) throw new Error("Невалиден филтър.");
    if (String(q).length > 500 || (year && !Number.isInteger(Number(year)))) throw new Error("Невалидни параметри за търсене.");
    const terms = searchTerms(q).map((term) => term.toLowerCase());
    const community = subreddit ? this.tables.communities.findIndex((name) => name.toLowerCase() === subreddit.toLowerCase()) : -1;
    const matches = [];
    for (const index of this.ordered[sort]) {
      const row = this.rows[index];
      if (type !== "all" && row[0].startsWith("t3_") !== (type === "post")) continue;
      if (year && this.years[index] !== Number(year)) continue;
      if (subreddit && row[1] !== community) continue;
      if (terms.every((term) => this.search[index].includes(term))) matches.push(index);
    }
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(params.page)) || 1));
    const start = (page - 1) * PAGE_SIZE;
    return {items: matches.slice(start, start + PAGE_SIZE).map((index) => this.public(index, true)), total: matches.length, page, pages, page_size: PAGE_SIZE};
  }

  detail(id) {
    const index = this.ids.get(id);
    if (index === undefined) throw new Error("Записът не е намерен.");
    const item = this.public(index);
    const parent = this.ids.get(item.parent_id);
    const post = this.ids.get(item.link_id);
    item.parent = parent === undefined ? null : this.public(parent);
    item.post = post === undefined ? null : this.public(post);
    return item;
  }
}
