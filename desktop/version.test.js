const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function desktopFixture({ appRoot = 'C:\\fixture\\reslib-app', env = {}, files = [] } = {}) {
  const handlers = new Map();
  const windows = [];
  const state = {};
  const app = {
    getVersion: () => '8.4.2-test.1',
    whenReady: () => ({ then(callback) { state.ready = callback; } }),
    on() {},
    setAppUserModelId() {},
    setAboutPanelOptions(options) { state.about = options; },
    showAboutPanel() { state.aboutShown = true; },
  };
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.events = new Map();
      this.webContents = { on() {}, setWindowOpenHandler() {} };
      windows.push(this);
    }
    on(name, callback) { this.events.set(name, callback); }
    setTitle(title) { this.title = title; }
  }
  const electron = {
    app, BrowserWindow, dialog: {}, shell: {}, globalShortcut: {},
    ipcMain: { on() {}, handle(name, callback) { handlers.set(name, callback); } },
    Menu: {
      buildFromTemplate(template) { return template; },
      setApplicationMenu(menu) { state.menu = menu; },
    },
  };
  const context = vm.createContext({
    __dirname: path.win32.join(appRoot, 'desktop'),
    process: { env, execPath: path.win32.join(appRoot, 'Moonshadow-Reslib.exe'), platform: 'win32' },
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'path') return path.win32;
      if (name === 'fs') return { existsSync: candidate => files.includes(candidate) };
      if (name === 'child_process') return { spawn() { throw new Error('Must not spawn in this test'); } };
      if (name === './reader-shortcuts') return { createReaderShortcuts: () => ({ sync() {}, reset() {} }) };
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), context);
  return { context, state, windows, handlers };
}

test('runtime version stays visible in the window, About panel and renderer API', async () => {
  const fixture = desktopFixture();
  vm.runInContext('bootServices = async () => {};', fixture.context);
  await fixture.state.ready();
  const win = fixture.windows[0];
  assert.equal(win.options.title, '月影黑猫 · 资源库 v8.4.2-test.1');
  let prevented = false;
  win.events.get('page-title-updated')({ preventDefault() { prevented = true; } }, 'Web page title');
  assert.equal(prevented, true);
  assert.equal(win.title, win.options.title);
  assert.equal(fixture.state.about.applicationVersion, '8.4.2-test.1');
  fixture.state.menu[0].submenu[0].click();
  assert.equal(fixture.state.aboutShown, true);
  assert.equal(fixture.handlers.get('reslib:version')(), '8.4.2-test.1');
});

test('portable version directories locate the original project pipeline', () => {
  const fixture = desktopFixture({
    appRoot: 'C:\\fixture\\reslib-app\\dist\\v8.4.2\\release\\resources\\app',
    files: ['C:\\fixture\\_归档脚本\\lib.py'],
  });
  assert.equal(vm.runInContext('SCRIPT_DIR', fixture.context), 'C:\\fixture\\_归档脚本');
});

test('explicit script directory wins, resolves against app root, and fails clearly if missing', () => {
  const fixture = desktopFixture({
    env: { RESLIB_SCRIPT_DIR: '..\\custom-pipeline' },
    files: ['C:\\fixture\\_归档脚本\\lib.py'],
  });
  assert.equal(vm.runInContext('SCRIPT_DIR', fixture.context), 'C:\\fixture\\custom-pipeline');
  assert.throws(() => vm.runInContext('startService("display", "display/server.py", {})', fixture.context), /RESLIB_SCRIPT_DIR/);
});

test('preload exposes a read-only version request', async () => {
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), {
    process: { platform: 'win32' },
    require: () => ({
      contextBridge: { exposeInMainWorld(name, exposed) { assert.equal(name, 'reslibDesktop'); api = exposed; } },
      ipcRenderer: { invoke: async channel => channel === 'reslib:version' ? '8.4.2-test.1' : null },
    }),
  });
  assert.equal(await api.getVersion(), '8.4.2-test.1');
});
