'use strict';

// Exercises the real provider cancellation paths with a fake BrowserWindow.
//
//   1. ChatGPT (fetchChatGPTUsageData): cancellation happens while
//      executeJavaScript is pending — the exact window in which the old
//      rejection handler retried loadURL after close.
//   2. Claude (fetchViaWindow): cancellation happens while loadURL is still
//      pending — closing the window rejected that navigation with nobody
//      owning the rejection.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

let windowInstance;
let rejectScript;
let resolveScriptStarted;
const scriptStarted = new Promise((resolve) => { resolveScriptStarted = resolve; });

class FakeBrowserWindow {
  constructor() {
    windowInstance = this;
    this.destroyed = false;
    this.closeCount = 0;
    this.loadCount = 0;
    this.webRequestReleased = false;
    this.webContents = new EventEmitter();
    this.webContents.session = {
      webRequest: {
        onBeforeSendHeaders: (filter) => {
          if (filter === null) this.webRequestReleased = true;
        }
      }
    };
    this.webContents.executeJavaScript = () => {
      resolveScriptStarted();
      return new Promise((resolve, reject) => { rejectScript = reject; });
    };
  }

  isDestroyed() { return this.destroyed; }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closeCount += 1;
    if (rejectScript) rejectScript(new Error('Object has been destroyed'));
  }

  loadURL() {
    this.loadCount += 1;
    if (this.destroyed) {
      return Promise.reject(new Error('reload attempted on destroyed window'));
    }
    return Promise.resolve();
  }
}

const moduleShim = { exports: {} };
const providersPath = path.join(__dirname, '..', 'src', 'providers.js');
vm.runInNewContext(fs.readFileSync(providersPath, 'utf8'), {
  require: () => ({ BrowserWindow: FakeBrowserWindow }),
  module: moduleShim,
  setTimeout,
  clearTimeout,
  console
});

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// ── Claude: fetchViaWindow aborted while loadURL is pending ─────────────────
// Its own hidden window, whose loadURL stays pending until the window closes.

let claudeWindow;
let rejectLoad;

class FakeLoadPendingWindow {
  constructor() {
    claudeWindow = this;
    this.destroyed = false;
    this.closeCount = 0;
    this.loadCount = 0;
    this.webContents = new EventEmitter();
    this.webContents.executeJavaScript = () => new Promise(() => {});
  }

  isDestroyed() { return this.destroyed; }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closeCount += 1;
    // Electron rejects the in-flight navigation when the window goes away.
    if (rejectLoad) rejectLoad(new Error('Object has been destroyed'));
  }

  loadURL() {
    this.loadCount += 1;
    return new Promise((resolve, reject) => { rejectLoad = reject; });
  }
}

const fetchShim = { exports: {} };
const fetchViaWindowPath = path.join(__dirname, '..', 'src', 'fetch-via-window.js');
vm.runInNewContext(fs.readFileSync(fetchViaWindowPath, 'utf8'), {
  require: () => ({ BrowserWindow: FakeLoadPendingWindow }),
  module: fetchShim,
  setTimeout,
  clearTimeout,
  console
});

async function testChatGPTAbortDuringPageExecution(unhandled) {
  const controller = new AbortController();
  const fetchPromise = moduleShim.exports.fetchChatGPTUsageData({
    partition: 'synthetic-provider-test',
    signal: controller.signal
  });

  windowInstance.webContents.emit('did-finish-load');
  await scriptStarted;
  controller.abort();

  await assert.rejects(fetchPromise, /AuthFlowCancelled/);
  await settle();

  assert.strictEqual(windowInstance.loadCount, 1,
    'aborted executeJavaScript must not trigger a second loadURL');
  assert.strictEqual(windowInstance.closeCount, 1, 'provider window closes exactly once');
  assert.strictEqual(windowInstance.webRequestReleased, true, 'webRequest listener is released');
  assert.deepStrictEqual(unhandled, [], 'ChatGPT cancellation produces no unhandled rejection');
}

async function testClaudeAbortDuringPendingNavigation(unhandled) {
  const controller = new AbortController();
  const fetchPromise = fetchShim.exports.fetchViaWindow(
    'https://claude.ai/api/organizations',
    { partition: 'synthetic-provider-test', signal: controller.signal }
  );

  await settle();
  assert.strictEqual(claudeWindow.loadCount, 1, 'the navigation is in flight');
  controller.abort();

  await assert.rejects(fetchPromise, /AuthFlowCancelled/);
  await settle();

  assert.strictEqual(claudeWindow.closeCount, 1, 'Claude fetch window closes exactly once');
  assert.strictEqual(claudeWindow.loadCount, 1, 'a cancelled fetch must not retry loadURL');
  assert.deepStrictEqual(
    unhandled.map((error) => error.message), [],
    'the rejected navigation must not escape as an unhandled rejection'
  );
}

(async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  try {
    await testChatGPTAbortDuringPageExecution(unhandled);
    await testClaudeAbortDuringPendingNavigation(unhandled);
    console.log('provider cancellation tests passed');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
