"""Role boundary around the existing resource pipeline; no media is bundled."""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from catalog import Catalog, KINDS

APP_ROOT = Path(__file__).resolve().parent.parent
READ_API = {
    "/api/library", "/api/extras", "/api/poster", "/api/progress",
    "/api/cover", "/api/comic", "/api/comic/page", "/api/sub",
    "/api/video", "/api/media-info", "/api/music-info", "/api/stop",
}
PLAYBACK_POST = {"/api/login", "/api/logout", "/api/prepare", "/api/play", "/api/progress"}


def configured_path(name, fallback):
    candidate = Path(os.environ[name]).expanduser() if os.environ.get(name) else fallback
    return candidate if candidate.is_absolute() else (APP_ROOT / candidate).resolve()


def source_slug(value):
    """Accept an existing supported provider's public work URL or its slug."""
    value = str(value or "").strip()
    if not value:
        return None
    if "://" in value:
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"www.baozimh.com", "baozimh.com"}:
            raise ValueError("目前订阅管线支持包子漫画作品链接")
        match = re.fullmatch(r"/comic/([^/]+)/?", parsed.path)
        if not match:
            raise ValueError("请填写包子漫画作品页链接（/comic/…）")
        value = unquote(match[1])
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("订阅来源标识格式不正确")
    return value


def category_catalog(index, archive_dirs, novel_subcategories):
    """管理目录、统计和归档选项共用原管线的分类定义。"""
    categories = []
    for kind, label in (("anime", "动画"), ("movie", "电影"), ("comic", "漫画"),
                        ("manhwa", "韩漫"), ("novel", "小说"), ("music", "音乐"),
                        ("game", "游戏"), ("sleep", "助眠"), ("av", "AV")):
        if label not in archive_dirs:
            continue
        works = index.get(kind, [])
        entry = {"id": kind, "kind": kind, "label": label, "count": len(works),
                 "items": sum(w.get("count", 0) for w in works),
                 "size": sum(w.get("size", 0) for w in works), "children": []}
        if kind == "novel":
            for subcategory in novel_subcategories:
                subset = [w for w in works if w.get("subcategory") == subcategory]
                entry["children"].append({"id": f"novel/{subcategory}", "kind": kind,
                                          "label": subcategory, "subcategory": subcategory,
                                          "count": len(subset)})
        categories.append(entry)
    archive = [{"value": label, "label": label} for label in archive_dirs]
    archive += [{"value": f"小说/{label}", "label": f"小说 / {label}"}
                for label in novel_subcategories]
    return {"categories": categories, "archive_categories": archive}


