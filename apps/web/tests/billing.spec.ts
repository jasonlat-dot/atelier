import { dismissFeedback } from './feedbackTestHelpers';
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
  await expect(page.getByRole('alertdialog').getByRole('alert')).toBeVisible();
  await dismissFeedback(page);
  await page.getByRole('button', { name: '确认创建订单', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('订单已创建');
  await dismissFeedback(page);
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
  await expect(
    page.getByRole('button', { name: '积分调整', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '编辑套餐', exact: true }).click();
  await page.getByLabel('套餐名称', { exact: true }).fill('更新后的套餐');
  await page.getByRole('button', { name: '保存套餐', exact: true }).click();
  await expect(page.getByText('套餐已保存', { exact: true })).toBeVisible();
  await dismissFeedback(page);
  await page.getByRole('tab', { name: '订单管理', exact: true }).click();
  await page.getByRole('button', { name: '确认到账', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '确认到账并发放权益' }),
  ).toBeDisabled();
  await page.getByLabel('收款凭证号', { exact: true }).fill('receipt-001');
  await page.getByLabel('处理说明', { exact: true }).fill('已核对实际收款');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认到账并发放权益' }).click();
  await expect(page.getByRole('alertdialog').getByRole('alert')).toBeVisible();
  await dismissFeedback(page);
  await page.getByRole('button', { name: '确认到账并发放权益' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('到账已确认');
  await dismissFeedback(page);
  await expect(page.getByText('已发放', { exact: true })).toBeVisible();
  expect(keys[0]).toBe(keys[1]);
  await page.getByRole('button', { name: '办理退款', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText(
    '请等待该用户的生成任务结束',
  );
  await dismissFeedback(page);
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
  await expect(page.getByRole('alertdialog')).toContainText('退款已登记');
  await dismissFeedback(page);
  await expect(
    page.getByRole('table').getByText('已退款', { exact: true }),
  ).toBeVisible();
});

test('plan availability requires confirmation and preserves the current revision and rights', async ({
  page,
}) => {
  await mock(page, true);
  let current = structuredClone(plan);
  const updates: unknown[] = [];
  await page.route('**/api/v1/admin/plans**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: [current] });
    expect(req.method()).toBe('PATCH');
    expect(req.headers()['x-csrf-token']).toBe('csrf');
    const body = req.postDataJSON();
    updates.push(body);
    expect(body).toEqual({
      revision: current.revision,
      details: { ...current.details, active: !current.details.active },
    });
    current = {
      ...current,
      revision: current.revision + 1,
      details: body.details,
    };
    return route.fulfill({ json: current });
  });
  await page.goto('/admin/plans');
  const down = page.getByRole('button', { name: '下架 创作订阅' });
  await down.click();
  await expect(page.getByRole('dialog', { name: '下架套餐' })).toContainText(
    '历史订单仍按下单时的价格和权益处理',
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(updates).toHaveLength(0);
  await down.click();
  await page.getByRole('button', { name: '确认下架', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('套餐已下架');
  await dismissFeedback(page);
  await page.getByRole('button', { name: '上架 创作订阅' }).click();
  await page.getByRole('button', { name: '确认上架', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('套餐已上架');
  await dismissFeedback(page);
  expect(updates).toHaveLength(2);
  await expect(
    page.getByRole('button', { name: '下架 创作订阅' }),
  ).toBeVisible();
});

test('billing orders filter loaded records, keep filters while paging and copy snapshot ids without a mask', async ({
  page,
  context,
}, testInfo) => {
  await mock(page, true);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const paid = {
    ...order,
    id: '3f8848d3-1bd4-4eb3-8c91-a653c27a11a0',
    status: 'FULFILLED',
    paid_at: '2026-10-23T02:00:00Z',
  };
  await page.route('**/api/v1/admin/plans', (route) =>
    route.fulfill({
      json: [
        {
          ...plan,
          details: {
            ...plan.details,
            name: '现售新版订阅',
            price_cents: 2900,
            credits: 300,
          },
        },
      ],
    }),
  );
  const older = {
    ...order,
    id: '4f8848d3-1bd4-4eb3-8c91-a653c27a11a0',
    status: 'FULFILLED',
  };
  let reads = 0;
  await page.route('**/api/v1/admin/orders**', async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe('GET');
    reads++;
    const more = url.searchParams.has('before');
    return route.fulfill({
      json: {
        items: more ? [paid, older] : [order, paid],
        next_cursor: more ? null : paid.id,
      },
    });
  });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto('/admin/plans');
  await expect(
    page.getByRole('button', { name: '编辑套餐', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('billing-plans-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('tab', { name: '套餐管理', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: '订单管理', exact: true }),
  ).toBeFocused();
  const rows = page.locator('.admin-billing-table tbody tr');
  await expect(rows).toHaveCount(2);
  const initialReads = reads;
  await page
    .getByRole('group', { name: '订单状态' })
    .getByRole('button', { name: '已到账', exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: '加载更多订单' }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByText('已加载 3 条订单 · 符合条件 2 条')).toBeVisible();
  expect(reads).toBe(initialReads + 1);
  await page.getByRole('textbox', { name: '搜索订单' }).fill(paid.id);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(rows).toHaveCount(1);
  const copy = page.getByRole('button', {
    name: `复制订单号 ${paid.id}`,
    exact: true,
  });
  const node = await copy.elementHandle();
  await copy.click();
  await expect(page.getByRole('status')).toContainText('订单号已复制');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await copy.evaluate((el, previous) => el === previous, node)).toBe(
    true,
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    paid.id,
  );
  expect(reads).toBe(initialReads + 1);
  await page.screenshot({
    path: testInfo.outputPath('billing-orders-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page
    .getByRole('button', { name: `详情 ${paid.id}`, exact: true })
    .click();
  const details = page.getByRole('dialog', { name: '订单详情', exact: true });
  await expect(details).toContainText(paid.id);
  await expect(details).toContainText('创作订阅');
  await expect(details).toContainText('200 积分');
  await expect(details).toContainText('19.00');
  await expect(details).toContainText('到账已确认');
  await expect(details.getByRole('button', { name: '关闭订单' })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: testInfo.outputPath('billing-details-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('billing-details-mobile.png'),
  });
  expect(await details.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByRole('button', { name: '收起导航', exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath('billing-orders-mobile.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('tab', { name: '套餐管理', exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath('billing-plans-mobile.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('tab', { name: '订单管理', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索订单' })).toHaveValue(
    paid.id,
  );
  await expect(rows).toHaveCount(1);
  await page.getByRole('textbox', { name: '搜索订单' }).fill('没有这个套餐');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '暂无符合条件的订单' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(rows).toHaveCount(3);
});
