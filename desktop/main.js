const { app, BrowserWindow, dialog, ipcMain, Menu, shell, globalShortcut } = require("electron");
const { createReaderShortcuts } = require("./reader-shortcuts");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");
const APP_NAME = "月影黑猫 · 资源库";
const APP_VERSION = app.getVersion();
const WINDOW_TITLE = `${APP_NAME} v${APP_VERSION}`;

// A portable release adds version and application directories below dist.
// Walk ancestors so both source checkouts and portable releases can reuse the
// project's existing _归档脚本 directory without bundling its private settings.
function ancestorScriptDirs(start) {
  const candidates = [];
  for (let current = path.resolve(start); ; current = path.dirname(current)) {
    candidates.push(path.join(current, "_归档脚本"));
    if (path.dirname(current) === current) return candidates;
  }
}

const SCRIPT_DIR_CANDIDATES = [
  ...ancestorScriptDirs(APP_ROOT),
  ...ancestorScriptDirs(path.dirname(process.execPath)),
];
const SCRIPT_DIR = process.env.RESLIB_SCRIPT_DIR
  ? path.resolve(APP_ROOT, process.env.RESLIB_SCRIPT_DIR)
  : SCRIPT_DIR_CANDIDATES.find((candidate) => fs.existsSync(path.join(candidate, "lib.py")))
    || path.resolve(APP_ROOT, "..", "_归档脚本");
const DISPLAY_URL = "http://127.0.0.1:8777/";
const PYTHON_CANDIDATES = [
  process.env.RESLIB_PYTHON,
  path.join(SCRIPT_DIR, ".venv", "Scripts", "python.exe"),
  path.join(APP_ROOT, ".venv", "Scripts", "python.exe"),
  "python.exe",
].filter(Boolean);

let mainWindow;
let displayProcess;
let subscriptionProcess;
let stopping = false;
const readerShortcuts = createReaderShortcuts(globalShortcut, () => mainWindow, (failed) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("reslib:reader-shortcut-status", failed);
  }
  if (failed.length) fs.appendFileSync(logPath("display"), `\n[desktop] 全局快捷键注册失败：${failed.join(" ")}\n`);
});

function firstExistingPython() {
  return PYTHON_CANDIDATES.find((candidate) => candidate === "python.exe" || fs.existsSync(candidate));
}

