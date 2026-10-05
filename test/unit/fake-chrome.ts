/**
 * A small in-memory fake of the parts of the `chrome` extension API that
 * background.js uses, for fast unit tests without a browser.
 *
 * The fake models a world of windows ({id, type, focused, incognito}) and tabs
 * ({id, windowId, url, pendingUrl, status, active, incognito, lastAccessed}).
 * The `chrome.*` API methods read and mutate that world and fire the events
 * Chrome would fire in response (`tabs.remove` fires `tabs.onRemoved`, ...).
 * The helper methods on FakeChrome (`openTab`, `navigate`, `redirect`,
 * `createWindow`, `closeTab`, ...) play the user, or the browser itself, and do
 * the same.
 *
 * Like in Chrome, everything is asynchronous: API methods return promises that
 * resolve a moment after their effect took place, and event listeners are
 * invoked from a separate task, never synchronously from whatever fired the
 * event. `settle()` waits until all of that has died down.
 *
 * Use `restartWorker()` to simulate the service worker being terminated and
 * woken up again: `storage.session` survives, listeners do not, and the module
 * is evaluated afresh.
 *
 * Page loads. A tab that is opened or navigated has a `pendingUrl` and status
 * 'loading'. Then, unless `load: false` is passed, the fake commits the URL
 * (`url` is set, `pendingUrl` cleared, onUpdated({url})) and completes the load
 * (onUpdated({status: 'complete'})), `loadDelay` ms apart. With `load: false`
 * the test drives the steps by hand with `commit()` and `complete()`, e.g. to
 * interleave other events, or to fire them right after the worker was woken up.
 */

import { asTuple, type Tuple } from '../tuple.ts';

const WINDOW_ID_NONE = -1;

/** Makes every module evaluation unique, across FakeChrome instances too (ES modules are cached by URL). */
let workerCount = 0;

type FakeWindow = { id: number; type: string; focused: boolean; incognito: boolean };
type FakeTab = {
  id: number;
  windowId: number;
  url: string;
  pendingUrl?: string | undefined;
  status: string;
  active: boolean;
  incognito: boolean;
  lastAccessed: number;
};
type FakeTabSnapshot = FakeTab & { index: number };
// Listeners of different events take different arguments.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = { fn: (...args: any[]) => unknown };
type TabQuery = {
  active?: boolean;
  windowId?: number;
  windowType?: string;
  url?: string | string[];
};
type LoadOptions = { load?: boolean };

/** A `chrome.*.onSomething` event. */
class FakeEvent {
  listeners: Listener[] = [];

  env: FakeChrome;

  constructor(env: FakeChrome) {
    this.env = env;
  }

  addListener(fn: Listener['fn']) {
    this.listeners.push({ fn });
  }

  removeListener(fn: Listener['fn']) {
    this.listeners = this.listeners.filter((l) => l.fn !== fn);
  }

  hasListener(fn: Listener['fn']) {
    return this.listeners.some((l) => l.fn === fn);
  }

  /** Invokes all current listeners, asynchronously. Arguments are captured now. */
  fire(...args: unknown[]) {
    for (const listener of this.listeners) {
      this.env.schedule(() => {
        // The worker may have been restarted in the meantime.
        return this.listeners.includes(listener)
          ? listener.fn(...structuredClone(args))
          : undefined;
      });
    }
  }
}

/** A `chrome.storage.*` area. Values are copied on the way in and out. */
class FakeStorageArea {
  env: FakeChrome;
  /** The stored items; survives worker restarts. */
  data: Record<string, unknown> = {};

  constructor(env: FakeChrome) {
    this.env = env;
  }

  /**
   * @param keys Keys to read; an object also provides defaults for missing keys.
   */
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    if (keys == null) {
      Object.assign(result, this.data);
    } else if (typeof keys === 'string' || Array.isArray(keys)) {
      for (const key of [keys].flat()) {
        if (key in this.data) result[key] = this.data[key];
      }
    } else {
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = key in this.data ? this.data[key] : fallback;
      }
    }
    const copy = structuredClone(result);
    return this.env.call(() => copy, this.env.storageGetDelay);
  }

  set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, structuredClone(items));
    return this.env.call(() => undefined);
  }
}

