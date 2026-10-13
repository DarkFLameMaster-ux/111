# 版本管理与发布

## 版本来源

根目录 `package.json` 的 `version` 是唯一手工管理入口。版本工具同步 `package-lock.json`，
两份前端构建生成可见版本及 `dist/version.json`，桌面端通过 Electron `app.getVersion()` 读取版本。
便携打包直接读取根包元数据，不维护第二套版本值。

采用 [语义化版本](https://semver.org/spec/v2.0.0.html) 的三段稳定版本 `主版本.次版本.修订号`：
修复使用 `patch`，新增兼容功能使用 `minor`，不兼容改动使用 `major`。目前处于 `0.x` 开发阶段，
接口兼容性尚未承诺；显著功能变化提升次版本。当前工具只接受稳定三段版本，预发布后缀暂不支持。

## 准备版本

1. 把实际改动写进 `CHANGELOG.md` 的 `Unreleased`，使用列表条目。
2. 运行以下命令之一，自动更新根包、锁文件，并把未发布记录移入新版本章节：

```powershell
npm run version:show
npm run version:bump -- patch
# 也可选择 minor / major / 明确的新版本，例如 0.3.0
npm run version:bump -- minor --date 2026-11-01
```

未提供日期时使用 UTC 当日；需要按当地发布日期记录时显式传 `--date YYYY-MM-DD`。
工具拒绝版本倒退、重复版本、非法日期和没有变更条目的发布，不会自动提交、创建标签或推送。

3. 验证并检查变更：

```powershell
npm run release:check
python -m compileall -q backend
git diff --check
git status --short
```

`release:check` 会构建前端、检查脚本语法、执行单元测试，并校验锁文件、更新日志、
两份前端元数据和可见版本一致。GitHub CI 也会检查生成物是否与源码一致。
CI 使用临时测试数据，不连接开发者的媒体库；实际发布仍需在已配置资源管线的机器上检查界面。

## 提交与标签

检查暂存区内容后，提交本次版本涉及的源码、生成的前端、锁文件和文档。
以下以 `0.2.0` 为例，后续替换成实际版本和当前工作分支：

```powershell
git commit -m "chore: release v0.2.0"
npm run version:check -- --tag v0.2.0
git tag -a v0.2.0 -m "月影黑猫资源库 v0.2.0"
git push --atomic origin HEAD refs/tags/v0.2.0
```

标签与发布提交对应；不移动或覆盖已经推送的版本标签，发现问题时发下一个修订版本。
分支推送、合并请求与 `v*` 标签都会触发 CI，标签版本不一致会失败。
维护分支经审阅后再合入默认分支，避免把未核对内容直接混入主线。

## Windows 便携包

```powershell
npm ci
npm run desktop:portable
```

命令先执行发布检查，再生成 `dist/v<版本>/Moonshadow-Reslib-<版本>-win32-<架构>/`。
完整目录内包含程序及运行文件；分发时保留目录内容，不能只复制 `.exe`。
已有同版本产物不会被覆盖。需要修订时先提升版本；旧包可保留用于回退。
个人资源管线与 Python 环境不包含在包内，移动到其他位置时通过 `RESLIB_SCRIPT_DIR` 和
`RESLIB_PYTHON` 指定它们。打包不自动上传二进制或创建 GitHub Release。
