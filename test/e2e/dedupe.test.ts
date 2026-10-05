/**
 * End-to-end tests for tab deduplication, in a real browser. See harness.ts
 * for requirements. Run with `xvfb-run -a npm run test:e2e`.
 */
import { expect } from '@playwright/test';
import { expectToSettle, extensionTest, skipReason } from './harness.ts';
import { startServer, type TestServer } from './server.ts';

const test = extensionTest('background.js').extend<
  {
    /**
     * Asserts that the sorted URLs of the tabs showing test server pages settle on
     * `expected`, a sorted list or an asymmetric matcher.
     */
    expectPages: (
      expected: string[] | ReturnType<typeof expect.arrayContaining>,
      message?: string,
    ) => Promise<void>;
    /** Opens `path` in a new tab, waits for it to load, and returns its ID. */
    openLoaded: (path: string, opts?: { windowId?: number; active?: boolean }) => Promise<number>;
  },
  { server: TestServer }
>({
  // One server for all tests in a worker.
  server: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startServer();
      try {
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: 'worker' },
  ],
  expectPages: async ({ b, server }, use) => {
    await use((expected, message = 'URLs of the test pages') =>
      expectToSettle(
        async () =>
          (await b.tabs())
            .map((t) => t.url)
            .filter((u) => u.startsWith(server.base))
            .sort(),
        expected,
        {
          message,
        },
      ),
    );
  },
  openLoaded: async ({ b, server }, use) => {
    await use(async (path, opts) => {
      const id = await b.open(server.url(path), opts);
      await b.loaded(id);
      return id;
    });
  },
});

