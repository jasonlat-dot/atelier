import { test, expect } from '@playwright/test';
import { dismissFeedback } from './feedbackTestHelpers';
import { chooseSelect } from './selectTestHelpers';
const user = {
  id: '1f8848d3-1bd4-4eb3-8c91-a653c27a11a0',
  email: 'wallet@gmail.com',
  display_name: 'Wallet',
  role: 'USER',
  mfa_enabled: false,
};

for (const ambiguous of [false, true]) {
  test(`admin redeem-code management keeps plaintext transient and never retries issuance (${ambiguous ? 'uncertain' : 'success'})`, async ({
    page,
  }) => {
    const writes: unknown[] = [];
    const copies: string[] = [];
    const codes = ['fixture-code-first', 'fixture-code-second'];
    let created = false;
    await page.addInitScript(() => {
      let copied = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            copied = value;
          },
          readText: async () => copied,
        },
      });
    });
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.pathname === '/api/v1/me')
        return route.fulfill({
          json: {
            user: { ...user, role: 'ADMIN', mfa_enabled: true },
            csrf_token: 'csrf',
            mfa_required: false,
          },
        });
      if (url.pathname === '/api/v1/wallet')
        return route.fulfill({ json: { balance: 20, held: 0, available: 20 } });
      if (url.pathname === '/api/v1/admin/users')
        return route.fulfill({ json: { items: [], next_cursor: null } });
      if (url.pathname === '/api/v1/admin/credits/adjustments')
        return route.fulfill({ json: [] });
      if (url.pathname.endsWith('/copy')) {
        expect(req.headers()['x-csrf-token']).toBe('csrf');
        copies.push(url.pathname);
        return route.fulfill({
          json: { id: '1f8848d3-1bd4-4eb3-8c91-a653c27a11a0', code: codes[0] },
        });
      }
      if (url.pathname === '/api/v1/admin/redeem-codes') {
        if (req.method() === 'POST') {
          expect(req.headers()['x-csrf-token']).toBe('csrf');
          writes.push(req.postDataJSON());
          if (ambiguous) return route.abort('failed');
          created = true;
          return route.fulfill({
            json: {
              codes: codes.map((code, i) => ({
                id: `${i + 1}f8848d3-1bd4-4eb3-8c91-a653c27a11a0`,
                code,
              })),
            },
          });
        }
        return route.fulfill({
          json: created
            ? codes.map((_, i) => ({
                id: `${i + 1}f8848d3-1bd4-4eb3-8c91-a653c27a11a0`,
                credits: 25,
                used_count: i,
                max_uses: 3,
                expires_at: null,
                created_at: '2026-10-24T00:00:00Z',
                copyable: true,
                revision: 1,
                disabled_at: null,
                deleted_at: null,
              }))
            : [],
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND' } },
      });
    });
    await page.goto('/admin/credits');
    await page.getByRole('button', { name: '兑换码管理', exact: true }).click();
    await expect(page.getByText('还没有兑换码')).toBeVisible();
    await page.getByRole('button', { name: '生成兑换码', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('兑换码数量').fill('2');
    await dialog.getByLabel('每次兑换积分').fill('0');
    await dialog.getByRole('button', { name: '确认生成', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toContainText('正整数积分');
    await dismissFeedback(page);
    expect(writes).toHaveLength(0);
    await dialog.getByLabel('每次兑换积分').fill('25');
    await dialog.getByLabel('每码可用次数').fill('3');
    await dialog
      .getByRole('button', { name: '确认生成', exact: true })
      .dblclick();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      count: 2,
      credits: 25,
      max_uses: 3,
      expires_at: null,
    });
    if (ambiguous) {
      await expect(page.getByRole('alertdialog')).toContainText(
        '创建结果暂未确认',
      );
      await dismissFeedback(page);
      await expect(
        dialog.getByRole('button', { name: '请先核对创建结果' }),
      ).toBeDisabled();
    } else {
      await expect(dialog.getByLabel('本次生成的兑换码')).toHaveValue(
        codes.join('\n'),
      );
      await dialog.getByRole('button', { name: '关闭弹窗' }).click();
      await expect(page.getByText('已加载 2 个兑换码')).toBeVisible();
      await expect(page.getByText('fixture-code-first')).toHaveCount(0);
      await page
        .getByRole('button', {
          name: '复制兑换码 1f8848d3-1bd4-4eb3-8c91-a653c27a11a0',
          exact: true,
        })
        .click();
      await expect(page.locator('.app-toast [role="status"]')).toContainText(
        '兑换码已复制',
      );
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        codes[0],
      );
      expect(copies).toHaveLength(1);
      expect(
        await page.evaluate(() =>
          [
            ...Object.values(localStorage),
            ...Object.values(sessionStorage),
          ].join('\n'),
        ),
      ).not.toContain('fixture-code-');
    }
    expect(writes).toHaveLength(1);
    await expect(page).toHaveURL(/\/admin\/credits\?tab=codes$/);
  });
}
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
  await expect(page.getByRole('alertdialog')).toContainText('签到成功');
  await dismissFeedback(page);
  await expect(page.getByRole('button', { name: '今日已签到' })).toBeDisabled();
  await page.getByLabel('兑换码', { exact: true }).fill('test-code');
  await page.getByRole('button', { name: '兑换', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await dismissFeedback(page);
  await page.getByRole('button', { name: '兑换', exact: true }).click();
  await expect(page.getByText('兑换成功，获得 25 积分')).toBeVisible();
  await dismissFeedback(page);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByRole('button', { name: /注册赠送/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);
  await page.getByRole('link', { name: '工作台', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '欢迎回来，Wallet' }),
  ).toBeVisible();
  await page.goto('/admin/credits');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
});

