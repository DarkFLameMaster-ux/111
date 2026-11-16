const READER_KEYS = Object.freeze({
  "[": "page-prev",
  "]": "page-next",
  "-": "chapter-prev",
  "=": "chapter-next",
});

// 前台沿用页面按键（保留输入框行为）；后台才向系统注册，避免一次按键翻两次。
function createReaderShortcuts(globalShortcut, getWindow, report = () => {}) {
  let reading = false;
  const registered = new Set();
  function release() {
    for (const key of registered) globalShortcut.unregister(key);
    registered.clear();
  }
  function sync() {
    const win = getWindow();
    if (!reading || !win || win.isDestroyed() || win.isFocused()) {
      release();
      return;
    }
    const failed = [];
    for (const [key, action] of Object.entries(READER_KEYS)) {
      if (registered.has(key)) continue;
      let ok = false;
      try {
        ok = globalShortcut.register(key, () => {
          const target = getWindow();
          if (reading && target && !target.isDestroyed() && !target.isFocused()) {
            target.webContents.send("reslib:reader-action", action);
          }
        });
      } catch (_) { /* 无效按键或平台拒绝时同样报告失败。 */ }
      if (ok) registered.add(key);
      else failed.push(key);
    }
    report(failed);
  }
  return {
    sync,
    setActive(active) { reading = active === true; sync(); },
    reset() { reading = false; release(); },
  };
}

module.exports = { createReaderShortcuts, READER_KEYS };