/**
 * Whether a match pattern (as in `chrome.tabs.query({url})`) matches a URL.
 *
 * This models what Chrome was observed to do, not the full specification: "*"
 * is a wildcard matching any characters, and a pattern that contains a
 * "#fragment" never matches any URL (Chrome ignores fragments in patterns
 * rather than matching them). Scheme and host are not validated.
 */
export function matchesPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url);
  if (pattern.includes('#')) return false;
  const re = pattern
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`).test(url);
}

export class FakeChrome {
  windows = new Map<number, FakeWindow>();
  /** All tabs; the order within a window is the tab order. */
  tabs: FakeTab[] = [];
  /** Window IDs, most recently focused first. */
  focusOrder: number[] = [];
  nextTabId = 1;
  nextWindowId = 1001;
  /** Latest page load per tab. */
  loadTokens = new WeakMap<FakeTab, number>();
  /** A fake clock for `lastAccessed`; every access moves it forward. */
  clock = 1_000_000;

  /**
   * Artificial latency (ms) of `storage.*.get`, to reproduce the race where
   * the event that woke the worker arrives before storage was loaded.
   */
  storageGetDelay = 0;
  /** Time (ms) between the steps of a page load: commit, then complete. */
  loadDelay = 2;
  /** Exceptions thrown by event listeners. Tests should assert this stays empty. */
  errors: unknown[] = [];
  /** Number of in-flight API calls, event deliveries and timers. */
  pending = 0;

  storage = { session: new FakeStorageArea(this) };
  tabsOnCreated = new FakeEvent(this);
  tabsOnUpdated = new FakeEvent(this);
  tabsOnRemoved = new FakeEvent(this);
  tabsOnReplaced = new FakeEvent(this);
  windowsOnCreated = new FakeEvent(this);
  events: FakeEvent[] = [
    this.tabsOnCreated,
    this.tabsOnUpdated,
    this.tabsOnRemoved,
    this.tabsOnReplaced,
    this.windowsOnCreated,
  ];

  /**
   * The object to install as `globalThis.chrome`. It only implements the
   * subset of the API that the extension uses, hence the loose type.
   */
  chrome: Record<string, unknown>;

  constructor() {
    this.chrome = {
      storage: this.storage,
      tabs: {
        query: (q?: TabQuery) => this.call(() => this.queryTabs(q)),
        get: (id: number) => this.call(() => this.snapshotTab(this.tab(id))),
        update: (id: number, props?: { active?: boolean }) =>
          this.call(() => this.updateTab(id, props)),
        remove: (ids: number | number[]) => this.call(() => this.removeTabs([ids].flat())),
        onCreated: this.tabsOnCreated,
        onUpdated: this.tabsOnUpdated,
        onRemoved: this.tabsOnRemoved,
        onReplaced: this.tabsOnReplaced,
      },
      windows: {
        WINDOW_ID_NONE,
        get: (id: number) => this.call(() => this.snapshotWindow(this.window(id))),
        update: (id: number, props?: { focused?: boolean }) =>
          this.call(() => this.updateWindow(id, props)),
        // Only used by the pre-fix build of the extension.
        remove: (id: number) => this.call(() => this.closeWindow(id)),
        onCreated: this.windowsOnCreated,
      },
    };
  }

  // ---- Service worker lifecycle ----

  /** Makes this the global `chrome`. */
  install() {
    // The fake only implements part of the chrome API, so it can't be
    // type-checked against the real `typeof chrome`; cast it.
    globalThis.chrome = this.chrome as unknown as typeof chrome;
  }

  /** Drops all listeners, as if the service worker was terminated. */
  stopWorker() {
    for (const event of this.events) event.listeners = [];
  }

  /**
   * Starts the worker: evaluates the module afresh, so it registers its
   * listeners and starts loading its state from storage. The returned promise
   * resolves when the module is evaluated, not when it finished loading. The
   * event that wakes up a real worker is dispatched after this point, so fire
   * it (e.g. with `commit`) after awaiting this and before `settle()`.
   *
   * @param moduleUrl URL of the module (a file: URL).
   */
  async startWorker(moduleUrl: string) {
    this.install();
    await import(`${moduleUrl}?worker=${++workerCount}`);
  }

  /** Stops and starts the worker. Storage and the world persist. */
  async restartWorker(moduleUrl: string) {
    this.stopWorker();
    await this.startWorker(moduleUrl);
  }

  // ---- Settling ----

  /** Runs `fn` as an asynchronous task, tracking it for `settle()`. */
  schedule(fn: () => unknown) {
    this.pending++;
    setTimeout(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => this.errors.push(e))
        .finally(() => this.pending--);
    }, 0);
  }

  /**
   * Runs an API call: `fn` takes effect immediately, but the promise only
   * settles after `delay` ms. Errors thrown by `fn` become rejections.
   */
  call<T>(fn: () => T, delay = 0): Promise<T> {
    let result: T | undefined,
      error: unknown,
      failed = false;
    try {
      result = fn();
    } catch (e) {
      error = e;
      failed = true;
    }
    this.pending++;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.pending--;
        if (failed) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(result as T);
      }, delay);
    });
  }

  /** Runs `fn` after a delay, counting as in flight for `settle()` meanwhile. */
  after(ms: number, fn: () => void) {
    this.pending++;
    setTimeout(() => {
      this.pending--;
      fn();
    }, ms);
  }

  /**
   * Waits until no API calls, event deliveries or page load steps are in
   * flight, i.e. until the extension has reacted to everything that happened so
   * far. Everything the extension does in between those calls happens in
   * microtasks, so it is complete once nothing is pending at a task boundary.
   */
  async settle() {
    const deadline = Date.now() + 5000;
    let idleRounds = 0;
    while (idleRounds < 2) {
      if (Date.now() > deadline) {
        throw new Error(`settle() timed out, ${this.pending} calls pending`);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      idleRounds = this.pending === 0 ? idleRounds + 1 : 0;
    }
  }

  // ---- World lookups ----

  tab(id: number): FakeTab {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    return tab;
  }

  window(id: number): FakeWindow {
    const window = this.windows.get(id);
    if (!window) throw new Error(`No window with id: ${id}`);
    return window;
  }

  tabsOf(windowId: number): FakeTab[] {
    return this.tabs.filter((t) => t.windowId === windowId);
  }

  snapshotTab(tab: FakeTab): FakeTabSnapshot {
    const copy: FakeTabSnapshot = { ...tab, index: this.tabsOf(tab.windowId).indexOf(tab) };
    if (copy.pendingUrl === undefined) delete copy.pendingUrl;
    return copy;
  }

  snapshotWindow(window: FakeWindow): FakeWindow {
    return { ...window };
  }

  /** The window that has focus, if any. */
  focusedWindow(): FakeWindow | undefined {
    return [...this.windows.values()].find((w) => w.focused);
  }

  /** What the user is looking at: the focused window and its active tab, if any. */
  current(): { windowId: number; tabId: number | undefined } | undefined {
    const window = this.focusedWindow();
    if (!window) return undefined;
    return { windowId: window.id, tabId: this.tabsOf(window.id).find((t) => t.active)?.id };
  }

  /** Sorted URLs of all tabs (the pending URL for tabs that have not committed yet). */
  urls(): string[] {
    return this.tabs.map((t) => t.url || t.pendingUrl || '').sort();
  }

  /** Whether the tab exists. */
  isOpen(tabId: number): boolean {
    return this.tabs.some((t) => t.id === tabId);
  }

  /** The default window for new tabs: the last focused regular window. */
  defaultWindowId(): number {
    for (const id of this.focusOrder) {
      const w = this.windows.get(id);
      if (w && w.type === 'normal' && !w.incognito) return id;
    }
    throw new Error('No regular window to open a tab in; call createWindow() first');
  }

  // ---- Implementations of the chrome.* calls ----

  queryTabs(q: TabQuery = {}) {
    const patterns = q.url === undefined ? undefined : [q.url].flat();
    return (
      this.tabs
        .filter((t) => q.active === undefined || t.active === q.active)
        .filter((t) => q.windowId === undefined || t.windowId === q.windowId)
        .filter((t) => q.windowType === undefined || this.window(t.windowId).type === q.windowType)
        // Chrome matches patterns against the committed URL only.
        .filter((t) => !patterns || patterns.some((p) => matchesPattern(p, t.url)))
        .map((t) => this.snapshotTab(t))
    );
  }

  updateTab(id: number, props: { active?: boolean } = {}) {
    const tab = this.tab(id);
    if (props.active) this.activate(tab);
    return this.snapshotTab(tab);
  }

  updateWindow(id: number, props: { focused?: boolean } = {}) {
    const window = this.window(id);
    if (props.focused) this.focus(window.id);
    return this.snapshotWindow(window);
  }

  removeTabs(ids: number[]) {
    for (const id of ids) this.tab(id); // throws if any is missing
    for (const id of ids) if (this.isOpen(id)) this.closeTab(id);
  }

  // ---- State changes that fire events ----

  touch(tab: FakeTab) {
    tab.lastAccessed = this.clock += 1000;
  }

  /** Makes the tab the active one of its window and marks it accessed. */
  activate(tab: FakeTab) {
    for (const t of this.tabsOf(tab.windowId)) t.active = false;
    tab.active = true;
    this.touch(tab);
  }

  /** Gives the window focus. */
  focus(windowId: number) {
    this.window(windowId);
    for (const w of this.windows.values()) w.focused = w.id === windowId;
    this.focusOrder = [windowId, ...this.focusOrder.filter((id) => id !== windowId)];
  }

  // ---- Helpers: the user, or the browser, doing things ----

  /**
   * Creates a window with a tab per URL, like `chrome.windows.create({url:
   * urls})`: fires windows.onCreated, then tabs.onCreated for each tab, which
   * then load (see the file comment). The first tab is active. By default the
   * window is focused and shows a new tab page.
   */
  createWindow<const U extends readonly string[] = readonly [string]>({
    type = 'normal',
    urls = ['chrome://newtab/'] as readonly string[] as U,
    incognito = false,
    focused = true,
    load = true,
  }: {
    type?: string;
    urls?: U;
    incognito?: boolean;
    focused?: boolean;
    load?: boolean;
  } = {}): { windowId: number; tabIds: Tuple<number, U['length']> } {
    const windowId = this.nextWindowId++;
    this.windows.set(windowId, { id: windowId, type, focused: false, incognito });
    this.focusOrder.push(windowId);
    if (focused) this.focus(windowId);
    this.windowsOnCreated.fire(this.snapshotWindow(this.window(windowId)));
    const tabIds = urls.map((url, i) => this.addTab(windowId, url, { active: i === 0, load }));
    return { windowId, tabIds: asTuple<number, U['length']>(tabIds, urls.length) };
  }

  /**
   * Opens a tab, like a link opened in a new tab, `chrome.tabs.create` or the
   * "+" button does. It starts out with a pendingUrl and no url, and fires
   * onCreated followed by onUpdated({status: 'loading'}). Returns the tab ID.
   *
   * `load: false` leaves the tab loading, to be driven with `commit()` and
   * `complete()`.
   */
  openTab(
    url: string,
    {
      windowId = this.defaultWindowId(),
      active = true,
      load = true,
    }: { windowId?: number; active?: boolean } & LoadOptions = {},
  ): number {
    return this.addTab(windowId, url, { active, load });
  }

  addTab(
    windowId: number,
    url: string,
    { active, load }: { active: boolean; load: boolean },
  ): number {
    const window = this.window(windowId);
    const tab: FakeTab = {
      id: this.nextTabId++,
      windowId,
      url: '',
      pendingUrl: url,
      status: 'loading',
      active: false,
      incognito: window.incognito,
      lastAccessed: 0,
    };
    this.tabs.push(tab);
    this.touch(tab);
    if (active) this.activate(tab);
    this.tabsOnCreated.fire(this.snapshotTab(tab));
    this.tabsOnUpdated.fire(tab.id, { status: 'loading' }, this.snapshotTab(tab));
    if (load) this.autoLoad(tab);
    return tab.id;
  }

  /** Commits the pending URL after `loadDelay`, and completes the load after another. */
  autoLoad(tab: FakeTab) {
    // A newer navigation of the same tab cancels the steps of this one.
    const token = (this.loadTokens.get(tab) ?? 0) + 1;
    this.loadTokens.set(tab, token);
    const live = () => this.tabs.includes(tab) && this.loadTokens.get(tab) === token;
    this.after(this.loadDelay, () => {
      if (!live()) return;
      if (tab.pendingUrl !== undefined) this.commit(tab.id);
      this.after(this.loadDelay, () => {
        if (live() && tab.status === 'loading') this.complete(tab.id);
      });
    });
  }

  /** The tab's navigation commits: its URL changes, onUpdated({url}) fires. */
  commit(tabId: number) {
    const tab = this.tab(tabId);
    if (tab.pendingUrl === undefined) throw new Error(`Tab ${tabId} has no navigation to commit`);
    tab.url = tab.pendingUrl;
    tab.pendingUrl = undefined;
    this.tabsOnUpdated.fire(tabId, { url: tab.url }, this.snapshotTab(tab));
  }

  /** The tab finishes loading: onUpdated({status: 'complete'}) fires. */
  complete(tabId: number) {
    const tab = this.tab(tabId);
    if (tab.pendingUrl !== undefined) {
      throw new Error(`Tab ${tabId} has not committed its navigation yet`);
    }
    tab.status = 'complete';
    this.tabsOnUpdated.fire(tabId, { status: 'complete' }, this.snapshotTab(tab));
  }

  /**
   * Navigates an existing tab (the user types a URL, a link is clicked,
   * `chrome.tabs.update({url})`): pendingUrl is set, onUpdated({status:
   * 'loading'}) fires, then the navigation commits and completes as for
   * `openTab`.
   */
  navigate(tabId: number, url: string, { load = true }: LoadOptions = {}) {
    const tab = this.tab(tabId);
    tab.pendingUrl = url;
    tab.status = 'loading';
    this.tabsOnUpdated.fire(tabId, { status: 'loading' }, this.snapshotTab(tab));
    if (load) {
      this.autoLoad(tab);
    } else {
      this.loadTokens.set(tab, (this.loadTokens.get(tab) ?? 0) + 1); // cancels a load in progress
    }
  }

  /**
   * A redirect. If the tab has not committed its navigation yet, the pending
   * URL changes silently (Chrome reports nothing until the commit). Otherwise
   * the tab's URL changes while it is still loading, e.g. through a
   * `<meta refresh>` or `location.replace()`, and onUpdated({url}) fires.
   */
  redirect(tabId: number, url: string) {
    const tab = this.tab(tabId);
    if (tab.pendingUrl !== undefined) {
      tab.pendingUrl = url;
    } else {
      tab.url = url;
      this.tabsOnUpdated.fire(tabId, { url }, this.snapshotTab(tab));
    }
  }

  /** Swaps a tab's ID, as prerendering or discarding does, and fires onReplaced. Returns the new ID. */
  replaceTab(oldId: number): number {
    const tab = this.tab(oldId);
    tab.id = this.nextTabId++;
    this.tabsOnReplaced.fire(tab.id, oldId);
    return tab.id;
  }

  /** The user selects a tab in its window's tab strip. Does not change window focus. */
  activateTab(tabId: number) {
    this.activate(this.tab(tabId));
  }

  /** The user focuses a window. */
  focusWindow(windowId: number) {
    this.focus(windowId);
  }

  /** Closes a tab. If it was active, Chrome activates its right (else left) neighbour. The last tab takes the window with it. */
  closeTab(tabId: number) {
    const tab = this.tab(tabId);
    const siblings = this.tabsOf(tab.windowId);
    if (siblings.length === 1) return this.closeWindow(tab.windowId);
    const i = siblings.indexOf(tab);
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.tabsOnRemoved.fire(tabId, { windowId: tab.windowId, isWindowClosing: false });
    const neighbour = siblings[i + 1] ?? siblings[i - 1];
    if (tab.active && neighbour) this.activate(neighbour);
  }

  /** Closes a window and its tabs. If it had focus, the previously focused window gets it. */
  closeWindow(windowId: number) {
    const window = this.window(windowId);
    for (const tab of this.tabsOf(windowId)) {
      this.tabs.splice(this.tabs.indexOf(tab), 1);
      this.tabsOnRemoved.fire(tab.id, { windowId, isWindowClosing: true });
    }
    this.windows.delete(windowId);
    this.focusOrder = this.focusOrder.filter((id) => id !== windowId);
    const next = this.focusOrder[0];
    if (window.focused && next !== undefined) this.focus(next);
  }
}
