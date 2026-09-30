"""让显示包装器也能运行在尚未合并 CORS 改动的旧版 lib.py 上。"""
from __future__ import annotations


def prepare(lib, cors_origin="*"):
    # 新版 lib.py 已经原生提供这些能力；不重复包裹，避免重复响应头。
    if not hasattr(lib.Handler, "_cors_headers"):
        def cors_headers(self):
            self.send_header("Access-Control-Allow-Origin", cors_origin)
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        lib.Handler._cors_headers = cors_headers

        original_end_headers = lib.Handler.end_headers
        def end_headers(self):
            self._cors_headers()
            return original_end_headers(self)
        lib.Handler.end_headers = end_headers

        def do_options(self):
            if not self._client_ok():
                return
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
        lib.Handler.do_OPTIONS = do_options

    return lib
