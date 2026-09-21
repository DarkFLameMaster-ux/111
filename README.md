# 资源库拆分版

本目录把原来的单体资源库拆成两个可独立部署的前后端：

- `backend/display`：服务端显示后端，复用现有索引、OPDS、视频/音乐 Range、漫画/PDF 阅读接口，默认 `8777`。
- `frontend/display`：服务端显示前端，可由后端本机提供，也可构建后放到 GitHub Pages。
- `backend/subscription`：订阅资源后端，封装现有 `subscribe.py` / `scrape.py`，默认 `8781`。
- `frontend/subscription`：订阅资源管理前端，可独立静态部署。

后端直接使用 `F:\资源_项目\_归档脚本` 中已有的资源库管线，媒体文件、Cookies、日志和虚拟环境不会进入本仓库。

## 构建

```powershell
cd F:\资源_项目\reslib-app
$env:RESLIB_API_BASE = 'http://127.0.0.1:8777'
$env:RESLIB_SUB_API_BASE = 'http://127.0.0.1:8781'
cmd /c build-all.cmd
```

构建产物分别在 `frontend/display/dist` 与 `frontend/subscription/dist`。不需要安装第三方 npm 包，使用 Node 内置文件 API。

## 启动后端

先启动显示后端，再启动订阅后端：

```powershell
cmd /c backend\start-display.cmd
cmd /c backend\start-subscription.cmd
```

显示后端 API：`http://127.0.0.1:8777/api/health`；订阅后端健康检查：`http://127.0.0.1:8781/health`。

当静态前端部署在 GitHub Pages 或其他域名时，用构建时变量指向后端：

```powershell
$env:RESLIB_API_BASE = 'http://<你的服务端地址>:8777'
$env:RESLIB_SUB_API_BASE = 'http://<你的服务端地址>:8781'
cmd /c build-all.cmd
```

显示后端通过 `RESLIB_CORS_ORIGIN` 控制跨域来源，默认 `*`；公开部署时应改成实际前端域名。后端原有 Tailscale 白名单仍然生效。

## GitHub Pages

将 `frontend/display/dist` 或 `frontend/subscription/dist` 作为 Pages 发布目录即可。两个前端共享同一套后端配置，但可以分别部署、分别更新。
