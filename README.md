# Dedupe Tabs Chrome Extension

A Chrome extension that automatically prevents duplicate tabs by switching to existing tabs when you try to open a URL that's already open.

There are a number of Chrome Extensions that have similar functionality. However some don't work, and others request permissions that are too wide (browsing history suffices).

## Features

- **Automatic Deduplication**: When you create a new tab or navigate to a URL that's already open, the extension automatically switches to the existing tab and closes the duplicate.
- **Smart Detection**: Works when:
  - Opening a new tab with a URL
  - Creating a new window with a URL that already exists in another tab/window
- **Non-intrusive**: Ignores Chrome internal URLs (chrome://, chrome-extension://) and about:blank

## Installation

1. Build the extension:
   ```bash
   npm install
   npm run build
   ```

2. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in the top right)
   - Click "Load unpacked"
   - Select the `dedupe-tabs` directory

## Development

- **Build once**: `npm run build`
- **Watch mode**: `npm run watch` (automatically rebuilds on file changes)

## How It Works

The extension listens to three Chrome events:

1. `chrome.windows.onCreated`: When a new window is created, it checks all tabs in that window for duplicates
2. `chrome.tabs.onCreated`: When a new tab is created, it checks if any existing tab has the same URL
3. `chrome.tabs.onUpdated`: When a tab's URL changes, it checks if any other tab already has that URL

When a duplicate is found, the extension:
1. Switches to the existing tab
2. Focuses the window containing that tab
3. Closes the duplicate tab

This ensures that you never have multiple tabs open with the same URL, even across different windows!

## Note on Icons

The manifest references icon files (icon16.png, icon48.png, icon128.png) that you can create or the extension will use Chrome's default icon if they're missing.

## License

MIT
