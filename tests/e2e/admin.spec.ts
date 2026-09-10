import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { SESSION_COOKIE } from '../../src/shared/constants';

const credentials = { username: 'browser-admin', password: 'browser-test-password-123' };

async function fixtureUnavailableChroma(page: Page, testInfo: TestInfo): Promise<boolean> {
  let available = false;
  try {
    available = (await page.request.get('http://127.0.0.1:3138/api/v2/heartbeat', { timeout: 1_500 })).ok();
  } catch {
    // This optional dependency is deliberately separate from the user's .env.
  }
  if (available) return false;
  testInfo.annotations.push({
    type: 'coverage',
    description: 'Chroma unavailable: stats/facts are browser fixtures. Authentication and settings use the actual server and an isolated SQLite database.',
  });
  await page.route('**/api/stats', (route) => route.fulfill({ json: {
    success: true, data: { totalFacts: 0, totalMessagesReferenced: 0, totalReplies: 0, latestReplies: [] },
  } }));
  await page.route('**/api/facts**', (route) => {
    const url = new URL(route.request().url());
    const data = url.pathname === '/api/facts'
      ? { facts: [], total: 0, page: Number(url.searchParams.get('page') ?? 1), pageSize: Number(url.searchParams.get('pageSize') ?? 20) }
      : [];
    return route.fulfill({ json: { success: true, data } });
  });
  return true;
}

async function signIn(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}

test('real admin setup, session lifecycle, persisted attachment settings and mobile navigation', async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const chromaIsFixture = await fixtureUnavailableChroma(page, testInfo);

  await test.step('Create the first admin in a real browser', async () => {
    const health = await page.request.get('/api/health');
    expect((await health.json()).mode).toBe('admin-only');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Create the admin account' })).toBeVisible();
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByLabel('Confirm password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Create admin account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    const cookie = (await page.context().cookies()).find((entry) => entry.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('desktop-dashboard.png'), fullPage: true });
  });

  await test.step('Save and reload the real message.txt size setting', async () => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const size = page.getByRole('spinbutton', { name: 'Maximum message.txt size (KiB)' });
    await expect(size).toHaveValue('16');
    for (const value of ['32', '0']) {
      await size.fill(value);
      const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'PATCH');
      await page.getByRole('button', { name: 'Save changes' }).click();
      expect((await saved).status()).toBe(200);
      await page.reload();
      await expect(size).toHaveValue(value);
      expect((await (await page.request.get('/api/settings')).json()).data.textAttachmentMaxKb).toBe(Number(value));
    }
  });

  await test.step('Logout invalidates the session, and wrong-password login remains a form error', async () => {
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect((await page.request.get('/api/settings')).status()).toBe(401);
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Incorrect username or password', { exact: true })).toBeVisible();
    await signIn(page);
  });

  await test.step('An actual protected API 401 returns the open app to login', async () => {
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    await page.context().clearCookies();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Your session has expired. Please sign in again.', { exact: true })).toBeVisible();
    await signIn(page);
    await expect(page.getByRole('spinbutton', { name: 'Maximum message.txt size (KiB)' })).toHaveValue('0');
  });

  await test.step('Mobile settings and navigation fit the viewport', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    const widths = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      return { document: document.documentElement.scrollWidth, viewport: window.innerWidth, main: main.scrollWidth, mainViewport: main.clientWidth };
    });
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);
    expect(widths.main).toBeLessThanOrEqual(widths.mainViewport);
    await page.screenshot({ path: testInfo.outputPath('mobile-settings.png'), fullPage: true });
    await page.getByRole('link', { name: 'Facts', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Facts', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Browse', exact: true }).click();
    if (chromaIsFixture) await expect(page.getByText('No facts have been learned yet.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });

  expect(browserErrors).toEqual([]);
});

test('initial authentication network failure offers a working retry', async ({ page }) => {
  let failOnce = true;
  await page.route('**/api/auth/status', async (route) => {
    if (failOnce) {
      failOnce = false;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText("Couldn't connect to the admin panel", { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: /^(Sign in|Create admin account)$/ })).toBeVisible();
});