test.describe('dedupe-tabs', () => {
  const reason = skipReason({ keyPresses: false });
  test.skip(reason !== undefined, reason);

  test('opening an already open URL switches to the existing tab', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    const existing = await openLoaded('/a');
    await openLoaded('/b');
    await b.open(url('/a'));
    await expectPages([url('/a'), url('/b')]);
    await b.expectCurrent({ tabId: existing });
  });

  test('different URLs are kept', async ({ b, server: { url }, openLoaded, expectPages }) => {
    await openLoaded('/a');
    await b.open(url('/a?x=1'));
    await b.open(url('/b'));
    await expectPages([url('/a'), url('/a?x=1'), url('/b')]);
  });

  test('deduplicates while the service worker is suspended', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    await openLoaded('/a');
    await b.stopTarget();
    await b.open(url('/a'));
    await expectPages([url('/a')]);
  });

  test('deduplicates URLs with a fragment', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    await openLoaded('/a#x');
    await b.open(url('/a#x'));
    await expectPages([url('/a#x')]);
  });

  test('keeps URLs that differ in the fragment', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    await openLoaded('/a#x');
    await b.open(url('/a#y'));
    await expectPages([url('/a#x'), url('/a#y')]);
  });

  test('"*" in a URL is not a wildcard', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    await openLoaded('/search/abc');
    await b.open(url('/search/a*'));
    await expectPages([url('/search/a*'), url('/search/abc')]);
  });

  test('a new window with a duplicate keeps its other tabs', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    await openLoaded('/a');
    await b.drv((urls: string[]) => chrome.windows.create({ url: urls }), [url('/a'), url('/b')]);
    await expectPages([url('/a'), url('/b')]);
  });

  test('a new window with just a duplicate is closed', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    const existing = await openLoaded('/a');
    await b.drv((u: string) => chrome.windows.create({ url: u }), url('/a'));
    await expectPages([url('/a')]);
    await b.expectCurrent({ tabId: existing });
  });

  test('reopening a closed window with a duplicate keeps its other tabs', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    const w = await b.drv(
      (urls: string[]) => chrome.windows.create({ url: urls }),
      [url('/a'), url('/b')],
    );
    await expectPages([url('/a'), url('/b')], 'the new window has loaded its tabs');
    await b.waitForHandlers();
    await b.drv((id: number) => chrome.windows.remove(id), w!.id!);
    await openLoaded('/a');
    // Like Ctrl+Shift+T: the window comes back with all its tabs at once.
    await b.drv(() => chrome.sessions.restore());
    // /b must survive (whether /a is kept is not the point of this test).
    await expectPages(expect.arrayContaining([url('/b')]), '/b was restored and kept');
  });

  test('two tabs opened at once with the same URL: one survives', async ({
    b,
    server: { url },
    expectPages,
  }) => {
    await b.drv(
      (u: string) => Promise.all([chrome.tabs.create({ url: u }), chrome.tabs.create({ url: u })]),
      url('/a'),
    );
    await expectPages([url('/a')]);
  });

  test('a link opened in a new tab (target=_blank)', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    await openLoaded('/a');
    await openLoaded(`/opener?href=${encodeURIComponent(url('/a'))}`);
    const opener = b.ctx.pages().find((p) => p.url().includes('/opener'))!;
    await opener.click('#link');
    await expectPages([url('/a'), url(`/opener?href=${encodeURIComponent(url('/a'))}`)]);
  });

  test('window.open() of a blank tab that then navigates', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    await openLoaded('/a');
    await openLoaded(`/opener?href=${encodeURIComponent(url('/a'))}`);
    const opener = b.ctx.pages().find((p) => p.url().includes('/opener'))!;
    await opener.click('#popup');
    await expectPages([url('/a'), url(`/opener?href=${encodeURIComponent(url('/a'))}`)]);
  });

  test('typing an open URL into a new tab', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    const existing = await openLoaded('/a');
    const ntp = await b.open('chrome://newtab/');
    await b.waitForHandlers();
    await b.drv(({ id, u }: { id: number; u: string }) => chrome.tabs.update(id, { url: u }), {
      id: ntp,
      u: url('/a'),
    });
    await expectPages([url('/a')]);
    await b.expectCurrent({ tabId: existing });
  });

  test('typing an open URL into a new tab after the worker was suspended', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    await openLoaded('/a');
    const ntp = await b.open('chrome://newtab/');
    await b.waitForHandlers();
    await b.stopTarget();
    await b.drv(({ id, u }: { id: number; u: string }) => chrome.tabs.update(id, { url: u }), {
      id: ntp,
      u: url('/a'),
    });
    await expectPages([url('/a')]);
  });

  test('a new tab that redirects to an open URL', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    await openLoaded('/a');
    await b.open(url(`/redirect?to=${encodeURIComponent(url('/a'))}`));
    await expectPages([url('/a')]);
  });

  test('navigating a tab with history to an open URL keeps it', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    // Closing this tab would lose its back/forward history (and maybe state).
    await openLoaded('/a');
    const other = await openLoaded('/b');
    await b.drv(({ id, u }: { id: number; u: string }) => chrome.tabs.update(id, { url: u }), {
      id: other,
      u: url('/a'),
    });
    await b.loaded(other);
    await expectPages([url('/a'), url('/a')]);
  });

  test('leaves popup and app windows alone', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    // e.g. an installed web app, or a site's popup window.
    await openLoaded('/a');
    await b.drv((u: string) => chrome.windows.create({ url: u, type: 'popup' }), url('/a'));
    await expectPages([url('/a'), url('/a')]);
  });

  test('switches to an existing tab that was discarded to save memory', async ({
    b,
    server: { url },
    openLoaded,
    expectPages,
  }) => {
    const existing = await openLoaded('/a');
    await openLoaded('/b');
    await b.drv((id: number) => chrome.tabs.discard(id), existing);
    await expect
      .poll(() => b.drv(async () => (await chrome.tabs.query({ discarded: true })).length), {
        message: 'a tab is discarded',
      })
      .toBeGreaterThan(0);
    await b.open(url('/a'));
    await expectPages([url('/a'), url('/b')]);
    // Discarding replaces the tab ID with a new one.
    const a = (await b.tabs()).find((t) => t.url === url('/a'));
    if (!a) throw new Error('the discarded tab is gone');
    await b.expectCurrent({ tabId: a.id });
  });
});