function logPath(name) {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.log`);
}

function startService(name, script, extraEnv) {
  if (!fs.existsSync(path.join(SCRIPT_DIR, "lib.py"))) {
    throw new Error(`没有找到资源库脚本：${SCRIPT_DIR}。请将桌面端放在资源库项目目录内，或设置 RESLIB_SCRIPT_DIR 指向已有的 _归档脚本目录。`);
  }
  const python = firstExistingPython();
  if (!python) throw new Error("没有找到 Python 运行时。请确认资源库的 .venv 存在，或设置 RESLIB_PYTHON。");

  const env = {
    ...process.env,
    RESLIB_SCRIPT_DIR: SCRIPT_DIR,
    RESLIB_HOST: "127.0.0.1",
    RESLIB_PORT: "8777",
    RESLIB_SUB_HOST: "127.0.0.1",
    RESLIB_SUB_PORT: "8781",
    RESLIB_DISPLAY_DIST: path.join(APP_ROOT, "frontend", "display", "dist", "index.html"),
    ...extraEnv,
  };
  const child = spawn(python, [path.join(APP_ROOT, "backend", script)], {
    cwd: APP_ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = fs.createWriteStream(logPath(name), { flags: "a" });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  child.once("error", (error) => output.write(`\n[desktop] ${error.stack || error}\n`));
  child.once("close", (code, signal) => {
    output.write(`\n[desktop] exited code=${code ?? ""} signal=${signal ?? ""}\n`);
    output.end();
  });
  return child;
}

function stopProcess(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function requestOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 700 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// 8777 可能已经被资源库后台实例占用。仅检查端口会把桌面壳连接到
// 一个启动时留下的旧索引，导致新资源必须点“一键归档”后才出现。
// 启动页前主动调用同一个重建入口，确保无论复用了哪个本地实例，
// 页面拿到的都是磁盘上的最新资源目录。
function reindexDisplay() {
  return new Promise((resolve) => {
    const req = http.request(`${DISPLAY_URL}api/reindex`, {
      method: "POST",
      timeout: 30000,
      headers: { "Content-Type": "application/json", "Content-Length": "2" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const payload = JSON.parse(body);
          resolve(res.statusCode >= 200 && res.statusCode < 300 && payload.ok === true);
        } catch (_) {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end("{}");
  });
}

async function waitForDisplay(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await requestOk(DISPLAY_URL)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function errorPage(message) {
  const escaped = String(message).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#11111a;color:#eee;font:16px system-ui;padding:48px}main{max-width:720px;margin:auto;background:#1b1b2a;border:1px solid #36364d;border-radius:18px;padding:32px}h1{font-size:24px;margin:0 0 12px;color:#d8c9ff}p{color:#bbb;line-height:1.7}code{display:block;white-space:pre-wrap;background:#101017;border-radius:10px;padding:14px;color:#ffb4c0}button{margin-top:18px;border:0;border-radius:999px;background:#a98bff;color:#17131f;padding:10px 18px;font-weight:700;cursor:pointer}</style><main><h1>资源库没有启动成功</h1><p>桌面壳已经打开，但本地资源库服务没有在预期时间内响应。</p><code>${escaped}</code><button onclick="window.reslibDesktop.retry()">重新启动</button></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function loadDisplay() {
  const ready = await waitForDisplay();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (ready) {
    // 归档按钮也会走 /api/reindex；启动时同样做一次，避免旧索引被复用。
    await reindexDisplay();
    await mainWindow.loadURL(DISPLAY_URL);
  } else {
    await mainWindow.loadURL(errorPage(`展示服务地址：${DISPLAY_URL}\n日志目录：${path.dirname(logPath("display"))}`));
  }
}

async function bootServices() {
  stopping = false;
  stopProcess(displayProcess);
  stopProcess(subscriptionProcess);
  displayProcess = startService("display", path.join("display", "server.py"), {});
  subscriptionProcess = startService("subscription", path.join("subscription", "server.py"), {});
  await loadDisplay();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#121212",
    title: WINDOW_TITLE,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow.setTitle(WINDOW_TITLE);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith("http://127.0.0.1:") && !url.startsWith("http://localhost:")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("focus", readerShortcuts.sync);
  mainWindow.on("blur", readerShortcuts.sync);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) readerShortcuts.reset();
  });
  mainWindow.webContents.on("render-process-gone", readerShortcuts.reset);
  mainWindow.on("closed", () => { readerShortcuts.reset(); mainWindow = null; });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  readerShortcuts.reset();
  stopProcess(displayProcess);
  stopProcess(subscriptionProcess);
  displayProcess = null;
  subscriptionProcess = null;
}

ipcMain.on("reslib:reader-active", (event, active) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (event.senderFrame !== mainWindow.webContents.mainFrame) return;
  if (!event.senderFrame.url.startsWith(DISPLAY_URL)) return;
  readerShortcuts.setActive(active);
});

ipcMain.handle("reslib:retry", async () => {
  if (!mainWindow) return false;
  await bootServices();
  return true;
});

ipcMain.handle("reslib:version", () => APP_VERSION);

ipcMain.handle("reslib:pick-folder", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return "";
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择默认待整理目录",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? "" : (result.filePaths[0] || "");
});

app.whenReady().then(async () => {
  app.setAppUserModelId("local.reslib.moonshadow.blackcat");
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: APP_VERSION,
    version: APP_VERSION,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "帮助", submenu: [
      { label: "关于资源库", accelerator: "F1", click: () => app.showAboutPanel() },
      { type: "separator" },
      { label: "退出", role: "quit" },
    ] },
  ]));
  createWindow();
  try {
    await bootServices();
  } catch (error) {
    if (mainWindow) await mainWindow.loadURL(errorPage(error.stack || error.message || error));
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", shutdown);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
