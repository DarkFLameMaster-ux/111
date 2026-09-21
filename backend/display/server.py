#!/usr/bin/env python
"""资源显示后端。

复用现有资源库索引、OPDS、视频/漫画流式接口；前端可以由本服务提供，
也可以部署到 GitHub Pages，通过 RESLIB_CORS_ORIGIN 跨域访问。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(os.environ.get("RESLIB_SCRIPT_DIR", r"F:\资源_项目\_归档脚本"))
FRONTEND = Path(os.environ.get("RESLIB_DISPLAY_DIST", str(APP_ROOT / "frontend" / "display" / "dist" / "index.html")))
sys.path.insert(0, str(SCRIPT_DIR))

import lib  # noqa: E402
from compat import prepare  # noqa: E402

prepare(lib, os.environ.get("RESLIB_CORS_ORIGIN", "*"))
lib.UI_FILE = FRONTEND

host = os.environ.get("RESLIB_HOST", "0.0.0.0")
port = int(os.environ.get("RESLIB_PORT", "8777"))
tls_port = int(os.environ.get("RESLIB_TLS_PORT", "0"))
if tls_port == 0:
    # 兼容旧 lib.py：旧逻辑用 ``or`` 处理端口，会把显式 0 回退为默认 HTTPS 端口。
    lib.TLS_PORT_DEFAULT = 0

sys.argv = ["lib.py", "serve", "--host", host, "--port", str(port), "--tls-port", str(tls_port)]
raise SystemExit(lib.main())
