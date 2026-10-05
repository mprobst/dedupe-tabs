# Dedupe Tabs Chrome Extension

A Chrome extension that automatically prevents duplicate tabs by switching to existing tabs when you try to open a URL that's already open.

There are a number of Chrome Extensions that have similar functionality. However some don't work, and others request permissions that are too wide (browsing history suffices).

## Features

- **Automatic Deduplication**: When a new tab is about to show a page that's already open, the extension switches to the existing tab and closes the new one. This covers:
  - links opened in a new tab or window, and URLs opened from other applications
  - typing a URL into a new tab
  - pages that open a blank window and then navigate it, and redirects
- **Safe**: Tabs that already showed a page are never closed, so navigating within a tab never loses its history. Popup windows and installed web apps are left alone, and so are the other tabs of a new or restored window. Incognito tabs are only compared with incognito tabs.
- **Non-intrusive**: Only web pages (http, https) and local files are deduplicated, compared by their exact URL (including any `#fragment`).

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
- **Bundle for the Chrome Web Store**: `npm run bundle`
- **Watch mode**: `npm run watch` (automatically rebuilds on file changes)

## How It Works

The extension listens to `chrome.tabs.onCreated` and `chrome.tabs.onUpdated`.
A tab counts as new from its creation until its first web page has finished
loading; while it is new, every URL it is about to show is checked against all
other tabs in normal windows. When a duplicate is found, the extension:

1. Switches to the existing tab (preferring one in the same window)
2. Focuses the window containing that tab
3. Closes the duplicate tab

The list of new tabs lives in `chrome.storage.session` (hence the "storage"
permission), so it survives the service worker being suspended while, say, a
new tab page waits for input.

## Tests

The tests are written in TypeScript. `npm run typecheck` type-checks the
extension and the tests. Unit tests run directly under Node (type stripping),
so there is no build step for tests.

`npm test` runs unit tests (`node --test`) against an in-memory fake of the
Chrome APIs.

`npm run test:e2e` runs end-to-end tests with [Playwright
Test](https://playwright.dev) in a real Chromium (Playwright's build;
`npx playwright install chromium` downloads it, or set `CHROME_PATH`), with a
local web server and a small driver extension (`test/driver-ext`). They need an
X display on which window focus works (headless Chromium reports every window
as focused) and `xdotool`: `sudo apt install xvfb xdotool`, then
`xvfb-run -a npm run test:e2e`. Set `EXT_DIR` to run them against a different
build. On failure, the report (`npx playwright show-report`) has the
extension's console output and the final tab state attached.

## Note on Icons

The manifest references icon files (icon16.png, icon48.png, icon128.png) that you can create or the extension will use Chrome's default icon if they're missing.

## License

MIT
