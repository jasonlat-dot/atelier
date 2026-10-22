import { test, expect } from '@playwright/test';
const user = {
  id: '1f8848d3-1bd4-4eb3-8c91-a653c27a11a0',
  email: 'wallet@gmail.com',
  display_name: 'Wallet',
  role: 'USER',
  mfa_enabled: false,
};
test('wallet checkin, retry-safe redemption and server ledger pagination', async ({
  page,
}) => {
  let balance = 20;
  let checked = false;
  let fail = true;
  const keys: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (req.method() !== 'GET')
      expect(req.headers()['x-csrf-token']).toBe('csrf');
    if (path === '/api/v1/me')
      return route.fulfill({
        json: { user, csrf_token: 'csrf', mfa_required: false },
      });
    if (path === '/api/v1/wallet')
      return route.fulfill({
        json: {
          balance,
          held: 0,
          available: balance,
          local_date: '2026-10-22',
          timezone: 'Asia/Shanghai',
          checked_in_today: checked,
          streak: checked ? 1 : 0,
          next_reward: checked ? 11 : 10,
        },
      });
    if (path === '/api/v1/wallet/checkin') {
      balance += 10;
      checked = true;
      return route.fulfill({
        json: {
          local_date: '2026-10-22',
          streak: 1,
          credits: 10,
          already_checked_in: false,
        },
      });
    }
    if (path === '/api/v1/wallet/redeem') {
      expect(req.postDataJSON()).toEqual({ code: 'test-code' });
      keys.push(req.headers()['idempotency-key']);
      if (fail) {
        fail = false;
        return route.abort('failed');
      }
      balance += 25;
      return route.fulfill({ json: { ledger_id: 10, credits: 25 } });
    }
    if (path === '/api/v1/wallet/ledger')
      return route.fulfill({
        json: {
          items: [
            {
              id: url.searchParams.has('before') ? 1 : 2,
              type: url.searchParams.has('before') ? 'SIGNUP_BONUS' : 'CHECKIN',
              balance_delta: 10,
              held_delta: 0,
              reason: null,
              created_at: '2026-10-22T00:00:00Z',
            },
          ],
          next_cursor: url.searchParams.has('before') ? null : 2,
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });
  await page.goto('/wallet');
  await expect(page.getByRole('heading', { name: '我的积分' })).toBeVisible();
  await page.getByRole('button', { name: '领取今日积分' }).click();
  await expect(page.getByRole('button', { name: '今日已签到' })).toBeDisabled();
  await page.getByLabel('兑换码', { exact: true }).fill('test-code');
  await page.getByRole('button', { name: '兑换', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '兑换', exact: true }).click();
  await expect(page.getByText('兑换成功，获得 25 积分')).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByRole('cell', { name: '注册赠送' })).toBeVisible();
  await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);
  await page.getByRole('link', { name: '工作台', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '你好，Wallet' }),
  ).toBeVisible();
  await page.goto('/admin/credits');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
});

test('administrator adjustment confirms reason and preserves retry key', async ({
  page,
}) => {
  let fail = true;
  const keys: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/v1/me')
      return route.fulfill({
        json: {
          user: { ...user, role: 'ADMIN', mfa_enabled: true },
          csrf_token: 'csrf',
          mfa_required: false,
        },
      });
    const req = route.request();
    expect(req.headers()['x-csrf-token']).toBe('csrf');
    expect(req.postDataJSON()).toEqual({
      amount: -5,
      reason: 'Support correction',
    });
    keys.push(req.headers()['idempotency-key']);
    if (fail) {
      fail = false;
      return route.abort('failed');
    }
    return route.fulfill({ json: { ledger_id: 11, credits: -5 } });
  });
  await page.goto('/admin/credits');
  await page.getByLabel('用户 UUID').fill(user.id);
  await page.getByLabel('调整积分', { exact: true }).fill('-5');
  await page.getByLabel('调整原因').fill('Support correction');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '确认调整' }).click();
  expect(keys).toHaveLength(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '确认调整' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '确认调整' }).click();
  await expect(page.getByText('积分调整已入账，审计记录已保存')).toBeVisible();
  expect(keys[0]).toBe(keys[1]);
});
