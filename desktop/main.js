const { app, BrowserWindow, dialog, ipcMain, Menu, shell, globalShortcut } = require("electron");
const { createReaderShortcuts } = require("./reader-shortcuts");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");
const APP_ROLE = require('../package.json').reslibRole || (process.argv.includes('--management') ? 'management' : 'display');
const MANAGEMENT = APP_ROLE === 'management';
const APP_NAME = MANAGEMENT ? '月影黑猫 · 资源管理' : '月影黑猫 · 资源浏览';
// Separate profiles and singleton locks allow both programs to run together.
app.setPath('userData', path.join(app.getPath('appData'), `moonshadow-reslib-${APP_ROLE}`));
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
const APP_VERSION = app.getVersion();
const WINDOW_TITLE = `${APP_NAME} v${APP_VERSION}`;

// Portable programs use fixed role directories below dist/current.
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
const SERVICE_PORT = Number(process.env[MANAGEMENT ? 'RESLIB_SUB_PORT' : 'RESLIB_PORT'] || (MANAGEMENT ? 8781 : 8777));
const DISPLAY_URL = `http://127.0.0.1:${SERVICE_PORT}/`;
const PYTHON_CANDIDATES = [
  process.env.RESLIB_PYTHON,
  path.join(SCRIPT_DIR, ".venv", "Scripts", "python.exe"),
  path.join(APP_ROOT, ".venv", "Scripts", "python.exe"),
  "python.exe",
].filter(Boolean);

let mainWindow;
let displayProcess;
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
    RESLIB_PORT: String(SERVICE_PORT),
    RESLIB_SUB_HOST: "127.0.0.1",
    RESLIB_SUB_PORT: String(SERVICE_PORT),
    RESLIB_DISPLAY_DIST: path.join(APP_ROOT, "frontend", "display", "dist", "index.html"),
    RESLIB_MANAGEMENT_DIST: path.join(APP_ROOT, "frontend", "subscription", "dist", "index.html"),
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
  if (!child || !child.pid || child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise(resolve => {
    child.once('close', resolve);
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve);
    } else child.kill('SIGTERM');
  });
}

function serviceIdentity() {
  return new Promise((resolve, reject) => {
    const request = http.get(`${DISPLAY_URL}api/service`, { timeout: 1500 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, ...JSON.parse(body) }); }
        catch { resolve({ status: response.statusCode }); }
      });
      response.on('error', reject);
    });
    // Only a refused connection means there is no service to reuse. A slow
    // listener must never cause us to launch a second backend on the same port.
    request.on('error', error => error.code === 'ECONNREFUSED' ? resolve(null) : reject(error));
    request.on('timeout', () => request.destroy(new Error('本地资源库服务响应超时，请稍后重试。')));
  });
}

function compatibleService(identity) {
  return identity?.status === 200 && identity.application === 'moonshadow-reslib' &&
    identity.role === APP_ROLE && identity.version === APP_VERSION;
}

async function waitForDisplay(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await serviceIdentity();
    if (compatibleService(identity)) return true;
    if (identity) throw new Error(`端口 ${SERVICE_PORT} 已被旧版或其他服务占用。请更新或退出旧服务后重试。`);
    if (displayProcess && displayProcess.exitCode !== null) return false;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function refreshDisplayIndex() {
  return new Promise((resolve, reject) => {
    const request = http.get(`${DISPLAY_URL}api/library?refresh=1`, { timeout: 120000 }, response => {
      response.resume();
      response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('读取最新资源目录失败')));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('读取最新资源目录超时')));
  });
}

function statusPage(message, failed = false) {
  const escaped = String(message).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#11111a;color:#eee;font:16px system-ui;padding:48px}main{max-width:720px;margin:auto;background:#1b1b2a;border:1px solid #36364d;border-radius:18px;padding:32px}h1{font-size:24px;margin:0 0 12px;color:#d8c9ff}p{color:#bbb;line-height:1.7}code{display:block;white-space:pre-wrap;background:#101017;border-radius:10px;padding:14px;color:#ffb4c0}button{margin-top:18px;border:0;border-radius:999px;background:#a98bff;color:#17131f;padding:10px 18px;font-weight:700;cursor:pointer}</style><main><h1>${failed ? '资源库没有启动成功' : APP_NAME}</h1><p>${failed ? '启动遇到问题，可以查看原因后重试。' : '正在准备资源库，完成后会自动打开。'}</p>${failed ? `<code>${escaped}</code><button onclick="this.disabled=true;window.reslibDesktop.retry()">重新启动</button>` : `<p role="status">${escaped}</p>`}</main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function errorPage(message) { return statusPage(message, true); }

async function showBootError(error) {
  const message = error.stack || error.message || String(error);
  fs.appendFileSync(logPath(APP_ROLE), `\n[desktop] ${message}\n`);
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(errorPage(error.message || String(error)));
}

async function loadDisplay() {
  const ready = await waitForDisplay();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (ready) {
    // Read the current directory before rendering, including reused services.
    await mainWindow.loadURL(statusPage('正在更新资源目录；资源较多时请稍候。'));
    await refreshDisplayIndex();
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(DISPLAY_URL);
  } else {
    throw new Error(`本地资源库未能在两分钟内启动。\n程序服务地址：${DISPLAY_URL}\n日志目录：${path.dirname(logPath(APP_ROLE))}`);
  }
}

async function bootServices() {
  stopping = false;
  const identity = await serviceIdentity();
  if (identity && !compatibleService(identity)) {
    throw new Error(`端口 ${SERVICE_PORT} 已被旧版或其他服务占用，请更新或退出旧服务后重试。`);
  }
  if (!identity) {
    await stopProcess(displayProcess);
    displayProcess = startService(APP_ROLE, path.join(MANAGEMENT ? 'subscription' : 'display', 'server.py'), {});
  }
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
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("focus", readerShortcuts.sync);
  mainWindow.on("blur", readerShortcuts.sync);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) readerShortcuts.reset();
  });
  mainWindow.webContents.on("render-process-gone", readerShortcuts.reset);
  mainWindow.on("closed", () => { readerShortcuts.reset(); mainWindow = null; });
  return mainWindow.loadURL(statusPage('正在连接本地资源库…'));
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  readerShortcuts.reset();
  await stopProcess(displayProcess);
  displayProcess = null;
}

ipcMain.on("reslib:reader-active", (event, active) => {
  if (MANAGEMENT) return;
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (event.senderFrame !== mainWindow.webContents.mainFrame) return;
  if (!event.senderFrame.url.startsWith(DISPLAY_URL)) return;
  readerShortcuts.setActive(active);
});

ipcMain.handle("reslib:retry", async () => {
  if (!mainWindow) return false;
  try {
    await mainWindow.loadURL(statusPage('正在重新连接本地资源库…'));
    await bootServices();
    return true;
  } catch (error) {
    await showBootError(error);
    return false;
  }
});

ipcMain.handle("reslib:version", () => APP_VERSION);

ipcMain.handle("reslib:pick-folder", async () => {
  if (!MANAGEMENT || !mainWindow || mainWindow.isDestroyed()) return "";
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择默认待整理目录",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? "" : (result.filePaths[0] || "");
});

if (hasLock) app.whenReady().then(async () => {
  app.setAppUserModelId(`local.reslib.moonshadow.${APP_ROLE}`);
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
  try {
    await createWindow();
    await bootServices();
  } catch (error) {
    await showBootError(error);
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", shutdown);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
});
