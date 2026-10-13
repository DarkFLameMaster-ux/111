# 参与维护

## 开发与检查

使用 Node.js 22 或更高版本；桌面端目前面向 Windows。克隆后运行 `npm ci` 安装锁定依赖。
静态前端构建、版本工具和单元测试只用 Node.js 内置能力，不需要连接个人资源库。

```powershell
npm run build
npm run check
npm test
npm run version:check
```

Python 适配层可用 `python -m compileall -q backend` 检查；实际运行需设置 `RESLIB_SCRIPT_DIR`，
并使用已经安装资源管线依赖的 Python。不会因为通过语法检查就表示个人资源服务已完成验证。

## 提交规范

- 每次只处理一个明确问题，保留现有功能与用户数据。
- 提交信息使用 `feat:`、`fix:`、`docs:`、`test:`、`chore:` 等前缀，说明实际行为变化。
- 功能和修复先写入 `CHANGELOG.md` 的 `Unreleased`；发布版本时按 [发布流程](docs/RELEASING.md) 整理。
- 生成的前端 `dist` 已纳入仓库，修改源码后运行构建并一起提交。根目录 `dist` 是本地便携包，不提交。
- 发起合并请求时说明问题、验证方式和外部资源管线依赖。不要粘贴真实媒体清单或登录信息。

提交前查看 `git status`、`git diff --check` 和暂存区差异。仅纳入代码、模板与公开文档；
`.env`、Cookie、令牌、日志、数据库、媒体文件和下载中间文件保留在本机。
