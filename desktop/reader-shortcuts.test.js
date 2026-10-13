const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReaderShortcuts, READER_KEYS } = require('./reader-shortcuts');

function setup(rejected = []) {
  const callbacks = new Map(), messages = [], reports = [];
  const win = {
    focused: true, destroyed: false,
    isFocused() { return this.focused; },
    isDestroyed() { return this.destroyed; },
    webContents: { send: (...args) => messages.push(args) },
  };
  const api = {
    register(key, callback) {
      if (rejected.includes(key)) return false;
      callbacks.set(key, callback); return true;
    },
    unregister(key) { callbacks.delete(key); },
  };
  return { win, callbacks, messages, reports,
    controller: createReaderShortcuts(api, () => win, failed => reports.push(failed)) };
}

test('only an open, unfocused reader captures keys; each key sends one matching action', () => {
  const s = setup();
  s.win.focused = false;
  s.controller.sync();
  assert.equal(s.callbacks.size, 0);
  s.win.focused = true;
  s.controller.setActive(true);
  assert.equal(s.callbacks.size, 0);
  s.win.focused = false;
  s.controller.sync();
  s.controller.sync();
  assert.equal(s.callbacks.size, 4);
  for (const key of Object.keys(READER_KEYS)) s.callbacks.get(key)();
  assert.deepEqual(s.messages, Object.values(READER_KEYS).map(action => ['reslib:reader-action', action]));
  const stale = s.callbacks.get(']');
  s.win.focused = true;
  s.controller.sync();
  stale();
  assert.equal(s.callbacks.size, 0);
  assert.equal(s.messages.length, 4);
  s.win.focused = false;
  s.controller.sync();
  s.controller.setActive(false);
  stale();
  assert.equal(s.callbacks.size, 0);
  assert.equal(s.messages.length, 4);
});

test('navigation, renderer crash and shutdown reset release every owned key', () => {
  const s = setup();
  s.win.focused = false;
  s.controller.setActive(true);
  const stale = s.callbacks.get('=');
  s.controller.reset();
  s.controller.sync();
  stale();
  assert.equal(s.callbacks.size, 0);
  assert.equal(s.messages.length, 0);
  s.controller.setActive(true);
  s.win.destroyed = true;
  s.controller.sync();
  assert.equal(s.callbacks.size, 0);
});

test('conflicts are reported without claiming success; remaining keys still work', () => {
  const s = setup(['=']);
  s.win.focused = false;
  s.controller.setActive(true);
  assert.deepEqual(s.reports, [['=']]);
  assert.equal(s.callbacks.size, 3);
  s.callbacks.get('[')();
  assert.deepEqual(s.messages, [['reslib:reader-action', 'page-prev']]);
  s.controller.reset();
  assert.equal(s.callbacks.size, 0);
});
