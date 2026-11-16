const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function desktopFixture({ appRoot = 'C:\\fixture\\reslib-app', env = {}, files = [], role = 'display', http } = {}) {
  const handlers = new Map();
  const windows = [];
  const state = {};
  const app = {
    setPath() {}, getPath: () => 'C:\\profile', requestSingleInstanceLock: () => true,
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
      this.urls = [];
      windows.push(this);
    }
    on(name, callback) { this.events.set(name, callback); }
    setTitle(title) { this.title = title; }
    isDestroyed() { return false; }
    async loadURL(url) { this.urls.push(url); }
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
    process: { env, argv: [], execPath: path.win32.join(appRoot, 'Moonshadow-Reslib.exe'), platform: 'win32' },
    require(name) {
      if (name === '../package.json') return { reslibRole: role };
      if (name === 'electron') return electron;
      if (name === 'path') return path.win32;
      if (name === 'fs') return { existsSync: candidate => files.includes(candidate), mkdirSync() {}, appendFileSync(_path, message) { state.log = message; } };
      if (name === 'http' && http) return http;
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
  assert.equal(win.options.title, '月影黑猫 · 资源浏览 v8.4.2-test.1');
  let prevented = false;
  win.events.get('page-title-updated')({ preventDefault() { prevented = true; } }, 'Web page title');
  assert.equal(prevented, true);
  assert.equal(win.title, win.options.title);
  assert.equal(fixture.state.about.applicationVersion, '8.4.2-test.1');
  fixture.state.menu[0].submenu[0].click();
  assert.equal(fixture.state.aboutShown, true);
  assert.equal(fixture.handlers.get('reslib:version')(), '8.4.2-test.1');
});

test('fixed current directories and legacy packages locate the original project pipeline', () => {
  for (const location of ['current\\display', 'current\\management', 'v8.4.2\\release']) {
    const fixture = desktopFixture({
      appRoot: `C:\\fixture\\reslib-app\\dist\\${location}\\resources\\app`,
      files: ['C:\\fixture\\_归档脚本\\lib.py'],
    });
    assert.equal(vm.runInContext('SCRIPT_DIR', fixture.context), 'C:\\fixture\\_归档脚本');
  }
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

test('each role starts only its own service and reuses only an identified compatible service', async () => {
  for (const role of ['display', 'management']) {
    const fixture = desktopFixture({ role });
    vm.runInContext(`
      globalThis.starts = [];
      serviceIdentity = async () => null;
      startService = (name, script) => { starts.push({name, script}); return null; };
      loadDisplay = async () => {};
    `, fixture.context);
    await vm.runInContext('bootServices()', fixture.context);
    const starts = vm.runInContext('starts', fixture.context);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].name, role);
    assert.equal(starts[0].script, role === 'display' ? 'display\\server.py' : 'subscription\\server.py');
    vm.runInContext(`serviceIdentity = async () => ({status:200, application:'moonshadow-reslib',role:APP_ROLE,version:APP_VERSION});`, fixture.context);
    await vm.runInContext('bootServices()', fixture.context);
    assert.equal(starts.length, 1, 'compatible running service must be reused, not spawned or stopped');
    vm.runInContext(`serviceIdentity = async () => ({status:200, role:'legacy'});`, fixture.context);
    await assert.rejects(vm.runInContext('bootServices()', fixture.context), /端口/);
  }
});

test('a responding port that times out is never treated as an absent service', async () => {
  const fixture = desktopFixture({ http: {
    get() {
      const request = new EventEmitter();
      request.destroy = error => request.emit('error', error);
      setImmediate(() => request.emit('timeout'));
      return request;
    },
  } });
  vm.runInContext('globalThis.starts = 0; startService = () => { starts++; };', fixture.context);
  await assert.rejects(vm.runInContext('bootServices()', fixture.context), /响应超时/);
  assert.equal(vm.runInContext('starts', fixture.context), 0);
});

test('startup shows progress while refreshing and loads the resource page only after refresh', async () => {
  const fixture = desktopFixture();
  vm.runInContext(`
    globalThis.events = [];
    mainWindow = { isDestroyed: () => false, loadURL: async url => events.push(url) };
    waitForDisplay = async () => true;
    refreshDisplayIndex = async () => events.push('refresh');
  `, fixture.context);
  await vm.runInContext('loadDisplay()', fixture.context);
  const events = vm.runInContext('events', fixture.context);
  assert.match(decodeURIComponent(events[0]), /正在更新资源目录/);
  assert.equal(events[1], 'refresh');
  assert.equal(events[2], 'http://127.0.0.1:8777/');
});

test('a failed retry returns to an actionable error page and records the cause', async () => {
  const fixture = desktopFixture({ role: 'management' });
  vm.runInContext('bootServices = async () => {};', fixture.context);
  await fixture.state.ready();
  vm.runInContext('bootServices = async () => { throw Error("retry connection failed"); };', fixture.context);
  assert.equal(await fixture.handlers.get('reslib:retry')(), false);
  assert.match(decodeURIComponent(fixture.windows[0].urls.at(-1)), /retry connection failed/);
  assert.match(fixture.state.log, /retry connection failed/);
});
