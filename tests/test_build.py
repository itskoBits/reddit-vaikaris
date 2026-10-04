import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from build import build_site


class BuildTests(unittest.TestCase):
    def test_build_is_complete_deterministic_and_versioned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            post = {"id": "p1", "created_utc": 1735689600, "title": "<script>Тест</script>", "selftext": "Дълъг текст " * 1000, "subreddit": "bulgaria", "score": -5}
            (root / "u_vaikaris_posts.jsonl").write_text(json.dumps(post))
            (root / "u_vaikaris_comments.jsonl").write_text("")
            output = root / "site"
            first = build_site(root, output)
            self.assertEqual(first, build_site(root, output))
            self.assertEqual(first["meta"]["total"], 1)
            self.assertTrue((output / ".nojekyll").exists())
            self.assertFalse((output / "u_vaikaris_posts.jsonl").exists())
            self.assertTrue(first["previews"]["post"]["items"][0]["truncated"])
            for chunk in first["chunks"]:
                payload = (output / chunk["url"]).read_bytes()
                self.assertEqual(len(payload), chunk["bytes"])
                self.assertEqual(hashlib.sha256(payload).hexdigest(), chunk["sha256"])
                rows = json.loads(gzip.decompress(payload))
                self.assertEqual(rows[0][4], post["selftext"])
                self.assertEqual(rows[0][3], post["title"])
            html = (output / "index.html").read_text()
            self.assertNotIn('href="/', html)
            self.assertNotIn('src="/', html)
            post["score"] = 42
            (root / "u_vaikaris_posts.jsonl").write_text(json.dumps(post))
            changed = build_site(root, output)
            self.assertNotEqual(first["version"], changed["version"])
            self.assertFalse((output / first["chunks"][0]["url"]).exists())

    def test_empty_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("posts", "comments"):
                (root / f"u_vaikaris_{name}.jsonl").write_text("")
            result = build_site(root, root / "site")
            self.assertEqual(result["chunks"], [])
            self.assertEqual(result["meta"]["total"], 0)
            self.assertEqual(result["previews"]["all"]["items"], [])
