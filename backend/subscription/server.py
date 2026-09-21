#!/usr/bin/env python
"""订阅资源后端：把 subscribe.py / scrape.py 的能力收敛成独立 REST 服务。"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(os.environ.get("RESLIB_SCRIPT_DIR", r"F:\资源_项目\_归档脚本"))
sys.path.insert(0, str(SCRIPT_DIR))

import lib  # noqa: E402
import scrape  # noqa: E402
import subscribe  # noqa: E402

HOST = os.environ.get("RESLIB_SUB_HOST", "127.0.0.1")
PORT = int(os.environ.get("RESLIB_SUB_PORT", "8781"))
CORS_ORIGIN = os.environ.get("RESLIB_CORS_ORIGIN", "*")


def settings():
    return lib.load_settings()


def result_payload(ok=True, **extra):
    return {"ok": ok, **extra}


class Handler(BaseHTTPRequestHandler):
    server_version = "reslib-subscription/1.0"

    def log_message(self, fmt, *args):
        # 不把订阅日志写到 GitHub 前端或控制台，统一沿用现有日志目录。
        try:
            subscribe.log("HTTP " + (fmt % args))
        except Exception:
            pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if CORS_ORIGIN != "*":
            self.send_header("Vary", "Origin")

    def send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path in ("/", "/health", "/api/health"):
                subs = subscribe.load_subs()
                self.send_json(result_payload(
                    service="subscription", subscriptions=len(subs),
                    enabled=sum(1 for x in subs.values() if x.get("enabled", True)),
                    host=HOST, port=PORT,
                ))
                return
            if u.path in ("/api/subscriptions", "/api/subs"):
                self.send_json({"subscriptions": subscribe.load_subs()})
                return
            if u.path == "/api/settings":
                self.send_json(settings())
                return
            if u.path == "/api/search":
                self.send_json({"items": subscribe.baozimh_search(q.get("q", [""])[0])})
                return
            self.send_json({"error": "not found"}, 404)
        except Exception as exc:
            self.send_json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self):
        try:
            u = urlparse(self.path)
            body = self.read_json()
            if u.path == "/api/subscriptions":
                action = str(body.get("action", "list"))
                name = str(body.get("name", "")).strip()
                if action == "list":
                    self.send_json({"subscriptions": subscribe.load_subs()})
                elif action == "add" and name:
                    cfg = subscribe.add_sub(name, body.get("slug"), body.get("dir"))
                    self.send_json(result_payload(cfg is not None, subscription=cfg))
                elif action == "remove" and name:
                    self.send_json(result_payload(subscribe.remove_sub(name), name=name))
                elif action == "toggle" and name:
                    subs = subscribe.load_subs()
                    if name not in subs:
                        self.send_json({"error": "subscription not found"}, 404)
                        return
                    subs[name]["enabled"] = bool(body.get("enabled", True))
                    subscribe.save_subs(subs)
                    self.send_json(result_payload(True, subscription=subs[name]))
                elif action == "check":
                    checked = subscribe.check_all(
                        download=bool(body.get("download", True)),
                        only=name or None,
                    )
                    self.send_json(result_payload(True, result=checked))
                elif action == "search":
                    self.send_json({"items": subscribe.baozimh_search(str(body.get("q", "")))})
                else:
                    self.send_json({"error": "invalid action or name"}, 400)
                return
            if u.path == "/api/settings":
                current = settings()
                current.update({k: v for k, v in body.items() if k in {
                    "auto_scrape", "subscribe_hour", "subscribe_minute", "subscribe_download",
                }})
                lib.save_settings(current)
                self.send_json(current)
                return
            if u.path == "/api/scrape":
                data = scrape.scrape_all(force=bool(body.get("force", False)), quiet=True)
                self.send_json(data)
                return
            self.send_json({"error": "not found"}, 404)
        except Exception as exc:
            self.send_json({"error": f"{type(exc).__name__}: {exc}"}, 500)


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    message = f"订阅后端监听 http://{HOST}:{PORT}"
    # 计划任务用 pythonw 启动时没有控制台，启动信息写进既有订阅日志。
    if sys.stdout is None:
        subscribe.log(message)
    else:
        print(message)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
