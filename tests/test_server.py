import json
from pathlib import Path
import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen

from archive import Archive
from build import build_site
from server import StaticHandler


class ArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        root = Path(cls.directory.name)
        posts = [{"id": "post1", "title": "България и Европа", "selftext": "Евро &amp; лев",
                  "created_utc": 1735689600, "score": 30, "subreddit": "bulgaria",
                  "url": "javascript:alert(1)", "permalink": "/r/bulgaria/comments/post1/topic/"}]
        comments = [{"id": str(i), "body": "ТЕСТ България" if i % 2 else "Another comment",
                     "created_utc": 1704067200 + i, "score": i - 10,
                     "subreddit": "bulgaria" if i % 2 else "europe", "link_id": "t3_post1",
                     "parent_id": "t1_1" if i == 3 else "t3_post1"} for i in range(25)]
        for filename, rows in (("u_vaikaris_posts.jsonl", posts), ("u_vaikaris_comments.jsonl", comments)):
            (root / filename).write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
        cls.archive = Archive(root)
        cls.output = root / "site"
        cls.manifest = build_site(root, cls.output, chunk_size=10)
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), partial(StaticHandler, directory=str(cls.output)))
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.http.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        cls.directory.cleanup()

    def test_totals_and_pagination(self):
        self.assertEqual(self.archive.meta["total"], 26)
        page = self.archive.query({})
        self.assertEqual((len(page["items"]), page["pages"]), (20, 2))
        last = self.archive.query({"page": "999"})
        self.assertEqual((last["page"], len(last["items"])), (2, 6))
        self.assertTrue(set(x["id"] for x in page["items"]).isdisjoint(x["id"] for x in last["items"]))

    def test_combined_cyrillic_search(self):
        result = self.archive.query({"q": "тест БЪЛГАРИЯ", "type": "comment", "year": "2024", "subreddit": "bulgaria"})
        self.assertEqual(result["total"], 12)
        self.assertEqual(self.archive.query({"q": "does-not-exist"})["total"], 0)
        self.assertEqual(self.archive.query({"type": "post", "year": "2024"})["total"], 0)

    def test_sorting_and_negative_scores(self):
        top = self.archive.query({"sort": "top"})
        bottom = self.archive.query({"sort": "bottom"})
        oldest = self.archive.query({"sort": "oldest"})
        self.assertEqual(top["items"][0]["score"], 30)
        self.assertEqual(bottom["items"][0]["score"], -10)
        self.assertEqual(oldest["items"][0]["id"], "t1_0")

    def test_context_and_safe_data(self):
        detail = self.archive.detail("t1_3")
        self.assertEqual(detail["context"], "България и Европа")
        self.assertEqual(detail["parent"]["id"], "t1_1")
        self.assertEqual(detail["post"]["source_url"], "")
        self.assertEqual(detail["post"]["body"], "Евро & лев")
        self.assertNotIn("_search", detail)

    def test_preview_and_full_body(self):
        item = {**self.archive.items["t1_1"], "body": "Дълъг текст " * 1000}
        self.assertEqual(len(self.archive.public(item, preview=True)["body"]), 900)
        self.assertTrue(self.archive.public(item, preview=True)["truncated"])
        self.assertEqual(self.archive.public(item)["body"], item["body"])

    def test_invalid_filters(self):
        for params in ({"sort": "invalid"}, {"type": "bad"}, {"year": "NaN"}, {"page": "no"}, {"q": "x" * 501}):
            with self.subTest(params=params), self.assertRaises(ValueError):
                self.archive.query(params)

    def test_http_routes_and_file_isolation(self):
        with urlopen(self.base + "/bootstrap.json") as response:
            self.assertEqual(json.load(response)["meta"]["total"], 26)
        with urlopen(self.base + "/") as response:
            self.assertEqual(response.status, 200)
            self.assertIn("text/html", response.headers["Content-Type"])
        with urlopen(self.base + "/" + self.manifest["chunks"][0]["url"]) as response:
            self.assertIn("immutable", response.headers["Cache-Control"])
            self.assertIsNone(response.headers.get("Content-Encoding"))
        for path, status in (("/api/items", 404), ("/data/", 404), ("/u_vaikaris_comments.jsonl", 404), ("/../server.py", 404)):
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                urlopen(self.base + path)
            self.assertEqual(error.exception.code, status)
            error.exception.close()


if __name__ == "__main__":
    unittest.main()
