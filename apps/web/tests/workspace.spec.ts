import { test, expect, type Page } from '@playwright/test';

async function workspace(page: Page, role = 'USER') {
  let balance = 20;
  let checked = false;
  const requests: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(path);
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          user: {
            id: 'workspace-test',
            email: 'workspace@gmail.com',
            display_name: 'Workspace',
            role,
            mfa_enabled: role !== 'USER',
          },
          csrf_token: 'csrf',
          mfa_required: false,
        },
      });
    if (path === '/api/v1/wallet')
      return route.fulfill({
        json: {
          balance,
          held: 0,
          available: balance,
          checked_in_today: checked,
          streak: checked ? 1 : 0,
          next_reward: checked ? 11 : 10,
          local_date: '2026-10-22',
          timezone: 'Asia/Shanghai',
        },
      });
    if (path === '/api/v1/wallet/checkin') {
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe('csrf');
      balance = 77; // A fresh server snapshot wins over arithmetic in the client.
      checked = true;
      return route.fulfill({
        json: {
          credits: 10,
          streak: 1,
          already_checked_in: false,
          local_date: '2026-10-22',
        },
      });
    }
    if (path === '/api/v1/wallet/ledger')
      return route.fulfill({ json: { items: [], next_cursor: null } });
    if (path === '/api/v1/me/sessions')
      return route.fulfill({ json: { sessions: [] } });
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });
  return requests;
}

test('production workspace preserves prototype shell and synchronizes real wallet snapshots', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = await workspace(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '欢迎回来，Workspace' }),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(
    page.getByLabel('侧栏积分').getByText('20', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '最近的创作项目' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '新建画布', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('即将开放', { exact: true })).toHaveCount(3);
  await expect(page.getByText('MOCK DEMO')).toHaveCount(0);
  await expect(page.getByText('切换演示账号')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: '积分管理', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '领取今日积分' }).dblclick();
  await expect(page.getByRole('button', { name: '今日已签到' })).toBeDisabled();
  await expect(
    page.getByLabel('侧栏积分').getByText('77', { exact: true }),
  ).toBeVisible();
  expect(requests.filter((path) => path.endsWith('/checkin'))).toHaveLength(1);
  await page.getByRole('link', { name: '积分与订阅', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的积分' })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: '钱包余额' })
      .getByText('77', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: '积分与订阅', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: '账号设置', exact: true }).click();
  await expect(page.getByLabel('显示名')).toHaveValue('Workspace');
  expect(
    requests.some((path) => /projects|generation|assets|\/admin/.test(path)),
  ).toBe(false);
  expect(errors).toEqual([]);
});

test('administrator sees operational navigation and reaches the existing credits form', async ({
  page,
}) => {
  await workspace(page, 'SUPER_ADMIN');
  await page.goto('/');
  await expect(page.getByText('运营管理', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '积分管理', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '积分管理', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('用户 UUID')).toBeVisible();
  await expect(
    page.getByRole('link', { name: '积分管理', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('small screens scroll and navigation closes after selecting a real page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await workspace(page);
  await page.goto('/');
  const toggle = page.getByRole('button', { name: '展开折叠边栏' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('navigation', { name: '主导航' }),
  ).not.toBeVisible();
  await page
    .getByRole('button', { name: '领取今日积分' })
    .scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '领取今日积分' }).click();
  await expect(page.getByRole('button', { name: '今日已签到' })).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await toggle.click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.getByRole('link', { name: '账号设置', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();
  await page
    .getByRole('button', { name: '退出所有设备' })
    .scrollIntoViewIfNeeded();
});