test('administrator adjustment confirms reason and preserves retry key', async ({
  page,
}) => {
  let fail = true;
  const keys: string[] = [];
  const searches: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/v1/me')
      return route.fulfill({
        json: {
          user: { ...user, role: 'ADMIN', mfa_enabled: true },
          csrf_token: 'csrf',
          mfa_required: false,
        },
      });
    const path = new URL(route.request().url()).pathname;
    const target = {
      ...user,
      status: 'ACTIVE',
      balance: 20,
      held: 0,
      created_at: '2026-10-24T00:00:00Z',
    };
    if (path === '/api/v1/admin/users') {
      searches.push(new URL(route.request().url()).searchParams.get('q') || '');
      return route.fulfill({ json: { items: [target], next_cursor: null } });
    }
    if (path === '/api/v1/admin/credits/adjustments')
      return route.fulfill({ json: [] });
    if (path === `/api/v1/admin/users/${user.id}`)
      return route.fulfill({ json: { user: { ...target, balance: 15 } } });
    if (route.request().method() === 'GET')
      return route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE' } },
      });
    const req = route.request();
    expect(req.headers()['x-csrf-token']).toBe('csrf');
    expect(req.postDataJSON()).toEqual({
      amount: -5,
      reason: '错误纠正：Support correction',
    });
    keys.push(req.headers()['idempotency-key']);
    if (fail) {
      fail = false;
      return route.abort('failed');
    }
    return route.fulfill({ json: { ledger_id: 11, credits: -5 } });
  });
  await page.goto('/admin/credits');
  await page.getByRole('combobox', { name: '用户', exact: true }).click();
  await page
    .getByRole('combobox', { name: '搜索用户', exact: true })
    .fill(user.id);
  await expect.poll(() => searches.includes(user.id)).toBe(true);
  await page.getByRole('listbox').locator(`[data-value="${user.id}"]`).click();
  await page.getByRole('button', { name: '扣减', exact: true }).click();
  await page.getByLabel('调整积分', { exact: true }).fill('5');
  await chooseSelect(
    page.getByRole('combobox', { name: '调整原因', exact: true }),
    '错误纠正',
  );
  await page.getByLabel('补充说明', { exact: true }).fill('Support correction');
  await page.getByRole('button', { name: '确认调整' }).click();
  await page
    .getByRole('dialog', { name: '确认调整积分？' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  expect(keys).toHaveLength(0);
  await page.getByRole('button', { name: '确认调整' }).click();
  await page
    .getByRole('dialog', { name: '确认调整积分？' })
    .getByRole('button', { name: '确认调整并入账', exact: true })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();
  await dismissFeedback(page);
  await page.getByRole('button', { name: '确认调整' }).click();
  await page
    .getByRole('dialog', { name: '确认调整积分？' })
    .getByRole('button', { name: '确认调整并入账', exact: true })
    .click();
  await expect(page.getByText('积分调整已入账，审计记录已保存')).toBeVisible();
  expect(keys[0]).toBe(keys[1]);
});

