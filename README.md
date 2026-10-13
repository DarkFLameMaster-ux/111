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
- `backend/subscription`：资源管理服务（默认端口 `8781`），统一执行归档、体检、订阅、刮削与定时任务；保留原目录名以兼容现有启动任务。
- `frontend/subscription`：独立资源管理前端，包含订阅来源与 OPDS 链接管理。
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

## 两个独立程序

| 程序 | 启动文件 | 服务 | 功能 |
| --- | --- | --- | --- |
| 资源浏览 | `启动资源浏览.cmd` | 8777 | 分类、检索、播放、阅读、记录与播放版本偏好 |
| 资源管理 | `启动资源管理.cmd` | 8781 | 资源目录、归档、体检、订阅来源与状态、刮削、定时任务、缓存及 OPDS 链接 |

两者可单独运行或同时运行，各自只启动对应服务；退出只结束自己启动的进程，
不会终止已由计划任务运行的服务，也不会关闭另一个程序。资源管理服务独自负责自动刮削和定时订阅。
旧入口 `启动桌面壳.cmd` 默认打开资源浏览；`npm run desktop:management` 打开资源管理。

管理目录保留动画、电影、漫画、韩漫、小说、音乐、游戏、助眠和 AV 分类入口，支持分类内搜索与数量统计。
小说保留日系轻小说、网文子分类；游戏仅提供目录管理，不执行游戏程序。
归档默认为原分类器自动识别，手动分类包含韩漫与小说子分类，仅对本次归档生效。

资源管理目录中，每部作品提供“编辑”“隐藏”和“删除”操作。“编辑”可修改展示名称、简介、年份，以及整部作品、各版本和各文件的展示状态；版本旁会保留原目录便于识别，并可分别修改版本名称和文件标签。文件列表按需展开，支持搜索和每页 50 条的分页，翻页保留本次未保存改动；点击“保存展示资料”统一提交，取消或关闭编辑不会写入。

隐藏与删除均只改变展示目录，不会重命名、移动或物理删除原文件。默认目录不显示已删除作品，可在状态筛选中选择“回收站 · 已删除”恢复；“全部状态”“展示可见”和“已隐藏”可用于检查展示范围。隐藏或删除的版本、文件不在浏览端与 OPDS 中提供，整部作品恢复后仍尊重各版本、文件自身的状态。保存后在资源浏览端刷新列表即可读取更新。

浏览服务拒绝设置、归档、刮削、订阅与缓存管理接口；阅读进度和播放版本偏好仍可保存。
浏览器的刷新列表与桌面启动均读取最新资源索引，无需使用管理接口。
服务复用会核对角色与版本；旧版或其他程序占用端口时明确报错，不会误连旧界面。

生成两个 Windows 便携包：

```powershell
npm run desktop:portable
```

产物固定为 `dist/current/display/Moonshadow-display.exe`
和 `dist/current/management/Moonshadow-management.exe`，桌面快捷方式无需随版本改路径。
也可使用 `desktop:portable:display`、`desktop:portable:management` 分别构建。
使用和分发时保留每个程序的完整目录。源码版本通过项目内 Git 提交和 `vX.Y.Z` 标签管理，
不再为每个版本在项目里保留整套运行环境。更新前关闭对应桌面程序；相同 Electron 版本复用现有运行文件，
只替换程序代码，并把旧代码备份到项目所在盘的 `Reslib-backups/portable/`（本机为 `F:\Reslib-backups`）。
只有升级 Electron 或更换架构时才备份整个旧程序；失败时恢复之前的程序。
可用 `RESLIB_BACKUP_DIR` 指定其他项目外备份目录。

程序自动寻找上级目录中的 `_归档脚本`，仍使用现有资源库与 Python 环境，不复制媒体或登录凭据。
搬到其他位置时设置 `RESLIB_SCRIPT_DIR`，必要时设置 `RESLIB_PYTHON`。
管理端的 OPDS 地址默认指向 `http://127.0.0.1:8777/opds`；手机访问可在管理页的“订阅链接”中保存可访问的电脑地址；首次默认值也可通过
`RESLIB_PUBLIC_DISPLAY_URL` 指定。沿用既有登录和网络白名单。

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

v0.2.1 参考 [哔哩哔哩番剧](https://www.bilibili.com/anime/) 的封面陈列与分区层次，以及 [《俺妹》官网](https://www.oreimo-anime.com/) 的主题构图，转译为五更琉璃的月下书架：竖幅海报、紫黑夜色、月轮与缎带徽记。装饰使用内置矢量，搜索时收起主题横幅，让结果优先显示；原有资源、播放、阅读和订阅逻辑继续沿用。
