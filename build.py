#!/usr/bin/env python3
"""Build a self-contained GitHub Pages site using only the Python standard library."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil

from archive import Archive, ROOT

CHUNK_SIZE = 3000
ASSETS = ("index.html", "styles.css", "app.js", "favicon.svg", "archive-client.js", "archive-core.mjs", "archive-worker.js")


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def build_site(source=ROOT, output=ROOT / "dist", chunk_size=CHUNK_SIZE):
    if chunk_size < 1:
        raise ValueError("chunk_size must be positive")
    output = Path(output).resolve()
    if output == Path(source).resolve() or output == ROOT / "web":
        raise ValueError("Build output must be separate from source files")
    archive = Archive(source)
    output.mkdir(parents=True, exist_ok=True)
    data_dir = output / "data"
    data_dir.mkdir(exist_ok=True)
    communities = [x["name"] for x in archive.meta["communities"]]
    authors = sorted({x["author"] for x in archive.items.values()})
    community_ids = {name: index for index, name in enumerate(communities)}
    author_ids = {name: index for index, name in enumerate(authors)}
    rows = []
    for item in archive.ordered["newest"]:
        # Positional schema is shared with archive-core.mjs. Dictionary encoding
        # avoids repeating community and author names in every record.
        rows.append([
            item["id"], community_ids[item["subreddit"]], author_ids[item["author"]],
            item["title"], item["body"], item["created"], item["score"], item["num_comments"],
            item["reddit_url"].removeprefix("https://www.reddit.com"), item["source_url"],
            item["link_id"], item["parent_id"], item["context"].strip(),
        ])
    chunks = []
    for start in range(0, len(rows), chunk_size):
        packed = gzip.compress(encode(rows[start:start + chunk_size]), compresslevel=9, mtime=0)
        digest = hashlib.sha256(packed).hexdigest()
        filename = f"archive-{digest[:20]}.json.gz"
        (data_dir / filename).write_bytes(packed)
        chunks.append({"url": f"data/{filename}", "bytes": len(packed), "sha256": digest, "count": len(rows[start:start + chunk_size])})
    manifest = {"schema": 1, "meta": archive.meta, "tables": {"communities": communities, "authors": authors}, "chunks": chunks}
    manifest["version"] = hashlib.sha256(encode(manifest)).hexdigest()[:20]
    manifest["download_bytes"] = sum(chunk["bytes"] for chunk in chunks)
    manifest["previews"] = {kind: archive.query({"type": kind}) for kind in ("all", "post", "comment")}
    # Write the manifest last, after every content-addressed chunk is in place.
    for filename in ASSETS:
        shutil.copyfile(ROOT / "web" / filename, output / filename)
    (output / ".nojekyll").write_text("")
    (output / "bootstrap.json").write_bytes(encode(manifest))
    keep = {Path(chunk["url"]).name for chunk in chunks}
    for stale in data_dir.glob("archive-*.json.gz"):
        if stale.name not in keep:
            stale.unlink()
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    manifest = build_site(output=args.output)
    print(f"Built {manifest['meta']['total']:,} records into {args.output}")
    print(f"Search archive: {manifest['download_bytes'] / 1_000_000:.2f} MB compressed in {len(manifest['chunks'])} chunks")
    print(f"First-page data: {(args.output / 'bootstrap.json').stat().st_size / 1000:.1f} KB")


if __name__ == "__main__":
    main()
