/**
 * Unit tests for background.js, against an in-memory fake of the chrome APIs
 * (see fake-chrome.ts). No browser needed; run with `npm test`. The scenarios
 * mirror those in test/e2e, plus a few races that are hard to hit in a browser.
 *
 * Set BACKGROUND to the absolute path of a different background.js to run the
 * suite against another build.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FakeChrome } from './fake-chrome.ts';

const MODULE_URL = process.env.BACKGROUND
  ? pathToFileURL(resolve(process.env.BACKGROUND)).href
  : new URL('../../background.js', import.meta.url).href;

// The extension logs a lot; keep the test output readable. Errors it reports
// are collected, and fail the test.
const consoleError = console.error;
let errorSink: unknown[][] = [];
if (!process.env.DEBUG) console.log = () => {};
console.error = (...args: unknown[]) => {
  // Node's own warnings (e.g. about the missing "type" in package.json) are not the extension's.
  if (String(args[0]).includes('MODULE_TYPELESS_PACKAGE_JSON')) return;
  errorSink.push(args);
  if (process.env.DEBUG) consoleError(...args);
};

const NTP = 'chrome://newtab/';
const A = 'https://example.com/a';
const B = 'https://example.com/b';
const C = 'https://example.com/c';

describe('background', () => {
  let fake: FakeChrome;
  beforeEach(() => {
    fake = new FakeChrome();
    errorSink = [];
  });
  afterEach(async () => {
    await fake.settle();
    fake.stopWorker();
    Reflect.deleteProperty(globalThis, 'chrome');
    assert.deepEqual(fake.errors, [], 'event listeners threw');
    assert.deepEqual(errorSink, [], 'the extension reported errors');
  });

  /** Starts (or restarts) the service worker and waits for it to finish loading. */
  async function start() {
    await fake.restartWorker(MODULE_URL);
    await fake.settle();
  }

  /** Opens a tab and waits until the extension has reacted to everything. */
  async function open(url: string, opts?: Parameters<FakeChrome['openTab']>[1]) {
    const id = fake.openTab(url, opts);
    await fake.settle();
    return id;
  }

  /** The IDs stored as "fresh" in session storage. */
  function storedFresh(): number[] {
    return fake.storage.session.data.fresh ?? [];
  }

  /** Sorted URLs of the tabs in a window. */
  function urlsIn(windowId: number) {
    return fake
      .tabsOf(windowId)
      .map((t) => t.url)
      .sort();
  }

  describe('basic', () => {
    test('opening an already open URL switches to the existing tab', async () => {
      const w1 = fake.createWindow({ urls: [A, B], load: true });
      const w2 = fake.createWindow({ urls: [C] }); // focused
      await fake.settle();
      await start();
      fake.activateTab(w1.tabIds[1]); // B is active in w1
      assert.deepEqual(fake.current(), { windowId: w2.windowId, tabId: w2.tabIds[0] });

      const dup = fake.openTab(A, { windowId: w2.windowId });
      await fake.settle();

      assert.equal(fake.isOpen(dup), false, 'the new tab is closed');
      assert.deepEqual(fake.urls(), [A, B, C]);
      assert.deepEqual(fake.current(), { windowId: w1.windowId, tabId: w1.tabIds[0] });
    });

    test('different URLs are kept', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      await open(A + '?x=1');
      await open(B);
      assert.deepEqual(fake.urls(), [A, A + '?x=1', B]);
    });

    test('deduplicates URLs with a fragment', async () => {
      const w = fake.createWindow({ urls: [A + '#x'] });
      await start();
      await open(A + '#x');
      assert.deepEqual(fake.urls(), [A + '#x']);
      assert.equal(fake.tabsOf(w.windowId).length, 1);
    });

    test('keeps URLs that differ in the fragment', async () => {
      fake.createWindow({ urls: [A + '#x'] });
      await start();
      await open(A + '#y');
      await open(A);
      assert.deepEqual(fake.urls(), [A, A + '#x', A + '#y']);
    });

    test('"*" in a URL is not a wildcard', async () => {
      fake.createWindow({ urls: ['https://example.com/search/abc'] });
      await start();
      await open('https://example.com/search/a*');
      assert.deepEqual(fake.urls(), [
        'https://example.com/search/a*',
        'https://example.com/search/abc',
      ]);
    });

    test('a URL with "*" matches only itself, not other URLs', async () => {
      fake.createWindow({ urls: ['https://example.com/search/a*'] });
      await start();
      await open('https://example.com/search/abc'); // not a duplicate
      await open('https://example.com/search/a*'); // a duplicate
      assert.deepEqual(fake.urls(), [
        'https://example.com/search/a*',
        'https://example.com/search/abc',
      ]);
    });

    test('local files are deduplicated', async () => {
      fake.createWindow({ urls: ['file:///tmp/a.html'] });
      await start();
      await open('file:///tmp/a.html');
      assert.deepEqual(fake.urls(), ['file:///tmp/a.html']);
    });

    test('deduplicates a tab opened in the background', async () => {
      const w = fake.createWindow({ urls: [A, B] });
      await start();
      fake.activateTab(w.tabIds[1]);
      await open(A, { active: false });
      assert.deepEqual(fake.urls(), [A, B]);
      assert.equal(fake.current()?.tabId, w.tabIds[0]);
    });

    test('deduplicates against a tab that is still loading', async () => {
      fake.createWindow({ urls: [B] });
      await start();
      const first = fake.openTab(A, { load: false }); // pending, not committed
      await fake.settle();
      const second = await open(A);
      assert.equal(fake.isOpen(first), true);
      assert.equal(fake.isOpen(second), false);
    });
  });

  describe('incognito and special windows', () => {
    test('an incognito tab is not deduplicated against a regular tab', async () => {
      fake.createWindow({ urls: [A] });
      const incognito = fake.createWindow({ urls: [B], incognito: true });
      await start();
      await open(A, { windowId: incognito.windowId });
      assert.deepEqual(fake.urls(), [A, A, B]);
    });

    test('a regular tab is not deduplicated against an incognito tab', async () => {
      const regular = fake.createWindow({ urls: [B] });
      fake.createWindow({ urls: [A], incognito: true });
      await start();
      await open(A, { windowId: regular.windowId });
      assert.deepEqual(fake.urls(), [A, A, B]);
    });

    test('incognito tabs are deduplicated against each other', async () => {
      fake.createWindow({ urls: [B] });
      const i1 = fake.createWindow({ urls: [A], incognito: true });
      const i2 = fake.createWindow({ urls: [C], incognito: true });
      await start();
      await open(A, { windowId: i2.windowId });
      assert.deepEqual(fake.urls(), [A, B, C]);
      assert.deepEqual(fake.current(), { windowId: i1.windowId, tabId: i1.tabIds[0] });
    });

    for (const type of ['popup', 'app']) {
      test(`a new tab in a ${type} window is kept`, async () => {
        fake.createWindow({ urls: [A] });
        await start();
        fake.createWindow({ type, urls: [A] });
        await fake.settle();
        assert.deepEqual(fake.urls(), [A, A]);
        // Also when the popup shows a page after having been created, and so does a tab in it.
        const popup = fake.createWindow({ type, urls: [NTP] });
        await fake.settle();
        fake.navigate(popup.tabIds[0], A);
        await fake.settle();
        assert.deepEqual(fake.urls(), [A, A, A]);
      });

      test(`an existing tab in a ${type} window is not used`, async () => {
        fake.createWindow({ urls: [B] });
        fake.createWindow({ type, urls: [A] });
        await start();
        await open(A);
        assert.deepEqual(fake.urls(), [A, A, B]);
      });
    }
  });

  describe('concurrency', () => {
    test('two tabs created at once with the same URL: one survives', async () => {
      const w = fake.createWindow({ urls: [B] });
      await start();
      fake.openTab(A, { windowId: w.windowId });
      fake.openTab(A, { windowId: w.windowId });
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, B]);
    });

    test('two tabs created at once in different windows: one survives', async () => {
      const w1 = fake.createWindow({ urls: [B] });
      const w2 = fake.createWindow({ urls: [C] });
      await start();
      fake.openTab(A, { windowId: w1.windowId });
      fake.openTab(A, { windowId: w2.windowId });
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, B, C]);
    });

    test('two windows created at once with the same URL: one survives', async () => {
      fake.createWindow({ urls: [B] });
      await start();
      fake.createWindow({ urls: [A] });
      fake.createWindow({ urls: [A] });
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, B]);
    });

    test('three tabs created at once with the same URL: one survives', async () => {
      const w = fake.createWindow({ urls: [B] });
      await start();
      for (let i = 0; i < 3; i++) fake.openTab(A, { windowId: w.windowId });
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, B]);
    });
  });

  describe('new tabs that navigate', () => {
    test('typing an open URL into a new tab', async () => {
      const w = fake.createWindow({ urls: [A, B] });
      await start();
      const ntp = await open(NTP);
      assert.deepEqual(fake.current(), { windowId: w.windowId, tabId: ntp });
      fake.navigate(ntp, A);
      await fake.settle();
      assert.equal(fake.isOpen(ntp), false);
      assert.deepEqual(fake.urls(), [A, B]);
      assert.deepEqual(fake.current(), { windowId: w.windowId, tabId: w.tabIds[0] });
    });

    test('typing an open URL into a new tab after the worker was restarted', async () => {
      fake.createWindow({ urls: [A, B] });
      await start();
      const ntp = await open(NTP);
      assert.deepEqual(storedFresh(), [ntp]);
      await start(); // the worker was suspended while the user was typing
      fake.navigate(ntp, A);
      await fake.settle();
      assert.equal(fake.isOpen(ntp), false);
      assert.deepEqual(fake.urls(), [A, B]);
    });

    test('typing an open URL into a new tab when waking the worker while storage is slow', async () => {
      fake.createWindow({ urls: [A, B] });
      await start();
      const ntp = await open(NTP);
      fake.stopWorker();
      fake.storageGetDelay = 50;
      await fake.startWorker(MODULE_URL);
      // The navigation that wakes the worker is dispatched before the stored
      // state has loaded.
      fake.navigate(ntp, A, { load: false });
      fake.commit(ntp);
      await fake.settle();
      assert.equal(fake.isOpen(ntp), false);
      assert.deepEqual(fake.urls(), [A, B]);
    });

    test('a new tab created while storage is still loading is deduplicated', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      fake.stopWorker();
      fake.storageGetDelay = 50;
      await fake.startWorker(MODULE_URL);
      fake.openTab(A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A]);
    });

    test('a new tab that navigates to a URL that is not open is kept', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const ntp = await open(NTP);
      fake.navigate(ntp, B);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, B]);
      assert.deepEqual(storedFresh(), []);
    });

    test('a new tab redirected to an open URL before it commits', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const tab = fake.openTab('https://example.com/redirect', { load: false });
      await fake.settle();
      fake.redirect(tab, A);
      fake.commit(tab);
      fake.complete(tab);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A]);
    });

    test('a new tab redirected to an open URL before the load completes', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const tab = fake.openTab('https://example.com/redirect', { load: false });
      fake.commit(tab);
      await fake.settle();
      assert.equal(fake.isOpen(tab), true);
      fake.redirect(tab, A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A]);
    });

    test('a blank tab that is navigated to an open URL (window.open)', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const tab = await open('about:blank');
      fake.navigate(tab, A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A]);
    });

    test('a tab whose first page finished loading is kept when it navigates to an open URL', async () => {
      const w = fake.createWindow({ urls: [A] });
      await start();
      const other = await open(B);
      fake.navigate(other, A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, A]);
      assert.equal(fake.isOpen(other), true);
      assert.deepEqual(fake.current(), { windowId: w.windowId, tabId: other });
    });

    test('a tab whose first page finished loading is kept after a worker restart', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const other = await open(B);
      await start();
      fake.navigate(other, A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, A]);
    });

    test('a tab that existed before the extension started is kept when it navigates', async () => {
      fake.createWindow({ urls: [A, B] });
      await start();
      const tab = fake.tabs.find((t) => t.url === B)!.id;
      fake.navigate(tab, A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, A]);
    });

    test('a tab keeps being checked until its first page loads, e.g. after a redirect', async () => {
      fake.createWindow({ urls: [A, B] });
      await start();
      const tab = fake.openTab(C, { load: false });
      fake.commit(tab); // /c is not open, but the tab is still loading
      await fake.settle();
      fake.redirect(tab, B);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, B]);
    });
  });

  describe('windows', () => {
    test('a new window with a duplicate keeps its other tabs', async () => {
      const w1 = fake.createWindow({ urls: [A] });
      await start();
      const w2 = fake.createWindow({ urls: [A, B] });
      await fake.settle();
      assert.deepEqual(urlsIn(w1.windowId), [A]);
      assert.deepEqual(urlsIn(w2.windowId), [B]);
      assert.equal(fake.windows.size, 2);
      // The user ends up in the existing tab.
      assert.deepEqual(fake.current(), { windowId: w1.windowId, tabId: w1.tabIds[0] });
    });

    test('a new window with a duplicate in the middle keeps its other tabs', async () => {
      fake.createWindow({ urls: [B] });
      await start();
      const w2 = fake.createWindow({ urls: [A, B, C] });
      await fake.settle();
      assert.deepEqual(urlsIn(w2.windowId), [A, C]);
    });

    test('a new window with just a duplicate is closed', async () => {
      const w1 = fake.createWindow({ urls: [A, B] });
      await start();
      const w2 = fake.createWindow({ urls: [A] });
      await fake.settle();
      assert.equal(fake.windows.has(w2.windowId), false);
      assert.deepEqual(fake.urls(), [A, B]);
      assert.deepEqual(fake.current(), { windowId: w1.windowId, tabId: w1.tabIds[0] });
    });

    test('a window with several duplicates keeps nothing', async () => {
      fake.createWindow({ urls: [A, B] });
      await start();
      const w2 = fake.createWindow({ urls: [A, B] });
      await fake.settle();
      assert.equal(fake.windows.has(w2.windowId), false);
      assert.deepEqual(fake.urls(), [A, B]);
    });

    test('a restored window with a duplicate keeps its other tabs', async () => {
      const closed = fake.createWindow({ urls: [A, B] });
      await start();
      fake.closeWindow(closed.windowId);
      await fake.settle();
      const w = fake.createWindow({ urls: [A] });
      await fake.settle();
      assert.deepEqual(fake.urls(), [A]);
      // Like Ctrl+Shift+T: the window comes back with all its tabs at once.
      const restored = fake.createWindow({ urls: [A, B] });
      await fake.settle();
      assert.deepEqual(urlsIn(restored.windowId), [B]);
      assert.deepEqual(fake.current(), { windowId: w.windowId, tabId: w.tabIds[0] });
    });

    test('prefers an existing tab in the same window', async () => {
      const w1 = fake.createWindow({ urls: [A] });
      const w2 = fake.createWindow({ urls: [B, A] });
      await start();
      // w2's A is more recent than w1's, and w1's A is more recent than w2's:
      fake.activateTab(w1.tabIds[0]);
      fake.focusWindow(w2.windowId);
      fake.activateTab(w2.tabIds[0]);
      fake.activateTab(w1.tabIds[0]);
      await open(A, { windowId: w2.windowId });
      assert.deepEqual(fake.current(), { windowId: w2.windowId, tabId: w2.tabIds[1] });
      assert.equal(fake.tabsOf(w2.windowId).length, 2);
    });

    test('otherwise prefers the most recently accessed tab', async () => {
      const w1 = fake.createWindow({ urls: [A, B] });
      const w2 = fake.createWindow({ urls: [A, B] });
      const w3 = fake.createWindow({ urls: [C] });
      await start();
      fake.activateTab(w1.tabIds[0]); // w1's A is the most recently used
      await open(A, { windowId: w3.windowId });
      assert.deepEqual(fake.current(), { windowId: w1.windowId, tabId: w1.tabIds[0] });

      fake.activateTab(w2.tabIds[0]); // now w2's
      fake.focusWindow(w3.windowId);
      await open(A, { windowId: w3.windowId });
      assert.deepEqual(fake.current(), { windowId: w2.windowId, tabId: w2.tabIds[0] });
    });

    test('a tab in the same window beats a more recent one in another window', async () => {
      const w1 = fake.createWindow({ urls: [A, B] });
      const w2 = fake.createWindow({ urls: [A, B] });
      await start();
      fake.activateTab(w2.tabIds[0]); // most recent overall, but the new tab is in w1
      await open(A, { windowId: w1.windowId });
      assert.deepEqual(fake.current(), { windowId: w1.windowId, tabId: w1.tabIds[0] });
    });
  });

  describe('ignored URLs', () => {
    const ignored = [
      'chrome://settings/',
      'about:blank',
      'data:text/html,hello',
      'chrome-extension://abcdef/page.html',
      NTP,
    ];
    for (const url of ignored) {
      test(`${url} is never deduplicated`, async () => {
        const w = fake.createWindow({ urls: [url] });
        await start();
        await open(url);
        await open(url, { windowId: w.windowId });
        // And when navigated to by a tab that is new.
        const ntp = await open(NTP);
        fake.navigate(ntp, url);
        await fake.settle();
        assert.equal(fake.tabs.length, 4);
        assert.equal(fake.windows.size, 1);
      });
    }

    test('a new window with ignored URLs is kept', async () => {
      fake.createWindow({ urls: ['about:blank'] });
      await start();
      const w = fake.createWindow({ urls: ['about:blank', 'chrome://settings/'] });
      await fake.settle();
      assert.equal(fake.tabsOf(w.windowId).length, 2);
    });
  });

  describe('state', () => {
    test('fresh tabs are remembered in session storage, and forgotten once loaded', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const tab = fake.openTab(B, { load: false });
      await fake.settle();
      assert.deepEqual(storedFresh(), [tab]);
      fake.commit(tab);
      await fake.settle();
      assert.deepEqual(storedFresh(), [tab]);
      fake.complete(tab);
      await fake.settle();
      assert.deepEqual(storedFresh(), []);
    });

    test('state of closed tabs is forgotten', async () => {
      const w = fake.createWindow({ urls: [A] });
      await start();
      const t1 = fake.openTab(B, { load: false });
      const t2 = fake.openTab(C, { load: false });
      await fake.settle();
      assert.deepEqual(storedFresh().sort(), [t1, t2]);
      fake.closeTab(t1);
      await fake.settle();
      assert.deepEqual(storedFresh(), [t2]);
      fake.closeWindow(w.windowId);
      await fake.settle();
      assert.deepEqual(storedFresh(), []);
    });

    test('state of deduplicated tabs is forgotten', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      await open(A);
      const ntp = await open(NTP);
      fake.navigate(ntp, A);
      await fake.settle();
      assert.deepEqual(storedFresh(), []);
    });

    test('session storage does not grow when many tabs are opened and closed', async () => {
      const w = fake.createWindow({ urls: [A] });
      await start();
      for (let i = 0; i < 10; i++) {
        const tab = await open(`https://example.com/page/${i}`, { windowId: w.windowId });
        if (i % 2) fake.closeTab(tab);
        await open(A, { windowId: w.windowId }); // a duplicate
        await open(NTP, { windowId: w.windowId });
        await fake.settle();
      }
      // Only the new tab pages are fresh.
      const ntps = fake.tabs.filter((t) => t.url === NTP).map((t) => t.id);
      assert.deepEqual(
        storedFresh().sort((a, b) => a - b),
        ntps,
      );
      for (const id of ntps) fake.closeTab(id);
      await fake.settle();
      assert.deepEqual(storedFresh(), []);
      assert.deepEqual(Object.keys(fake.storage.session.data).sort(), ['fresh']);
    });

    test('stale state does not make a tab fresh', async () => {
      fake.createWindow({ urls: [A, B] });
      const stale = fake.tabs[1].id;
      fake.storage.session.data.fresh = [stale, 9999];
      await fake.settle();
      await start();
      // B is considered fresh (the state says so), but 9999 does not exist.
      fake.navigate(stale, A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A]);
    });

    test('onReplaced carries freshness over to the new tab ID', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const ntp = await open(NTP);
      const replacement = fake.replaceTab(ntp);
      await fake.settle();
      assert.deepEqual(storedFresh(), [replacement]);
      fake.navigate(replacement, A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A]);
      assert.deepEqual(storedFresh(), []);
    });

    test('onReplaced does not make a tab fresh that was not', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const tab = await open(B);
      const replacement = fake.replaceTab(tab);
      await fake.settle();
      assert.deepEqual(storedFresh(), []);
      fake.navigate(replacement, A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A, A]);
    });

    // The worker is woken by onReplaced: by the time it has loaded its state, the
    // old tab ID no longer exists, but its freshness must still carry over.
    test('onReplaced that wakes up the worker carries freshness over', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const ntp = await open(NTP);
      fake.stopWorker();
      await fake.startWorker(MODULE_URL);
      const replacement = fake.replaceTab(ntp);
      await fake.settle();
      assert.deepEqual(storedFresh(), [replacement]);
      fake.navigate(replacement, A);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A]);
    });

    test('onReplaced that wakes up the worker while storage is slow carries freshness over', async () => {
      fake.createWindow({ urls: [A] });
      await start();
      const ntp = await open(NTP);
      fake.stopWorker();
      fake.storageGetDelay = 50;
      await fake.startWorker(MODULE_URL);
      const replacement = fake.replaceTab(ntp);
      fake.navigate(replacement, A, { load: false });
      fake.commit(replacement);
      await fake.settle();
      assert.deepEqual(fake.urls(), [A]);
    });
  });
});
