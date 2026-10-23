import { test, expect, type Page } from '@playwright/test';
const id = '1f8848d3-1bd4-4eb3-8c91-a653c27a11a0';
const plan = {
  id,
  revision: 1,
  details: {
    name: '创作订阅',
    kind: 'MONTHLY',
    description: '给持续创作准备的额度',
    price_cents: 1900,
    currency: 'CNY',
    credits: 200,
    period_days: 30,
    rollover: true,
    concurrency_limit: 3,
    max_resolution: '4K',
    retention_days: 180,
    active: true,
  },
};
const order = {
  id: '2f8848d3-1bd4-4eb3-8c91-a653c27a11a0',
  user_id: id,
  plan_id: id,
  plan_snapshot: plan.details,
  amount_cents: 1900,
  currency: 'CNY',
  provider: 'MANUAL',
  provider_trade_no: null,
  status: 'PENDING',
  created_at: '2026-10-23T01:00:00Z',
  paid_at: null,
  refund_cents: 0,
  recovered_credits: 0,
};
async function mock(page: Page, admin = false) {
  const keys: string[] = [];
  let fail = true;
  let status = 'PENDING';
  let held = 4;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET')
      expect(req.headers()['x-csrf-token']).toBe('csrf');
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          user: {
            id,
            email: 'billing@gmail.com',
            display_name: 'Billing',
            role: admin ? 'ADMIN' : 'USER',
            mfa_enabled: admin,
          },
          csrf_token: 'csrf',
          mfa_required: false,
        },
      });
    if (path === '/api/v1/wallet')
      return route.fulfill({
        json: {
          balance: 20,
          held: 0,
          available: 20,
          checked_in_today: false,
          streak: 0,
          next_reward: 10,
          local_date: '2026-10-23',
          timezone: 'Asia/Shanghai',
        },
      });
    if (path === '/api/v1/wallet/ledger')
      return route.fulfill({ json: { items: [], next_cursor: null } });
    if (path === '/api/v1/subscription')
      return route.fulfill({
        json: {
          tier: 'FREE',
          plan_name: null,
          current_period_end: null,
          max_active_jobs: 1,
          max_resolution: '2K',
          retention_days: 30,
          scheduled_periods: 0,
        },
      });
    if (path.endsWith('/plans') && req.method() === 'GET')
      return route.fulfill({ json: [plan] });
    if (path.includes('/plans') && req.method() !== 'GET')
      return route.fulfill({
        json: {
          ...plan,
          details: req.postDataJSON().details || req.postDataJSON(),
        },
      });
    if (path.endsWith('/orders') && req.method() === 'GET')
      return route.fulfill({
        json: { items: [{ ...order, status }], next_cursor: null },
      });
    if (
      (path === '/api/v1/orders' && req.method() === 'POST') ||
      path.endsWith('/mark-paid')
    ) {
      keys.push(req.headers()['idempotency-key']);
      expect(keys.at(-1)).toMatch(/^[0-9a-f-]{36}$/);
      if (fail) {
        fail = false;
        return route.abort('failed');
      }
      if (path.endsWith('/mark-paid')) {
        status = 'FULFILLED';
        return route.fulfill({ json: { ...order, status } });
      }
      return route.fulfill({
        json: {
          order,
          instructions: '请联系管理员并提供订单号，线下付款后核对到账。',
        },
      });
    }
    if (path.endsWith('/cancel')) {
      status = 'CANCELLED';
      return route.fulfill({ json: { ...order, status } });
    }
    if (path.endsWith('/refund-quote'))
      return route.fulfill({
        json: {
          refundable_credits: 150,
          refund_cents: 1425,
          held_credits: held,
        },
      });
    if (path.endsWith('/refund')) {
      expect(req.postDataJSON().expected_credits).toBe(150);
      expect(req.postDataJSON().confirm_external_refund).toBe(true);
      status = 'REFUNDED';
      return route.fulfill({
        json: { ...order, status, refund_cents: 1425, recovered_credits: 150 },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });
  page.on('dialog', () => {
    throw new Error('Billing must use custom review dialogs');
  });
  return {
    keys,
    release: () => {
      held = 0;
    },
  };
}
test('user reviews plan, retries the same checkout and cancels only after confirmation', async ({
  page,
}) => {
  const { keys } = await mock(page);
  await page.goto('/wallet');
  await page.getByRole('button', { name: '套餐与订阅', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '创作订阅', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '选择套餐' }).click();
  await expect(page.getByRole('dialog')).toContainText('不会扣款');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '选择套餐' }).click();
  await page.getByRole('button', { name: '确认创建订单', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '确认创建订单', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('订单已创建');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await page.getByRole('button', { name: '我的订单', exact: true }).click();
  await expect(page.getByText('待付款', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消订单', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('如果已经付款');
  await page.getByRole('button', { name: '确认取消订单', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: '套餐与订阅', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '创作订阅', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('admin edits a plan, confirms a receipt safely and blocks refunds while credits are held', async ({
  page,
}) => {
  const { keys, release } = await mock(page, true);
  await page.goto('/admin/plans');
  await page.getByRole('button', { name: '编辑套餐', exact: true }).click();
  await page.getByLabel('套餐名称', { exact: true }).fill('更新后的套餐');
  await page.getByRole('button', { name: '保存套餐', exact: true }).click();
  await expect(page.getByText('套餐已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '订单管理', exact: true }).click();
  await page.getByRole('button', { name: '确认到账', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '确认到账并发放权益' }),
  ).toBeDisabled();
  await page.getByLabel('收款凭证号', { exact: true }).fill('receipt-001');
  await page.getByLabel('处理说明', { exact: true }).fill('已核对实际收款');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认到账并发放权益' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '确认到账并发放权益' }).click();
  await expect(page.getByText('已发放', { exact: true })).toBeVisible();
  expect(keys[0]).toBe(keys[1]);
  await page.getByRole('button', { name: '办理退款', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('任务预占 4');
  await expect(
    page.getByRole('button', { name: '登记退款并回收权益' }),
  ).toBeDisabled();
  release();
  await page.getByRole('button', { name: '重新核对可退金额' }).click();
  await expect(page.getByRole('dialog')).toContainText('任务预占 0');
  await expect(page.getByRole('dialog')).toContainText('14.25');
  await page
    .getByLabel('处理说明', { exact: true })
    .fill('已退回剩余额度对应金额');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '登记退款并回收权益' }).click();
  await expect(page.getByText('已退款', { exact: true })).toBeVisible();
});
