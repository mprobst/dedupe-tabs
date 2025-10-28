/**
 * Background script for the Dedupe Tabs Chrome extension.
 * Listens for new tab creation and switches to existing tabs with the same URL.
 */

function isIgnoredUrl(url: string): boolean {
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url === "about:blank" ||
    url === "chrome://newtab/" ||
    url === ""
  );
}

/** Deduplicate tabs. Returns true if a duplicate was found and closed, false otherwise. */
async function deduplicateTab(tabId: number, url: string): Promise<boolean> {
  try {
    // Find all tabs with the same URL
    const allTabs = await chrome.tabs.query({ url });

    // Filter out the current tab and find older tabs
    const existingTabs = allTabs.filter((t) => t.id !== tabId);

    if (existingTabs.length > 0) {
      // Found an existing tab with the same URL
      const existingTab = existingTabs[0];
      if (!existingTab?.id) return false;

      console.log(
        `Found duplicate tab. Switching to existing tab ${existingTab.id} and closing duplicate tab ${tabId}`
      );

      // Switch to the existing tab
      await chrome.tabs.update(existingTab.id, { active: true });

      // Focus the window containing the existing tab
      if (existingTab.windowId) {
        await chrome.windows.update(existingTab.windowId, { focused: true });
      }

      // Close the duplicate tab
      await chrome.tabs.remove(tabId);
      return true;
    }
  } catch (error) {
    console.error("Error in dedupe-tabs extension:", error);
  }
  return false;
}

// Listen for new windows being created
chrome.windows.onCreated.addListener(async (window) => {
  console.log("new window created", window);

  try {
    if (!window.id) return;

    // Get all tabs in the new window
    const tabs = await chrome.tabs.query({ windowId: window.id });

    // Check each tab in the new window for duplicates
    for (const tab of tabs) {
      if (!tab.id || !tab.url || isIgnoredUrl(tab.url)) {
        continue;
      }

      if (await deduplicateTab(tab.id, tab.url)) {
        chrome.windows.remove(window.id);
        return;
      }
    }
  } catch (error) {
    console.error("Error processing new window:", error);
  }
});

// Listen for new tabs being created
chrome.tabs.onCreated.addListener(async (newTab) => {
  console.log("new tab opened", newTab);
  // Wait a bit for the URL to be set (new tabs might not have URL immediately)

  try {
    if (!newTab.id) return;
    const newTabId = newTab.id;
    const tab = await chrome.tabs.get(newTabId);
    const newUrl = tab.pendingUrl || tab.url;

    if (!newUrl || isIgnoredUrl(newUrl)) {
      return;
    }

    await deduplicateTab(newTabId, newUrl);
  } catch (error) {
    // Tab might have been closed already
    console.log("Tab no longer exists:", error);
  }
});

console.log("Dedupe Tabs extension loaded");