def install(lib, role, frontend, version):
    """Install once in a dedicated service process. Tests inject a fake pipeline."""
    base = lib.Handler
    index_lock = threading.Lock()
    prefs_lock = threading.Lock()
    preference_file = lib.LOG_DIR / "playback-preferences.json"
    links_file = lib.LOG_DIR / "access-links.json"
    lib.UI_FILE = frontend
    catalog = Catalog(lib, role)
    lib.build_index = catalog.build
    if role == "display" and hasattr(lib, "safe_path"):
        original_safe_path = lib.safe_path

        def visible_path(value):
            path = original_safe_path(value)
            if not catalog.allowed(path):
                raise PermissionError("该资源已隐藏或从目录删除")
            return path

        lib.safe_path = visible_path

    if role == "display" and hasattr(lib, "opds_novel_list"):
        def novel_entries(query=None):
            entries = []
            for work in lib.SERVER_INDEX.get("novel", []):
                for book in work.get("books", []):
                    path = Path(book["path"])
                    if query and query not in (work["title"] + " " + book["label"]).lower():
                        continue
                    entries.append(lib._entry(work["title"] + " · " + book["label"], lib.uid_of(path),
                                              lib._mtime(path), lib._book_links(path),
                                              content=lib.human(book.get("size", 0))))
            return entries

        def novel_feed():
            return lib._feed("urn:reslib:nav:novel", "小说", "/opds/novel", novel_entries(), lib.ACQ_TYPE)

        def search_feed(query):
            from urllib.parse import quote
            keyword = str(query or "").strip().lower()
            entries = []
            if keyword:
                for kind in ("comic", "manhwa"):
                    for work in lib.SERVER_INDEX.get(kind, []):
                        for chapter in work.get("chapters", []):
                            if keyword not in (work["title"] + " " + chapter["label"]).lower():
                                continue
                            path = Path(chapter["path"])
                            links = lib._book_links(path)
                            if lib.pse_ok(path, chapter):
                                links.append(("http://vaemendis.net/opds-pse/stream",
                                              f"/opds/pse?path={quote(str(path))}&page={{pageNumber}}", "image/jpeg",
                                              f'pse:count={lib._q(str(chapter["pages"]))}'))
                            entries.append(lib._entry(work["title"] + " · " + chapter["label"], lib.uid_of(path),
                                                      lib._mtime(path), links, content=lib.human(chapter["size"])))
                entries.extend(novel_entries(keyword))
            return lib._feed("urn:reslib:search:" + quote(query), "搜索：" + query,
                             "/opds/search", entries[:200], lib.ACQ_TYPE)

        lib.opds_novel_list, lib.opds_search = novel_feed, search_feed

    def links():
        display = os.environ.get("RESLIB_PUBLIC_DISPLAY_URL", "http://127.0.0.1:8777")
        try:
            display = json.loads(links_file.read_text(encoding="utf-8"))["display"]
        except (OSError, ValueError, KeyError):
            pass
        display = display.rstrip("/")
        return {"display": display + "/", "opds": display + "/opds"}

    def preferences():
        try:
            return json.loads(preference_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"anime_version_preferences": lib.load_settings().get("anime_version_preferences", {})}

    class Handler(base):
        def _read_json(self):
            body = super()._read_json()
            if role == "display" and isinstance(body, dict) and body.get("path") and not catalog.allowed(body["path"]):
                raise PermissionError("该资源已隐藏或从目录删除")
            return body

        def _gate(self):
            if not super()._gate():
                return False
            if role == "management":
                origin = self.headers.get("Origin")
                allowed = os.environ.get("RESLIB_MANAGEMENT_ORIGIN", "")
                own = f"{'https' if hasattr(self.connection, 'cipher') else 'http'}://{self.headers.get('Host', '')}"
                if origin and origin not in {own, allowed}:
                    self._json({"error": "管理接口只接受管理页面的请求"}, 403)
                    return False
            return True

        def do_GET(self):
            if not self._gate():
                return
            url = urlparse(self.path)
            route = url.path
            try:
                catalog.sync(self.server)
                if route == "/api/service":
                    self._json({"application": "moonshadow-reslib", "role": role, "version": version})
                    return
                if route == "/version.json":
                    self._bytes((frontend.parent / "version.json").read_bytes(), "application/json")
                    return
                if role == "display":
                    if route == "/api/preferences":
                        self._json(preferences())
                        return
                    if route.startswith("/api/") and route not in READ_API:
                        self._json({"error": "此功能已移至资源管理程序"}, 403)
                        return
                    if route == "/api/extras":
                        self._json({"meta": catalog.metadata(self.server.index)})
                        return
                    if route == "/api/progress":
                        self._json({path: value for path, value in lib.load_progress().items() if catalog.allowed(path)})
                        return
                    if route == "/api/poster":
                        directory = parse_qs(url.query).get("dir", [""])[0]
                        if directory and not catalog.allowed(directory):
                            raise PermissionError("该资源已隐藏或从目录删除")
                if route in {"/api/library", "/api/categories"}:
                    with index_lock:
                        last = getattr(self.server, "reslib_index_at", 0)
                        if time.monotonic() - last > 30 or "refresh" in parse_qs(url.query):
                            lib._set_server_index(self.server, lib.build_index())
                            self.server.reslib_index_at = time.monotonic()
                if role == "management":
                    if route == "/api/resources":
                        query = parse_qs(url.query)
                        with index_lock:
                            if not catalog.raw:
                                lib._set_server_index(self.server, lib.build_index())
                        self._json({"resource": catalog.detail(query.get("kind", [None])[0], query.get("dir", [None])[0])})
                        return
                    if route == "/api/extras":
                        import subscribe
                        self._json({"meta": catalog.metadata(self.server.index), "subs": subscribe.load_subs()})
                        return
                    if route == "/api/categories":
                        import classify
                        self._json(category_catalog(self.server.index, classify.CATEGORY_DIRS,
                                                    classify.NOVEL_SUBCATEGORIES))
                        return
                    if route in {"/api/subscriptions", "/api/subs"}:
                        import subscribe
                        self._json({"subscriptions": subscribe.load_subs()})
                        return
                    if route == "/api/links":
                        self._json(links())
                        return
                super().do_GET()
            except (ValueError, TypeError) as exc:
                self._json({"error": str(exc)}, 400)
            except PermissionError as exc:
                self._json({"error": str(exc)}, 403)
            except Exception as exc:
                self._json({"error": str(exc)}, 500)

        def do_POST(self):
            if not self._gate():
                return
            route = urlparse(self.path).path
            try:
                catalog.sync(self.server)
                if role == "display":
                    if route == "/api/preferences":
                        body = self._read_json()
                        if not isinstance(body, dict) or set(body) != {"anime_version_preferences"}:
                            raise ValueError("只接受播放版本偏好")
                        values = body["anime_version_preferences"]
                        if not isinstance(values, dict) or any(not isinstance(v, str) for v in values.values()):
                            raise ValueError("播放版本偏好格式错误")
                        with prefs_lock:
                            preference_file.parent.mkdir(parents=True, exist_ok=True)
                            temp = preference_file.with_suffix(".tmp")
                            temp.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
                            temp.replace(preference_file)
                        self._json(body)
                        return
                    if route not in PLAYBACK_POST:
                        self._json({"error": "此功能已移至资源管理程序"}, 403)
                        return
                if role == "management" and route == "/api/subscriptions":
                    self._subscription()
                    return
                if role == "management" and route == "/api/resources":
                    with index_lock:
                        if not catalog.raw:
                            lib._set_server_index(self.server, lib.build_index())
                        resource = catalog.update(self._read_json())
                        lib._set_server_index(self.server, catalog.project())
                    self._json({"ok": True, "resource": resource})
                    return
                if role == "management" and route == "/api/links":
                    display = str(self._read_json().get("display", "")).strip()
                    parsed = urlparse(display)
                    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                            or parsed.username or parsed.password or parsed.query or parsed.fragment
                            or parsed.path not in {"", "/"}):
                        raise ValueError("请填写完整的电脑访问地址，例如 http://192.168.1.10:8777")
                    # Accessing .port also validates malformed/out-of-range ports.
                    parsed.port
                    with prefs_lock:
                        links_file.parent.mkdir(parents=True, exist_ok=True)
                        temp = links_file.with_suffix(".tmp")
                        temp.write_text(json.dumps({"display": display.rstrip("/")}), encoding="utf-8")
                        temp.replace(links_file)
                    self._json(links())
                    return
                super().do_POST()
            except (ValueError, TypeError) as exc:
                self._json({"error": str(exc)}, 400)
            except PermissionError as exc:
                self._json({"error": str(exc)}, 403)
            except Exception as exc:
                self._json({"error": str(exc)}, 500)

        def _subscription(self):
            import subscribe
            body = self._read_json()
            action = body.get("action")
            name = str(body.get("name") or "").strip()
            subs = subscribe.load_subs()
            if action == "search":
                self._json({"items": subscribe.baozimh_search(str(body.get("q") or name))})
                return
            if action == "check":
                result = subscribe.check_all(download=bool(body.get("download", False)), only=name or None, verbose=False)
                self._json({"ok": True, "result": result})
                return
            if not name:
                raise ValueError("请填写作品名称")
            if action == "add":
                if name in subs:
                    raise ValueError("该作品已订阅，请使用修改来源以保留更新进度")
                result = subscribe.add_sub(name, slug=source_slug(body.get("source_url") or body.get("slug")),
                                           auto_download=bool(body.get("auto_download", True)), verbose=False)
                if not result:
                    raise ValueError("未找到可信来源，请搜索或填写作品链接")
                self._json({"ok": True, "subscription": result})
                return
            if name not in subs:
                self._json({"error": "订阅不存在"}, 404)
                return
            if action == "update":
                slug = source_slug(body.get("source_url") or body.get("slug"))
                if not slug:
                    raise ValueError("请填写订阅来源")
                subs[name]["slug"] = slug
                subs[name]["source"] = "baozimh"
            elif action == "toggle":
                for key in ("enabled", "auto_download"):
                    if key in body:
                        subs[name][key] = bool(body[key])
            elif action == "remove":
                del subs[name]
            else:
                raise ValueError("未知订阅操作")
            subscribe.save_subs(subs)
            self._json({"ok": True})

    lib.Handler = Handler
    if role == "display":
        lib._start_background = lambda: None
    return Handler


def main(role):
    script_dir = configured_path("RESLIB_SCRIPT_DIR", APP_ROOT.parent / "_归档脚本")
    sys.path.insert(0, str(script_dir))
    import lib
    from display.compat import prepare
    prepare(lib, os.environ.get("RESLIB_CORS_ORIGIN", "*"))
    management = role == "management"
    frontend = configured_path("RESLIB_MANAGEMENT_DIST" if management else "RESLIB_DISPLAY_DIST",
                               APP_ROOT / "frontend" / ("subscription" if management else "display") / "dist" / "index.html")
    version = json.loads((APP_ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    install(lib, role, frontend, version)
    host = os.environ.get("RESLIB_SUB_HOST" if management else "RESLIB_HOST", "127.0.0.1" if management else "0.0.0.0")
    port = os.environ.get("RESLIB_SUB_PORT" if management else "RESLIB_PORT", "8781" if management else "8777")
    tls_port = "0" if management else os.environ.get("RESLIB_TLS_PORT", "0")
    if tls_port == "0":
        lib.TLS_PORT_DEFAULT = 0
    sys.argv = ["lib.py", "serve", "--host", host, "--port", port, "--tls-port", tls_port]
    return lib.main()
