# 月影黑猫 · 资源库

一个面向个人媒体库的轻量前后端：以紫黑、深蓝、星月和轻哥特细节构成克制的阅读与播放界面，缩略图保持清晰，桌面和移动端都能使用。

项目只包含服务适配层和静态前端，不包含媒体文件、Cookies、日志、数据库、下载缓存或登录凭据。实际资源脚本目录通过 `RESLIB_SCRIPT_DIR` 指向本机已有的资源管线。

## 目录

- `backend/display`：媒体库展示服务，提供目录、OPDS、视频/音频 Range 和漫画阅读接口（默认端口 `8777`）。
- `frontend/display`：展示前端，可由后端托管，也可部署到静态站点。
- `backend/subscription`：订阅服务适配层（默认端口 `8781`）。
- `frontend/subscription`：订阅管理前端。

## 本地运行

1. 复制 `.env.example` 为 `.env`，将 `RESLIB_SCRIPT_DIR` 改为本机资源脚本目录。该目录需要提供原有管线的 `lib.py`、`scrape.py` 和 `subscribe.py`。
2. 在项目根目录构建前端：

```powershell
cmd /c build-all.cmd
```

3. 在已设置变量的终端启动服务：

```powershell
cmd /c backend\start-display.cmd
cmd /c backend\start-subscription.cmd
```

展示服务默认只监听 `127.0.0.1`。需要从其他设备访问时，请显式设置 `RESLIB_HOST`、配置防火墙和访问控制，并把 `RESLIB_CORS_ORIGIN` 改为静态前端的精确来源。

## 前端构建

项目使用 Node.js 内置文件 API，无需安装依赖：

- `npm --prefix frontend/display run build`
- `npm --prefix frontend/subscription run build`

构建会把 `src/index.html` 复制到对应的 `dist/` 并生成不含凭据的 `config.js`。

## 安全边界

不要提交任何 `.env`、Cookie、令牌、私钥、数据库、日志、下载中间文件或媒体目录。提交前请检查 `git status` 与 `git diff --check`。

## 项目名

“月影黑猫”取星月与黑猫意象，作为五更琉璃方向的视觉提示；界面使用紫黑/深蓝底色、低强度光晕和少量星月符号，不依赖外部素材或网络字体。
