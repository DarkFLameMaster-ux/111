"""Persistent display edits over the pipeline index; source media is never modified."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
from functools import wraps
from pathlib import Path

KINDS = ("anime", "movie", "comic", "manhwa", "novel", "music", "game", "sleep", "av")
STATUSES = {"visible", "hidden", "deleted"}
ITEM_KEYS = ("episodes", "extras", "chapters", "tracks", "other", "books", "files", "subtitles")
_PATH_CACHE = threading.local()
_PATH_CACHE_LIMIT = 8192


def cached_paths(operation):
    """Reuse real path resolution within one operation, including nested calls."""
    @wraps(operation)
    def scoped(*args, **kwargs):
        if getattr(_PATH_CACHE, "values", None) is not None:
            return operation(*args, **kwargs)
        _PATH_CACHE.values = {}
        try:
            return operation(*args, **kwargs)
        finally:
            del _PATH_CACHE.values
    return scoped


def path_key(value):
    if not value:
        return ""
    key = os.fspath(value)
    cache = getattr(_PATH_CACHE, "values", None)
    if cache is not None and key in cache:
        return cache[key]
    resolved = os.path.normcase(str(Path(value).resolve()))
    if cache is not None and len(cache) < _PATH_CACHE_LIMIT:
        cache[key] = resolved
    return resolved


def below(path, root):
    try:
        Path(path_key(path)).relative_to(Path(path_key(root)))
        return bool(path and root)
    except ValueError:
        return False


def identifier(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def work_id(kind, work):
    identity = "bgm:" + str(work["bgm_id"]) if kind == "anime" and work.get("bgm_id") else path_key(work.get("dir"))
    return identifier(kind + ":" + identity)


def records(work):
    unique = {}
    for key in ITEM_KEYS:
        for item in work.get(key, []):
            if item.get("path"):
                unique[path_key(item["path"])] = item
    for group in work.get("groups", []):
        for item in group.get("episodes", []) + group.get("resources", []):
            if item.get("path"):
                unique[path_key(item["path"])] = item
    return list(unique.values())


def subtitle_paths(item):
    paths = []
    for value in item.get("subs", {}).values():
        paths.extend(value if isinstance(value, list) else [value] if value else [])
    return paths


def versions(work):
    roots = work.get("source_dirs") or [work.get("dir", "")]
    result = []
    all_items = records(work)
    for number, root in enumerate(roots, 1):
        items = [item for item in all_items if below(item["path"], root) or below(item.get("owner", ""), root)]
        result.append({"id": identifier(work.get("kind", "") + ":" + path_key(root)), "label": "版本 " + str(number),
                       "source_dir": root, "number": str(number), "count": len(items),
                       "size": sum(item.get("size", 0) for item in items), "items": items})
    return result


class Catalog:
    def __init__(self, lib, role):
        self.lib, self.role = lib, role
        self.file = lib.LOG_DIR / "resource-catalog.json"
        self.lock = threading.RLock()
        self.stamp = None
        self.state = {"schema": 1, "works": {}, "versions": {}, "items": {}, "sources": {}}
        self.raw = {}
        self.blocked_cache = None
        self.scan = lib.build_index

    def _stamp(self):
        try:
            stat = self.file.stat()
            return (stat.st_mtime_ns, stat.st_size)
        except FileNotFoundError:
            return (0, 0)

    def load(self):
        stamp = self._stamp()
        if stamp != self.stamp:
            state = json.loads(self.file.read_text(encoding="utf-8")) if stamp != (0, 0) else {
                "schema": 1, "works": {}, "versions": {}, "items": {}, "sources": {}}
            if (not isinstance(state, dict) or state.get("schema") != 1 or
                    any(not isinstance(state.get(key), dict) for key in ("works", "versions", "items"))):
                raise ValueError("资源展示配置损坏，请恢复配置文件")
            state.setdefault("sources", {})
            if not isinstance(state["sources"], dict):
                raise ValueError("资源展示配置损坏，请恢复配置文件")
            self.state, self.stamp = state, stamp
            self.blocked_cache = None
        return self.state

    @cached_paths
    def build(self):
        with self.lock:
            self.raw = self.scan()
            for kind in KINDS:
                for work in self.raw.get(kind, []):
                    subtitles = {}
                    for item in records(work):
                        for value in subtitle_paths(item):
                            path = Path(value)
                            if path.is_file():
                                subtitles[path_key(value)] = {"path": str(path), "label": path.name,
                                                              "owner": item["path"], "size": path.stat().st_size}
                    if subtitles:
                        work["subtitles"] = list(subtitles.values())
            for kind, key in (("novel", "books"), ("game", "files")):
                for work in self.raw.get(kind, []):
                    root = Path(work.get("dir", ""))
                    if not work.get("dir") or key in work:
                        continue
                    paths = root.rglob("*") if root.is_dir() else [root]
                    extensions = set(getattr(self.lib, "BOOK_EXT", ())) | {".epub", ".mobi", ".azw3", ".azw", ".txt", ".pdf", ".fb2", ".djvu", ".chm"}
                    work[key] = [{"path": str(p), "label": p.stem, "size": p.stat().st_size}
                                 for p in paths if p.is_file() and (kind == "game" or p.suffix.lower() in extensions)]
            self.blocked_cache = None
            self.load()
            return self.project()

    @cached_paths
    def sync(self, server):
        with self.lock:
            changed = self._stamp() != self.stamp
            self.load()
            if changed and self.raw:
                self.lib._set_server_index(server, self.project())

    @cached_paths
    def find(self, kind=None, directory=None, uid=None):
        for category in KINDS:
            if kind and category != kind:
                continue
            for work in self.raw.get(category, []):
                if uid == work_id(category, work) or (directory and path_key(directory) == path_key(work.get("dir"))):
                    return category, work
        raise ValueError("资源不存在，请重新扫描目录")

    @cached_paths
    def work_edit(self, kind, work):
        # A first scrape can turn a directory identity into a merged Bangumi
        # identity while the other service still has an older index. Select
        # the latest matching edits and resolve status by each source path.
        uid = work_id(kind, work)
        roots = {path_key(p) for p in work.get("source_dirs") or [work.get("dir")]}
        candidates = [edit for key, edit in self.state["works"].items() if key == uid or
                      (edit.get("_kind") == kind and roots.intersection(edit.get("_dirs", [])))]
        edit = dict(max(candidates, key=lambda value: value.get("_updated", 0))) if candidates else {}
        source_versions = versions(work)
        if any(v["id"] in self.state["sources"] for v in source_versions):
            direct_status = self.state["works"].get(uid, {}).get("status", "visible")
            statuses = [self.state["sources"].get(v["id"], direct_status) for v in source_versions]
            edit["status"] = "visible" if "visible" in statuses else "deleted" if set(statuses) == {"deleted"} else "hidden"
        return edit

    @cached_paths
    def detail(self, kind=None, directory=None, uid=None):
        with self.lock:
            state = self.load()
            kind, work = self.find(kind, directory, uid)
            wid = work_id(kind, work)
            edit = self.work_edit(kind, work)
            _, metadata = self.lib._load_meta_cached()
            meta = metadata.get(work.get("dir"), {})
            result = {"id": wid, "kind": kind, "dir": work.get("dir", ""),
                      "title": edit.get("title", work.get("title", "")),
                      "summary": edit.get("summary", meta.get("summary", "")),
                      "year": edit.get("year", work.get("year") or str(meta.get("date", ""))[:4]),
                      "status": edit.get("status", "visible"), "versions": []}
            for version in versions(work):
                item_edit = state["versions"].get(version["id"], {})
                inherited = state["sources"].get(version["id"], "visible") if result["status"] == "visible" else "visible"
                version = dict(version, label=item_edit.get("label", version["label"]),
                               status=inherited if inherited != "visible" else item_edit.get("status", "visible"))
                version["items"] = [{"path": item["path"], "size": item.get("size", 0),
                                     "label": state["items"].get(path_key(item["path"]), {}).get(
                                         "label", item.get("label") or item.get("title") or item.get("name") or Path(item["path"]).name),
                                     "status": state["items"].get(path_key(item["path"]), {}).get("status", "visible")}
                                    for item in version["items"]]
                result["versions"].append(version)
            return result

    @staticmethod
    def validate(edit, allowed):
        if not isinstance(edit, dict) or set(edit) - allowed:
            raise ValueError("资源编辑字段格式错误")
        for key, value in edit.items():
            if key == "status":
                if not isinstance(value, str) or value not in STATUSES:
                    raise ValueError("资源状态必须为可见、隐藏或已删除")
            elif not isinstance(value, str) or len(value) > (20000 if key == "summary" else 500):
                raise ValueError("作品资料格式错误或内容过长")
            elif key in {"title", "label"} and not value.strip():
                raise ValueError("名称不能为空")
            elif key == "year" and value and not re.fullmatch(r"\d{4}", value):
                raise ValueError("年份请填写四位数字或留空")

    @cached_paths
    def update(self, body):
        with self.lock:
            if not isinstance(body, dict) or set(body) - {"id", "title", "summary", "year", "status", "versions", "items"}:
                raise ValueError("资源编辑字段格式错误")
            if not isinstance(body.get("id"), str):
                raise ValueError("请指定资源")
            detail = self.detail(uid=body["id"])
            state = copy.deepcopy(self.load())
            edit = {k: body[k] for k in ("title", "summary", "year", "status") if k in body}
            self.validate(edit, {"title", "summary", "year", "status"})
            kind, work = self.find(uid=body["id"])
            state["revision"] = state.get("revision", 0) + 1
            state["works"][detail["id"]] = dict(self.work_edit(kind, work), **edit,
                                                _kind=kind, _dirs=[path_key(p) for p in work.get("source_dirs") or [work.get("dir")]],
                                                _updated=state["revision"])
            if "status" in body:
                for version in versions(work):
                    state["sources"][version["id"]] = body["status"]
            known_versions = {v["id"] for v in detail["versions"]}
            known_items = {path_key(i["path"]) for v in detail["versions"] for i in v["items"]}
            for field, identity, known in (("versions", "id", known_versions), ("items", "path", known_items)):
                changes = body.get(field, [])
                if not isinstance(changes, list):
                    raise ValueError("版本或资源条目格式错误")
                seen = set()
                for change in changes:
                    if not isinstance(change, dict) or not isinstance(change.get(identity), str):
                        raise ValueError("版本或资源条目格式错误")
                    key = path_key(change[identity]) if field == "items" else change[identity]
                    if key not in known or key in seen:
                        raise ValueError("版本或资源条目不存在或重复")
                    seen.add(key)
                    patch = {k: v for k, v in change.items() if k != identity}
                    self.validate(patch, {"label", "status"})
                    state[field].setdefault(key, {}).update(patch)
            self.file.parent.mkdir(parents=True, exist_ok=True)
            temp = self.file.with_suffix(".tmp")
            temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            temp.replace(self.file)
            self.state, self.stamp = state, self._stamp()
            self.blocked_cache = None
            return self.detail(uid=detail["id"])

    @cached_paths
    def blocked_roots(self):
        if self.blocked_cache is not None:
            return self.blocked_cache
        blocked = []
        for kind in KINDS:
            for work in self.raw.get(kind, []):
                edit = self.work_edit(kind, work)
                for version in versions(work):
                    if (edit.get("status", "visible") != "visible" or
                            self.state["sources"].get(version["id"], "visible") != "visible" or
                            self.state["versions"].get(version["id"], {}).get("status", "visible") != "visible"):
                        if work.get("embedded"):
                            blocked.extend(i["path"] for i in version["items"])
                        else:
                            blocked.append(version["source_dir"])
                        blocked.extend(i["path"] for i in version["items"] if i.get("owner"))
                blocked.extend(item["path"] for item in work.get("subtitles", [])
                               if self.state["items"].get(path_key(item.get("owner", "")), {}).get("status", "visible") != "visible")
        self.blocked_cache = blocked
        return blocked

    @cached_paths
    def path_visible(self, path, blocked=None):
        blocked = self.blocked_roots() if blocked is None else blocked
        return (self.state["items"].get(path_key(path), {}).get("status", "visible") == "visible"
                and not any(below(path, root) for root in blocked))

    @cached_paths
    def allowed(self, path):
        with self.lock:
            self.load()
            return self.path_visible(path)

    @cached_paths
    def project(self):
        state = self.load()
        index = copy.deepcopy(self.raw)
        blocked = self.blocked_roots()
        for kind in KINDS:
            projected = []
            for work in index.get(kind, []):
                wid = work_id(kind, work)
                edit = self.work_edit(kind, work)
                work.update({k: v for k, v in edit.items() if k in {"title", "summary", "year"}})
                if self.role == "management":
                    work["management"] = {"id": wid, "status": edit.get("status", "visible")}
                    projected.append(work)
                    continue
                if edit.get("status", "visible") != "visible":
                    continue
                visible_versions = [v for v in versions(work) if self.path_visible(v["source_dir"], blocked)
                                    and (not v["items"] or any(self.path_visible(i["path"], blocked) for i in v["items"]))]
                if not visible_versions:
                    continue
                if work.get("dir") and not records(work):
                    continue
                def filtered(items):
                    result = []
                    for item in items:
                        if not self.path_visible(item.get("path", ""), blocked):
                            continue
                        item = dict(item)
                        label = state["items"].get(path_key(item.get("path")), {}).get("label")
                        if label:
                            item["label" if "label" in item else "title" if "title" in item else "name"] = label
                        if "subs" in item:
                            item["subs"] = {k: ([p for p in v if self.path_visible(p, blocked)] if isinstance(v, list)
                                                else v if not v or self.path_visible(v, blocked) else None)
                                            for k, v in item["subs"].items()}
                        result.append(item)
                    return result
                old_items = records(work)
                for key in ITEM_KEYS:
                    if key in work:
                        work[key] = filtered(work[key])
                visible_by_number = {v["number"]: v for v in visible_versions}
                groups = []
                for group in work.get("groups", []):
                    group["episodes"] = filtered(group.get("episodes", []))
                    group["resources"] = filtered(group.get("resources", []))
                    if not group["episodes"] and not group["resources"]:
                        continue
                    match = re.match(r"^版本\s*(\d+)\s*[·•]\s*(.+)$", group.get("label", ""))
                    version = visible_by_number.get(match[1] if match else "1")
                    if version:
                        group["version_id"] = version["id"]
                        group["version_label"] = state["versions"].get(version["id"], {}).get("label", version["label"])
                    groups.append(group)
                if "groups" in work:
                    work["groups"] = groups
                work["version_count"] = len(visible_versions)
                if "source_dirs" in work:
                    work["source_dirs"] = [v["source_dir"] for v in visible_versions]
                work["dir"] = visible_versions[0]["source_dir"]
                if work.get("folder") and not self.path_visible(work["folder"], blocked):
                    work["folder"] = work["dir"]
                if "loose_subs" in work:
                    work["loose_subs"] = [p for p in work["loose_subs"] if self.path_visible(p, blocked)]
                if work.get("poster") and not self.path_visible(work["poster"], blocked):
                    work["poster"] = ""
                item_key = {"comic": "chapters", "manhwa": "chapters", "music": "tracks", "novel": "books", "game": "files"}.get(kind, "episodes")
                if old_items:
                    work["count"] = len(work.get(item_key, []))
                    visible_items = records(work)
                    if not visible_items:
                        continue
                    work["size"] = sum(i.get("size", 0) for i in visible_items)
                projected.append(work)
            if kind in index:
                index[kind] = projected
        if self.role == "display" and "stats" in index:
            stats = index["stats"]
            for kind, works_key, items_key in (
                ("anime", "anime_works", "anime_eps"), ("movie", "movie_works", "movie_count"),
                ("comic", "comic_works", "comic_chapters"), ("manhwa", "manhwa_works", "manhwa_chapters"),
                ("music", "music_artists", "music_tracks"), ("novel", "novel_works", "novel_books"),
                ("game", "game_works", "game_files"), ("sleep", "sleep_works", "sleep_count"), ("av", "av_works", "av_count")):
                stats[works_key] = len(index.get(kind, []))
                stats[items_key] = sum(w.get("count", 0) for w in index.get(kind, []))
            stats["anime_extras"] = sum(len(w.get("extras", [])) for w in index.get("anime", []))
            stats["total_size"] = sum(w.get("size", 0) for kind in KINDS for w in index.get(kind, []))
        return index

    @cached_paths
    def metadata(self, index):
        _, original = self.lib._load_meta_cached()
        result = copy.deepcopy(original)
        if self.role == "display":
            result = {path: value for path, value in result.items() if self.allowed(path)}
        for kind in KINDS:
            for work in index.get(kind, []):
                edit = self.work_edit(kind, work)
                for directory in work.get("source_dirs") or [work.get("dir")]:
                    if not directory:
                        continue
                    meta = result.setdefault(directory, {}) if edit else result.get(directory)
                    if meta is None:
                        continue
                    if "title" in edit:
                        meta.update(title=edit["title"], title_cn=edit["title"])
                    if "summary" in edit:
                        meta["summary"] = edit["summary"]
                    if "year" in edit:
                        meta["date"] = edit["year"]
        return result
