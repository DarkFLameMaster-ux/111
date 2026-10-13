"""Resource editing regression tests using only isolated temporary media."""
import copy
import json
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import ProxyHandler, Request, build_opener

from catalog import Catalog, KINDS, path_key, versions, work_id
from runtime import install


class Fixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="reslib-catalog-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.first = self.root / "anime" / "edition-a"
        self.second = self.root / "anime" / "edition-b"
        self.video_a = self.file(self.first / "01.mkv", 10)
        self.video_b = self.file(self.second / "01.mkv", 20)
        self.audio = self.file(self.first / "CDs" / "track.flac", 5)
        self.subtitle = self.file(self.first / "01.en.srt", 3)
        a = {"path": str(self.video_a), "label": "01", "size": 10,
             "subs": {"sc": None, "tc": None, "other": [str(self.subtitle)]}}
        b = {"path": str(self.video_b), "label": "01", "size": 20,
             "subs": {"sc": None, "tc": None, "other": []}}
        audio = {"path": str(self.audio), "name": "track.flac", "size": 5}
        self.anime = {"kind": "anime", "bgm_id": 321, "title": "Synthetic anime",
                      "dir": str(self.first), "folder": str(self.first),
                      "source_dirs": [str(self.first), str(self.second)],
                      "episodes": [a, b], "extras": [], "other": [audio],
                      "groups": [{"label": "版本 1 · 正片", "episodes": [a], "resources": []},
                                 {"label": "版本 1 · CDs", "episodes": [], "resources": [audio]},
                                 {"label": "版本 2 · 正片", "episodes": [b], "resources": []}],
                      "loose_subs": [], "count": 2, "size": 38}
        self.music = {"kind": "music", "title": "Synthetic soundtrack", "embedded": True,
                      "dir": str(self.first), "tracks": [{"path": str(self.audio), "title": "track", "size": 5}],
                      "count": 1, "size": 5}
        self.novel_root = self.root / "novel" / "subcategory" / "work"
        self.books = [self.file(self.novel_root / "volume-1.epub", 11),
                      self.file(self.novel_root / "nested" / "volume-2.txt", 12)]
        self.novel = {"kind": "novel", "title": "Synthetic novel", "dir": str(self.novel_root),
                      "count": 2, "size": 23, "episodes": []}
        self.game_root = self.root / "game" / "work"
        self.game_files = [self.file(self.game_root / "game.exe", 13),
                           self.file(self.game_root / "data" / "asset.bin", 14)]
        self.game = {"kind": "game", "title": "Synthetic game", "dir": str(self.game_root),
                     "count": 2, "size": 27}
        self.comic_file = self.file(self.root / "comic" / "single.cbz", 7)
        self.comic = {"kind": "comic", "title": "Synthetic comic", "dir": str(self.comic_file),
                      "chapters": [{"path": str(self.comic_file), "label": "chapter", "size": 7}],
                      "count": 1, "size": 7}
        self.raw = {kind: [] for kind in KINDS}
        self.raw.update(anime=[self.anime], music=[self.music], novel=[self.novel],
                        game=[self.game], comic=[self.comic], stats={})
        self.metadata = {str(self.first): {"title": "Original", "summary": "Original summary", "date": "2020-01-01"},
                         str(self.second): {"title": "Original", "summary": "Original summary"}}

    def file(self, path, size):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x" * size)
        return path

    def fake_lib(self):
        def safe_path(value):
            candidate = Path(value)
            resolved = (candidate if candidate.is_absolute() else self.root / candidate).resolve()
            try:
                resolved.relative_to(self.root)
            except ValueError as exc:
                raise PermissionError("outside fixture") from exc
            return resolved

        def set_index(server, value):
            server.index = value
            lib.SERVER_INDEX = value

        lib = types.SimpleNamespace(
            LOG_DIR=self.root / "logs", Handler=FakeHandler,
            build_index=lambda: copy.deepcopy(self.raw), _set_server_index=set_index,
            _load_meta_cached=lambda: (None, copy.deepcopy(self.metadata)),
            load_settings=lambda: {}, load_progress=lambda: {},
            _start_background=lambda: None, safe_path=safe_path, SERVER_INDEX={},
            opds_novel_list=lambda: {"unfiltered": True},
            _entry=lambda title, uid, mtime, links, **kwargs: {"title": title, "links": links},
            _feed=lambda uid, title, href, entries, *args: {"entries": entries},
            _book_links=lambda path: [str(path)], uid_of=lambda path: str(path),
            _mtime=lambda path: 0, human=lambda size: str(size), ACQ_TYPE="application/atom+xml",
            pse_ok=lambda *args: False, _q=lambda value: value,
        )
        return lib

    def catalog(self, role="display"):
        catalog = Catalog(self.fake_lib(), role)
        catalog.build()
        return catalog


