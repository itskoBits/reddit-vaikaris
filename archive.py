"""Normalize the source archive for the static site build."""

from collections import Counter
from datetime import datetime, timezone
from html import unescape
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
PAGE_SIZE = 20


def safe_url(value):
    value = unescape(value or "")
    return value if urlsplit(value).scheme in ("http", "https") else ""


class Archive:
    def __init__(self, directory=ROOT):
        self.items = {}
        for kind, filename in (("post", "u_vaikaris_posts.jsonl"), ("comment", "u_vaikaris_comments.jsonl")):
            with (Path(directory) / filename).open(encoding="utf-8") as source:
                for line_number, line in enumerate(source, 1):
                    if not line.strip():
                        continue
                    try:
                        raw = json.loads(line)
                        created = int(float(raw["created_utc"]))
                        key = ("t3_" if kind == "post" else "t1_") + raw["id"]
                        permalink = raw.get("permalink", "")
                        reddit_url = "https://www.reddit.com" + permalink if permalink.startswith("/r/") else ""
                        self.items[key] = {
                            "id": key, "kind": kind, "author": raw.get("author", "Vaikaris"),
                            "subreddit": raw.get("subreddit", "unknown"),
                            "title": unescape(raw.get("title", "")),
                            "body": unescape(raw.get("selftext" if kind == "post" else "body", "") or "").replace("\u200b", ""),
                            "created": created,
                            "year": datetime.fromtimestamp(created, timezone.utc).year,
                            "score": raw.get("score", 0) or 0,
                            "num_comments": raw.get("num_comments", 0) or 0,
                            "reddit_url": reddit_url,
                            "source_url": safe_url(raw.get("url", "")) if kind == "post" else "",
                            "link_id": raw.get("link_id", ""), "parent_id": raw.get("parent_id", ""),
                            "permalink": permalink,
                        }
                    except (ValueError, KeyError, TypeError) as error:
                        raise ValueError(f"{filename}, line {line_number}: {error}") from error
        for item in self.items.values():
            post = self.items.get(item["link_id"])
            parts = item["permalink"].split("/")
            item["context"] = post["title"] if post else (unquote(parts[5]).replace("_", " ") if len(parts) > 5 and item["kind"] == "comment" else "")
            item["_search"] = " ".join((item["title"], item["body"], item["subreddit"], item["context"])).casefold()
        values = list(self.items.values())
        self.ordered = {
            "newest": sorted(values, key=lambda x: (x["created"], x["id"]), reverse=True),
            "oldest": sorted(values, key=lambda x: (x["created"], x["id"])),
            "top": sorted(values, key=lambda x: (x["score"], x["created"], x["id"]), reverse=True),
            "bottom": sorted(values, key=lambda x: (x["score"], -x["created"], x["id"])),
        }
        counts = Counter(x["kind"] for x in values)
        communities = Counter(x["subreddit"] for x in values)
        self.meta = {
            "total": len(values), "comments": counts["comment"], "posts": counts["post"],
            "communities": [{"name": name, "count": count} for name, count in communities.most_common()],
            "years": sorted({x["year"] for x in values}, reverse=True),
            "first": min((x["created"] for x in values), default=0),
            "last": max((x["created"] for x in values), default=0),
        }

    @staticmethod
    def public(item, preview=False):
        result = {k: v for k, v in item.items() if not k.startswith("_") and k != "permalink"}
        if preview:
            result["truncated"] = len(result["body"]) > 900
            result["body"] = result["body"][:900]
        return result

    def query(self, params):
        kind = params.get("type", "all")
        sort = params.get("sort", "newest")
        year = params.get("year", "")
        query = params.get("q", "").strip()
        subreddit = params.get("subreddit", "")
        if kind not in ("all", "post", "comment") or sort not in self.ordered:
            raise ValueError("Невалиден филтър.")
        if len(query) > 500:
            raise ValueError("Търсенето е ограничено до 500 символа.")
        year = int(year) if year else None
        page = max(1, int(params.get("page", "1")))
        terms = query.casefold().split()
        matches = [x for x in self.ordered[sort]
                   if (kind == "all" or x["kind"] == kind)
                   and (not year or x["year"] == year)
                   and (not subreddit or x["subreddit"].casefold() == subreddit.casefold())
                   and all(term in x["_search"] for term in terms)]
        pages = max(1, (len(matches) + PAGE_SIZE - 1) // PAGE_SIZE)
        page = min(page, pages)
        start = (page - 1) * PAGE_SIZE
        return {"items": [self.public(x, preview=True) for x in matches[start:start + PAGE_SIZE]],
                "total": len(matches), "page": page, "pages": pages, "page_size": PAGE_SIZE}

    def detail(self, key):
        item = self.items.get(key)
        if not item:
            return None
        result = self.public(item)
        result["parent"] = self.public(self.items[item["parent_id"]]) if item["parent_id"] in self.items else None
        result["post"] = self.public(self.items[item["link_id"]]) if item["link_id"] in self.items else None
        return result