test('code copy keeps rows and column widths stable; lifecycle actions require confirmation', async ({
  page,
}) => {
  const id = '1f8848d3-1bd4-4eb3-8c91-a653c27a11a0';
  const secondId = '2f8848d3-1bd4-4eb3-8c91-a653c27a11a0';
  const writes: { method: string; body: unknown }[] = [];
  let listReads = 0;
  let copyRequests = 0;
  let releaseCopy = () => {};
  const copyGate = new Promise<void>((resolve) => {
    releaseCopy = resolve;
  });
  let items = [id, secondId].map((id) => ({
    id,
    credits: 100,
    used_count: 0,
    max_uses: 2,
    expires_at: null,
    created_at: '2026-10-24T00:00:00Z',
    copyable: true,
    revision: 1,
    disabled_at: null as string | null,
    deleted_at: null as string | null,
  }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          user: { ...user, role: 'ADMIN', mfa_enabled: true },
          csrf_token: 'csrf',
          mfa_required: false,
        },
      });
    if (path === '/api/v1/wallet')
      return route.fulfill({ json: { balance: 20, held: 0, available: 20 } });
    if (path === '/api/v1/admin/redeem-codes') {
      listReads++;
      return route.fulfill({ json: items.filter((item) => !item.deleted_at) });
    }
    if (path === `/api/v1/admin/redeem-codes/${id}/copy`) {
      copyRequests++;
      await copyGate;
      return route.fulfill({ json: { id, code: 'transient-fixture-code' } });
    }
    if (path === `/api/v1/admin/redeem-codes/${id}`) {
      expect(req.headers()['x-csrf-token']).toBe('csrf');
      const body = req.postDataJSON();
      writes.push({ method: req.method(), body });
      expect(body.revision).toBe(items[0].revision);
      items = items.map((row) =>
        row.id !== id
          ? row
          : {
              ...row,
              revision: row.revision + 1,
              disabled_at:
                body.disabled === true ? '2026-10-24T01:00:00Z' : null,
              deleted_at:
                req.method() === 'DELETE' ? '2026-10-24T02:00:00Z' : null,
            },
      );
      return route.fulfill({ json: items[0] });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });
  await page.goto('/admin/credits?tab=codes');
  const table = page.locator('.admin-code-table');
  const copy = page.getByRole('button', {
    name: `复制兑换码 ${id}`,
    exact: true,
  });
  await expect(copy).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByText('旧版仅存哈希的兑换码无法恢复。', { exact: false }),
  ).toHaveCount(0);
  await copy.evaluate((element) => {
    element.dataset.identity = 'original';
  });
  const widths = await table
    .locator('th')
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width),
    );
  const readsBeforeCopy = listReads;
  await copy.hover();
  await expect(copy).toHaveCSS('color', 'rgb(52, 79, 59)');
  await copy.locator('svg').evaluate((element) => {
    element.setAttribute('data-copy-icon', 'original');
  });
  const lookBefore = await copy.evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    color: getComputedStyle(element).color,
  }));
  await copy.click();
  await expect(copy).toHaveAttribute('aria-busy', 'true');
  await expect(copy).toHaveText('复制');
  await expect(copy).toHaveAttribute('aria-disabled', 'true');
  await expect(copy).not.toHaveAttribute('disabled');
  await expect(copy.locator('svg')).toHaveAttribute(
    'data-copy-icon',
    'original',
  );
  expect(
    await copy.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      color: getComputedStyle(element).color,
    })),
  ).toEqual(lookBefore);
  await copy.press('Enter');
  expect(copyRequests).toBe(1);
  await expect(
    page.getByRole('button', { name: `复制兑换码 ${secondId}`, exact: true }),
  ).toBeEnabled();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  expect(
    await table
      .locator('th')
      .evaluateAll((cells) =>
        cells.map((cell) => cell.getBoundingClientRect().width),
      ),
  ).toEqual(widths);
  await expect(copy).toHaveAttribute('data-identity', 'original');
  expect(listReads).toBe(readsBeforeCopy);
  releaseCopy();
  await expect(copy).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.app-toast [role="status"]')).toContainText(
    '兑换码已复制',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  const stop = page.getByRole('button', {
    name: `停用兑换码 ${id}`,
    exact: true,
  });
  await stop.click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '取消', exact: true })
    .click();
  expect(writes).toHaveLength(0);
  await stop.click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认停用', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('兑换码已停用');
  await dismissFeedback(page);
  await expect(
    page.getByRole('button', { name: `启用兑换码 ${id}`, exact: true }),
  ).toBeVisible();
  await expect(table.locator('tbody tr').first()).toContainText('已停用');
  expect(writes[0]).toEqual({
    method: 'PATCH',
    body: { revision: 1, disabled: true },
  });
  await page
    .getByRole('button', { name: `启用兑换码 ${id}`, exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认启用', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('兑换码已启用');
  await dismissFeedback(page);
  expect(writes[1]).toEqual({
    method: 'PATCH',
    body: { revision: 2, disabled: false },
  });
  await page
    .getByRole('button', { name: `删除兑换码 ${id}`, exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    '已兑换积分和历史记录保留',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '确认删除', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('兑换码已删除');
  await dismissFeedback(page);
  expect(writes[2]).toEqual({ method: 'DELETE', body: { revision: 3 } });
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('已加载 1 个兑换码')).toBeVisible();
  expect(
    await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].join(
        ' ',
      ),
    ),
  ).not.toContain('transient-fixture-code');
});
