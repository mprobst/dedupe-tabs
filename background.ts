/**
 * Background script for the Dedupe Tabs Chrome extension.
 *
 * When a new tab is about to show a page that is already open in another tab,
 * switches to the existing tab and closes the new one.
 *
 * "New" covers tabs opened with a URL (links opened in a new tab or window,
 * URLs opened from other applications), but also new tabs that navigate to
 * their first page shortly after being created: typing a URL into a new tab,
 * window.open() followed by a navigation, and redirects. Tabs that already
 * showed a page are never closed, so their back/forward history isn't lost.
 */

/** Only web pages and local files are deduplicated. */
function isDedupable(url: string | undefined): url is string {
  return url !== undefined && /^(https?|file):/.test(url);
}

/** A Chrome tab ID. Only valid within one browser session. */
type TabId = number;

/**
 * IDs of tabs that haven't finished loading their first page yet, and may
 * still be closed as duplicates when they navigate.
 *
 * Kept in session storage because the service worker is terminated after ~30s
 * of inactivity, e.g. while a new tab page waits for the user to type a URL.
 */
let freshTabIds = new Set<TabId>();

/**
 * Loads `freshTabIds` from session storage. Event handlers await this before
 * touching `freshTabIds`, because the event that woke up the worker may be
 * dispatched before the load completes.
 */
const loadFresh: Promise<void> = (async () => {
  const stored = await chrome.storage.session.get({ fresh: [] });
  // Closed tabs are removed by onRemoved, which wakes the worker if needed.
  // Don't prune tabs that no longer exist here: if onReplaced woke the worker,
  // the replaced tab is already gone, but its entry must be carried over.
  freshTabIds = new Set(Array.isArray(stored['fresh']) ? stored['fresh'] : []);
})();

function setFresh(tabId: TabId, isFresh: boolean) {
  if (freshTabIds.has(tabId) === isFresh) return;
  if (isFresh) {
    freshTabIds.add(tabId);
  } else {
    freshTabIds.delete(tabId);
  }
  chrome.storage.session.set({ fresh: [...freshTabIds] }).catch((e) => console.error('saving state failed', e));
}

/**
 * Deduplication checks run one at a time. Otherwise two tabs opened with the
 * same URL at the same time each find the other as the "existing" tab, and
 * both get closed.
 */
let queue: Promise<unknown> = Promise.resolve();
function enqueueTask<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  // The queue only orders tasks: a failed task must not fail the ones queued
  // after it. The caller still sees the failure through `result`.
  queue = result.catch(() => {});
  return result;
}

/** Returns an existing tab showing (or loading) `url` that `newTab` duplicates. */
async function findExisting(newTab: chrome.tabs.Tab, url: string): Promise<chrome.tabs.Tab | undefined> {
  // Compare URLs as strings rather than with chrome.tabs.query({url}): that
  // takes match patterns, where "*" is a wildcard and URLs with a #fragment
  // never match.
  const candidates = (await chrome.tabs.query({ windowType: 'normal' })).filter(
    (t) =>
      t.id !== undefined &&
      t.id !== newTab.id &&
      t.incognito === newTab.incognito &&
      (t.url === url || t.pendingUrl === url),
  );
  // Prefer a tab in the same window, then the most recently used one.
  candidates.sort(
    (a, b) =>
      Number(b.windowId === newTab.windowId) - Number(a.windowId === newTab.windowId) ||
      (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
  );
  return candidates[0];
}

/**
 * Closes tab `tabId`, which is about to show `url`, if another tab already
 * shows that URL, and switches to that tab instead. Returns true if the tab
 * was closed (or is gone anyway).
 */
async function deduplicateTab(tabId: TabId, url: string): Promise<boolean> {
  try {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return true; // closed in the meantime, e.g. as a duplicate itself
    }
    // The tab may have moved on, e.g. it was redirected. Its new URL is
    // checked when that event is handled.
    if (tab.url !== url && tab.pendingUrl !== url) return false;
    const window = await chrome.windows.get(tab.windowId);
    // Leave popups and installed web apps alone; they are their own windows
    // for a reason.
    if (window.type !== 'normal') return false;

    const existing = await findExisting(tab, url);
    if (existing?.id === undefined) return false;

    console.log(`Tab ${tabId} duplicates tab ${existing.id} (${url}), switching to it.`);
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.remove(tabId);
    return true;
  } catch (error) {
    console.error('Error deduplicating tab', tabId, error);
    return false;
  }
}

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  await loadFresh;
  setFresh(tabId, true);
  const url = tab.pendingUrl || tab.url;
  if (isDedupable(url)) await enqueueTask(() => deduplicateTab(tabId, url));
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url === undefined && changeInfo.status !== 'complete') return;
  await loadFresh;
  if (!freshTabIds.has(tabId)) return;
  const url = changeInfo.url;
  if (isDedupable(url) && (await enqueueTask(() => deduplicateTab(tabId, url)))) return;
  // Once the first page has loaded, the tab is no longer new.
  if (changeInfo.status === 'complete' && isDedupable(tab.url)) setFresh(tabId, false);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadFresh;
  setFresh(tabId, false);
});

/** Some navigations swap a tab's ID; carry its state over. */
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await loadFresh;
  if (!freshTabIds.has(removedTabId)) return;
  setFresh(removedTabId, false);
  setFresh(addedTabId, true);
});

console.log('Dedupe Tabs extension loaded');