class CatalogTests(Fixture):
    def test_work_and_version_identity_survive_scan_order_and_title_edits(self):
        original_id = work_id("anime", self.anime)
        original_versions = {v["source_dir"]: v["id"] for v in versions(self.anime)}
        changed = copy.deepcopy(self.anime)
        changed.update(title="Renamed", dir=str(self.second),
                       source_dirs=[str(self.second), str(self.first)])
        self.assertEqual(work_id("anime", changed), original_id)
        self.assertEqual({v["source_dir"]: v["id"] for v in versions(changed)}, original_versions)
        self.assertNotEqual(versions(self.anime)[0]["id"], versions(self.music)[0]["id"])

    def test_work_edit_metadata_and_scan_persistence(self):
        c = self.catalog()
        c.update({"id": work_id("anime", self.anime), "title": "Edited title",
                  "summary": "Edited summary", "year": "2026"})
        projected = c.build()
        self.assertEqual(projected["anime"][0]["title"], "Edited title")
        metadata = c.metadata(projected)
        for root in (self.first, self.second):
            self.assertEqual(metadata[str(root)]["title_cn"], "Edited title")
            self.assertEqual(metadata[str(root)]["summary"], "Edited summary")
            self.assertEqual(metadata[str(root)]["date"], "2026")
        self.assertEqual(self.metadata[str(self.first)]["title"], "Original")
        self.assertTrue(self.video_a.is_file())

    def test_cross_service_sync_hiding_restore_and_soft_delete(self):
        manager, display = self.catalog("management"), self.catalog()
        server = types.SimpleNamespace(index=display.project())
        uid = work_id("anime", self.anime)
        for status in ("hidden", "deleted"):
            manager.update({"id": uid, "status": status})
            display.sync(server)
            self.assertEqual(server.index["anime"], [])
            self.assertEqual(server.index["music"], [])
            self.assertFalse(display.allowed(self.video_a))
            self.assertFalse(display.allowed(self.subtitle))
            self.assertTrue(self.video_a.is_file())
            self.assertEqual(manager.project()["anime"][0]["management"]["status"], status)
            manager.update({"id": uid, "status": "visible"})
            display.sync(server)
            self.assertEqual(len(server.index["anime"]), 1)
            self.assertTrue(display.allowed(self.video_a))

    def test_partial_version_selection_keeps_identity_and_recounts(self):
        c = self.catalog()
        detail = c.detail(uid=work_id("anime", self.anime))
        first, second = detail["versions"]
        c.update({"id": detail["id"], "versions": [{"id": first["id"], "status": "hidden"},
                                                    {"id": second["id"], "label": "Preferred edition"}]})
        projected = c.project()
        anime = projected["anime"][0]
        self.assertEqual(anime["source_dirs"], [str(self.second)])
        self.assertEqual(anime["dir"], str(self.second))
        self.assertEqual(anime["count"], 1)
        self.assertEqual(anime["size"], 20)
        self.assertEqual(anime["version_count"], 1)
        self.assertEqual(anime["groups"][0]["version_id"], second["id"])
        self.assertEqual(anime["groups"][0]["version_label"], "Preferred edition")
        self.assertEqual(projected["stats"]["anime_eps"], 1)
        self.assertEqual(projected["music"], [])
        self.assertFalse(c.allowed(self.video_a))
        self.assertFalse(c.allowed(self.subtitle))
        self.assertTrue(c.allowed(self.video_b))

    def test_single_item_edit_filters_groups_and_empty_work(self):
        c = self.catalog()
        uid = work_id("anime", self.anime)
        c.update({"id": uid, "items": [{"path": str(self.video_a), "status": "hidden"},
                                          {"path": str(self.video_b), "label": "Renamed episode"}]})
        anime = c.project()["anime"][0]
        self.assertEqual(anime["count"], 1)
        self.assertEqual(anime["size"], 25)
        self.assertEqual(anime["episodes"][0]["label"], "Renamed episode")
        self.assertFalse(c.allowed(self.video_a))
        c.update({"id": uid, "items": [{"path": str(self.video_b), "status": "deleted"},
                                         {"path": str(self.audio), "status": "hidden"}]})
        self.assertEqual(c.project()["anime"], [])
        self.assertTrue(self.video_b.exists())

    def test_embedded_music_hiding_does_not_hide_parent_video(self):
        c = self.catalog()
        uid = work_id("music", self.music)
        for change in ({"status": "hidden"},
                       {"status": "visible", "versions": [{"id": versions(self.music)[0]["id"], "status": "hidden"}]}):
            c.update(dict(id=uid, **change))
            projected = c.project()
            self.assertEqual(len(projected["anime"]), 1)
            self.assertEqual(projected["anime"][0]["count"], 2)
            self.assertEqual(projected["music"], [])
            self.assertTrue(c.allowed(self.video_a))
            self.assertFalse(c.allowed(self.audio))

    def test_other_subtitle_lists_keep_type_and_filter_hidden_parent(self):
        c = self.catalog()
        episode = c.project()["anime"][0]["episodes"][0]
        self.assertEqual(episode["subs"], {"sc": None, "tc": None, "other": [str(self.subtitle)]})
        c.update({"id": work_id("anime", self.anime), "versions": [
            {"id": versions(self.anime)[0]["id"], "status": "hidden"}]})
        self.assertFalse(c.allowed(self.subtitle))
        self.assertEqual(c.project()["anime"][0]["episodes"][0]["subs"]["other"], [])

    def test_novel_and_game_files_can_be_edited_and_recounted(self):
        c = self.catalog()
        for kind, work, files, key in (("novel", self.novel, self.books, "books"),
                                       ("game", self.game, self.game_files, "files")):
            with self.subTest(kind=kind):
                detail = c.detail(uid=work_id(kind, work))
                self.assertEqual({i["path"] for i in detail["versions"][0]["items"]}, {str(p) for p in files})
                c.update({"id": detail["id"], "items": [{"path": str(files[0]), "status": "hidden"}]})
                projected = c.project()[kind][0]
                self.assertEqual(projected["count"], 1)
                self.assertEqual(len(projected[key]), 1)
                self.assertEqual(projected["size"], files[1].stat().st_size)
                self.assertFalse(c.allowed(files[0]))
                self.assertTrue(c.allowed(files[1]))

    def test_single_file_work_does_not_block_sibling(self):
        sibling = self.file(self.comic_file.parent / "sibling.cbz", 4)
        c = self.catalog()
        c.update({"id": work_id("comic", self.comic), "status": "hidden"})
        self.assertFalse(c.allowed(self.comic_file))
        self.assertTrue(c.allowed(sibling))
        self.assertEqual(c.project()["comic"], [])

    def test_invalid_edit_is_atomic(self):
        c = self.catalog("management")
        uid = work_id("anime", self.anime)
        c.update({"id": uid, "title": "Saved title"})
        before = c.file.read_bytes()
        for bad in ({"id": "unknown", "title": "Rejected"},
                    {"id": uid, "title": "Rejected", "year": "20x6"},
                    {"id": uid, "title": "Rejected", "status": True},
                    {"id": uid, "unknown": "Rejected"},
                    {"id": uid, "versions": [{"id": "unknown", "status": "hidden"}]},
                    {"id": uid, "items": [{"path": str(self.root / "outside.mkv"), "status": "hidden"}]},
                    {"id": uid, "items": [{"path": str(self.video_a), "status": "hidden"},
                                            {"path": str(self.video_a), "status": "visible"}]}):
            with self.subTest(body=bad):
                with self.assertRaises(ValueError):
                    c.update(bad)
                self.assertEqual(c.file.read_bytes(), before)
                self.assertEqual(c.detail(uid=uid)["title"], "Saved title")

    def test_stats_track_all_visible_categories(self):
        c = self.catalog()
        initial = c.project()
        self.assertEqual(initial["stats"]["total_size"], 100)
        c.update({"id": work_id("comic", self.comic), "status": "deleted"})
        projected = c.project()
        self.assertEqual(projected["stats"]["comic_works"], 0)
        self.assertEqual(projected["stats"]["comic_chapters"], 0)
        self.assertEqual(projected["stats"]["total_size"], 93)

    def test_first_scrape_preserves_directory_edits_after_work_merge(self):
        self.anime.pop("bgm_id")
        c = self.catalog()
        c.update({"id": work_id("anime", self.anime), "title": "Manual title", "status": "hidden"})
        self.anime["bgm_id"] = 777
        self.assertEqual(c.build()["anime"], [])
        self.assertFalse(c.allowed(self.video_b))
        detail = c.detail(uid=work_id("anime", self.anime))
        self.assertEqual(detail["title"], "Manual title")
        c.update({"id": detail["id"], "status": "visible"})
        self.assertEqual(c.project()["anime"][0]["title"], "Manual title")

    def test_all_files_hidden_omit_empty_version_and_empty_source_work(self):
        c = self.catalog()
        detail = c.detail(uid=work_id("anime", self.anime))
        c.update({"id": detail["id"], "items": [{"path": item["path"], "status": "hidden"}
                                                   for item in detail["versions"][0]["items"]]})
        work = c.project()["anime"][0]
        self.assertEqual(work["version_count"], 1)
        self.assertEqual(work["dir"], str(self.second))
        self.raw["comic"] = [dict(self.comic, chapters=[], count=0)]
        self.assertEqual(c.build()["comic"], [])

    def test_merge_preserves_separate_source_statuses_and_updates_older_display_index(self):
        first = copy.deepcopy(self.anime)
        first.pop("bgm_id")
        first.pop("source_dirs")
        first["episodes"] = first["episodes"][:1]
        first["groups"] = first["groups"][:2]
        second = dict(first, dir=str(self.second), episodes=[copy.deepcopy(self.anime["episodes"][1])],
                      groups=[copy.deepcopy(self.anime["groups"][2])], other=[])
        self.raw["anime"] = [first, second]
        manager, display = self.catalog("management"), self.catalog()
        manager.update({"id": work_id("anime", first), "title": "Manual title A"})
        manager.update({"id": work_id("anime", second), "status": "hidden"})
        self.raw["anime"] = [self.anime]
        manager.build()
        merged = manager.detail(uid=work_id("anime", self.anime))
        self.assertEqual(merged["status"], "visible")
        self.assertEqual(merged["versions"][1]["status"], "hidden")
        self.assertFalse(manager.allowed(self.video_b))
        server = types.SimpleNamespace(index=display.project())
        manager.update({"id": merged["id"], "status": "hidden"})
        display.sync(server)
        self.assertEqual(server.index["anime"], [])
        self.assertFalse(display.allowed(self.video_a))
        self.assertFalse(display.allowed(self.video_b))
        manager.update({"id": merged["id"], "status": "visible", "title": "Latest merged title"})
        display.sync(server)
        self.assertTrue(display.allowed(self.video_a))
        self.assertTrue(display.allowed(self.video_b))
        self.assertTrue(all(w["title"] == "Latest merged title" for w in server.index["anime"]))

    def test_hidden_work_keeps_newly_discovered_version_hidden(self):
        c = self.catalog()
        c.update({"id": work_id("anime", self.anime), "status": "hidden"})
        third = self.file(self.root / "anime" / "edition-c" / "01.mkv", 8)
        self.anime["source_dirs"].append(str(third.parent))
        self.anime["episodes"].append({"path": str(third), "label": "01", "size": 8})
        self.assertEqual(c.build()["anime"], [])
        self.assertFalse(c.allowed(third))


class FakeHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _gate(self):
        return True

    def _json(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _read_json(self):
        return json.loads(self.rfile.read(int(self.headers["Content-Length"])))

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        if query.get("path"):
            self.server.lib.safe_path(query["path"][0])
        self._json(self.server.index if urlparse(self.path).path == "/api/library" else {"delegated": True})

    def do_POST(self):
        body = self._read_json()
        if body.get("path"):
            self.server.lib.safe_path(body["path"])
        self._json({"delegated": True})


class CatalogHTTPTests(Fixture):
    def serve(self, role):
        lib = self.fake_lib()
        handler = install(lib, role, self.root / "index.html", "9.0.0")
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.lib = lib
        lib._set_server_index(server, lib.build_index())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}", lib

    def request(self, url, route, body=None, method=None):
        request = Request(url + route, data=json.dumps(body).encode() if body is not None else None,
                          headers={"Content-Type": "application/json"}, method=method)
        try:
            response = build_opener(ProxyHandler({})).open(request)
        except HTTPError as exc:
            response = exc
        with response:
            content = response.read()
            return response.status, json.loads(content) if content else None

    def test_management_detail_save_display_reject_and_old_links(self):
        manager, _ = self.serve("management")
        display, _ = self.serve("display")
        query = urlencode({"kind": "anime", "dir": str(self.first)})
        code, detail = self.request(manager, "/api/resources?" + query)
        self.assertEqual(code, 200)
        uid = detail["resource"]["id"]
        self.assertEqual(self.request(manager, "/api/resources", {"id": uid, "status": "hidden"})[0], 200)
        for method, body in (("GET", None), ("HEAD", None), ("POST", {"id": uid, "status": "visible"})):
            self.assertEqual(self.request(display, "/api/resources?" + query, body, method)[0], 403)
        self.assertEqual(self.request(display, "/api/library")[1]["anime"], [])
        for route in ("/file", "/media", "/play", "/transcode", "/api/comic", "/api/comic/page",
                      "/api/cover", "/cover", "/opds/pse", "/api/sub", "/api/video", "/api/media-info"):
            for method in ("GET", "HEAD"):
                with self.subTest(route=route, method=method):
                    self.assertEqual(self.request(display, route + "?path=" + quote(str(self.video_a)), method=method)[0], 403)
        self.assertEqual(self.request(display, "/api/poster?" + urlencode({"dir": str(self.first)}))[0], 403)
        for route in ("/api/play", "/api/prepare"):
            self.assertEqual(self.request(display, route, {"path": str(self.video_a)})[0], 403)
        self.assertEqual(self.request(manager, "/file?path=" + quote(str(self.video_a)))[0], 200)
        self.assertEqual(self.request(manager, "/api/resources", {"id": uid, "status": "visible"})[0], 200)
        self.assertEqual(self.request(display, "/file?path=" + quote(str(self.video_a)))[0], 200)

    def test_opds_novels_and_search_use_projected_files(self):
        manager, _ = self.serve("management")
        display, lib = self.serve("display")
        self.assertEqual(len(lib.opds_novel_list()["entries"]), 2)
        self.assertEqual(len(lib.opds_search("Synthetic novel")["entries"]), 2)
        uid = work_id("novel", self.novel)
        self.assertEqual(self.request(manager, "/api/resources", {"id": uid, "items": [
            {"path": str(self.books[0]), "status": "hidden"}]})[0], 200)
        self.request(display, "/api/library")
        self.assertEqual(len(lib.opds_novel_list()["entries"]), 1)
        self.assertEqual(len(lib.opds_search("Synthetic novel")["entries"]), 1)
        self.assertEqual(self.request(manager, "/api/resources", {"id": uid, "status": "deleted"})[0], 200)
        self.request(display, "/api/library")
        self.assertEqual(lib.opds_novel_list()["entries"], [])
        self.assertEqual(lib.opds_search("Synthetic novel")["entries"], [])
        self.assertEqual(self.request(display, "/file?path=" + quote(str(self.books[1])))[0], 403)


if __name__ == "__main__":
    unittest.main()
