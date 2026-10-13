# 月影黑猫 · 资源库

一个面向个人媒体库的轻量前后端：以紫黑、深蓝、星月和轻哥特细节构成克制的阅读与播放界面，缩略图保持清晰，桌面和移动端都能使用。

软件版本统一由根目录 `package.json` 管理。运行 `npm run version:show` 查看当前版本；
网页会显示软件版本，桌面端可通过窗口标题或“帮助 → 关于”查看。
变更记录见 [CHANGELOG.md](CHANGELOG.md)，开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，
版本递增、标签与打包步骤见 [发布流程](docs/RELEASING.md)。

项目只包含服务适配层和静态前端，不包含媒体文件、Cookies、日志、数据库、下载缓存或登录凭据。实际资源脚本目录通过 `RESLIB_SCRIPT_DIR` 指向本机已有的资源管线。

## 目录

- `backend/display`：媒体库展示服务，提供目录、OPDS、视频/音频 Range 和漫画阅读接口（默认端口 `8777`）。
- `frontend/display`：展示前端，可由后端托管，也可部署到静态站点；侧栏「记录」会保存并恢复手机端的漫画阅读、动画/电影播放历史。
- `backend/subscription`：订阅服务适配层（默认端口 `8781`）。
- `frontend/subscription`：订阅管理前端。
- `desktop`：Windows 桌面壳与便携打包脚本。
- `scripts`：统一构建、版本管理和验证工具。
- `.github`：自动检查、问题反馈与合并请求模板。

## 本地运行

需要 Node.js 22 或更高版本，以及已配置资源管线依赖的 Python。仓库本身不包含完整资源管线。

1. 复制 `.env.example` 作为本地参考，将 `RESLIB_SCRIPT_DIR` 改为本机资源脚本目录，并把变量导入当前终端（启动脚本不会自动读取 `.env`）。该目录需要提供原有管线的 `lib.py`、`scrape.py` 和 `subscribe.py`。
2. 在项目根目录构建前端：

```powershell
cmd /c build-all.cmd
```

3. 在已设置变量的终端启动服务：

```powershell
cmd /c backend\start-display.cmd
cmd /c backend\start-subscription.cmd
```

网页模式下，展示服务默认监听 `0.0.0.0`，这样同一 Wi‑Fi 下的设备可以访问；订阅管理服务仍默认只监听本机。资源库后端会按 `_归档脚本/settings.json` 的来源白名单和登录配置放行请求，请同时配置防火墙。需要仅本机访问展示服务时，将 `RESLIB_HOST` 显式设为 `127.0.0.1`。静态前端部署到其他来源时，再把 `RESLIB_CORS_ORIGIN` 改为该来源。

## 桌面端

`desktop/` 是现有网页资源库的 Windows 桌面壳。它会自动拉起展示服务和订阅服务，窗口关闭时一并结束这两个本地进程；桌面壳默认只监听 `127.0.0.1`，不会改变网页服务的局域网配置。

首次使用可以双击 `启动桌面壳.cmd`，或在项目目录执行：

```powershell
npm ci
npm run build
npm run desktop
```

要生成便携版，执行 `npm run desktop:portable`。完整程序目录位于
`dist/v<版本>/Moonshadow-Reslib-<版本>-win32-<架构>/`，需保留其中的运行时文件。
已有同版本产物不会被覆盖，旧包可留作回退；外部资源管线和 Python 环境不包含在包内。

如果 Python 不在资源库的 `.venv` 中，用 `RESLIB_PYTHON` 指向可用的 Python 可执行文件。

## 前端构建

项目使用 Node.js 内置文件 API，无需安装依赖：

- `npm --prefix frontend/display run build`
- `npm --prefix frontend/subscription run build`

构建会把 `src/index.html` 复制到对应的 `dist/` 并生成不含凭据的 `config.js`。
构建同时写入软件版本和 `version.json`；两份前端共用根项目版本，生成物随源码提交。
根目录 `npm run build` 可在 Windows 和 Linux 上运行。

## 维护与版本

```powershell
npm run release:check        # 构建、语法、测试与版本一致性
npm run version:show         # 查询软件版本
```

新增修改先记录到 `CHANGELOG.md` 的 `Unreleased`，再执行 `npm run version:bump -- patch`
（也支持 `minor`、`major` 或明确版本）。工具同步包信息和更新日志；检查通过后再提交和打标签。
GitHub Actions 会在分支、合并请求与版本标签上验证 Windows/Linux 构建及版本一致性。

## 安全边界

不要提交任何 `.env`、Cookie、令牌、私钥、数据库、日志、下载中间文件或媒体目录。提交前请检查 `git status` 与 `git diff --check`。

## 项目名

“月影黑猫”取星月与黑猫意象，作为五更琉璃方向的视觉提示；界面使用紫黑/深蓝底色、低强度光晕和少量星月符号，不依赖外部素材或网络字体。展示前端与订阅控制台都内置黑猫徽记、月轮、星点和紫粉高光交互，离线打开时仍保持完整视觉效果。
