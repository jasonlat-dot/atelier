import { dismissFeedback } from './feedbackTestHelpers';
import { test, expect, type Page } from '@playwright/test';
import type { components } from '../src/lib/generated/api';
type S = components['schemas'];
const id = '1f8848d3-1bd4-4eb3-8c91-a653c27a11a0';
const owner = '2f8848d3-1bd4-4eb3-8c91-a653c27a11a0';
const jobId = '3f8848d3-1bd4-4eb3-8c91-a653c27a11a0';
const stamp = '2026-10-23T01:00:00Z';
const person: S['AdminUser'] = {
  id: owner,
  email: 'creator@gmail.com',
  display_name: '创作者',
  role: 'USER',
  status: 'ACTIVE',
  disabled_reason: null,
  revision: 1,
  mfa_enabled: false,
  created_at: stamp,
  last_login_at: stamp,
  balance: 40,
  held: 5,
  violations: 2,
};
const values: S['AdminSettingsValues'] = {
  registration_mode: 'CLOSED',
  registration_whitelist: [],
  signup_max_per_ip_24h: 5,
  signup_bonus: 20,
  checkin_base: 10,
  checkin_streak_cap: 5,
  checkin_tz: 'Asia/Shanghai',
  free_max_resolution: '2K',
  max_active_jobs_free: 1,
  asset_retention_days_free: 30,
  chat_credits_per_message: 1,
  chat_context_window: 32768,
  chat_output_tokens: 4096,
  maintenance_mode: false,
  admin_adjust_limit: 100000,
  moderation_threshold: 5,
  upstream_cost_rates: [],
};
async function mock(page: Page, role = 'SUPER_ADMIN') {
  const state = {
    user: structuredClone(person),
    requests: [] as string[],
    keys: [] as string[],
    bodies: [] as unknown[],
    creditFail: true,
    jobFail: true,
    inviteFail: false,
    invites: [] as S['AdminInvite'][],
    rules: [] as S['AdminRule'][],
    settings: {
      revision: 1,
      values: structuredClone(values),
      models: [
        { id: 'public-image', display_name: 'Studio Image', kind: 'image' },
      ],
    },
    jobs: [
      {
        id: jobId,
        owner_id: owner,
        email: person.email,
        model_id: 'public-image',
        display_name: 'Studio Image',
        kind: 'image',
        status: 'SUCCEEDED',
        cost: 6,
        settled: 6,
        released: 0,
        refunded: 0,
        progress: 100,
        attempts: 1,
        cancel_requested: false,
        error_code: null,
        created_at: stamp,
        finished_at: stamp,
      },
    ] as S['AdminJob'][],
  };
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    state.requests.push(`${req.method()} ${path}${url.search}`);
    const ok = (json: unknown) => route.fulfill({ json });
    const fail = (status: number, code: string) =>
      route.fulfill({ status, json: { error: { code, message: 'fixture' } } });
    if (req.method() !== 'GET')
      expect(req.headers()['x-csrf-token']).toBe('csrf');
    if (path === '/me')
      return ok({
        user: {
          id,
          email: 'admin@gmail.com',
          display_name: '管理员',
          role,
          mfa_enabled: role !== 'USER',
        },
        csrf_token: 'csrf',
        mfa_required: false,
      });
    if (path === '/wallet')
      return ok({
        balance: 30,
        held: 0,
        available: 30,
        checked_in_today: false,
        streak: 0,
        next_reward: 10,
        local_date: '2026-10-23',
        timezone: 'Asia/Shanghai',
      });
    if (path === '/me/usage')
      return ok({
        days: 7,
        daily: [
          { day: '2026-10-23', jobs: 2, succeeded: 1, failed: 1, consumed: 7 },
        ],
        qualities: [{ quality: 'high', jobs: 2 }],
      });
    if (path === '/admin/users')
      return ok({
        items: url.searchParams.get('before')
          ? [
              {
                ...state.user,
                id: jobId,
                email: 'next@gmail.com',
                display_name: '下一页用户',
              },
            ]
          : [state.user],
        next_cursor: url.searchParams.has('before') ? null : owner,
      });
    if (path === `/admin/users/${owner}`)
      return ok({
        user: state.user,
        adjust_limit: 100000,
        jobs: state.jobs,
        sessions: [],
        ledger: { items: [], next_cursor: null },
      });
    if (path === `/admin/users/${owner}/credits`) {
      state.keys.push(req.headers()['idempotency-key']);
      state.bodies.push(req.postDataJSON());
      if (state.creditFail) {
        state.creditFail = false;
        return fail(503, 'UNAVAILABLE');
      }
      state.user.balance += req.postDataJSON().amount;
      return ok({
        balance: state.user.balance,
        held: 5,
        available: state.user.balance - 5,
      });
    }
    if (
      path === `/admin/users/${owner}/disable` ||
      path === `/admin/users/${owner}/enable`
    ) {
      state.user.status = path.endsWith('disable') ? 'DISABLED' : 'ACTIVE';
      state.user.revision++;
      return ok(state.user);
    }
    if (path === '/admin/settings') {
      if (req.method() === 'GET') return ok(state.settings);
      state.bodies.push(req.postDataJSON());
      state.settings = {
        ...state.settings,
        revision: 2,
        values: req.postDataJSON().values,
      };
      return ok(state.settings);
    }
    if (path === '/admin/jobs') {
      const scoped = state.jobs.filter(
        (job) =>
          (!url.searchParams.get('user_id') ||
            job.owner_id === url.searchParams.get('user_id')) &&
          (!url.searchParams.get('q') ||
            `${job.id} ${job.email} ${job.display_name}`
              .toLowerCase()
              .includes(url.searchParams.get('q')!.toLowerCase())),
      );
      const counts: Record<string, number> = { ALL: scoped.length };
      for (const status of [
        'QUEUED',
        'ROUTING',
        'RUNNING',
        'STORING',
        'SUCCEEDED',
        'PARTIAL',
        'CANCELLED',
        'FAILED',
      ])
        counts[status] = scoped.filter((job) => job.status === status).length;
      return ok({
        items: scoped.filter(
          (job) =>
            !url.searchParams.get('status') ||
            job.status === url.searchParams.get('status'),
        ),
        next_cursor: null,
        counts,
      });
    }
    if (path === `/admin/jobs/${jobId}/refund`) {
      state.keys.push(req.headers()['idempotency-key']);
      state.bodies.push(req.postDataJSON());
      if (state.jobFail) {
        state.jobFail = false;
        return fail(503, 'UNAVAILABLE');
      }
      state.jobs[0].refunded = 6;
      return ok(state.jobs[0]);
    }
    if (path === '/admin/moderation-rules') {
      if (req.method() === 'GET')
        return ok({ items: state.rules, next_cursor: null });
      const r = { ...req.postDataJSON(), id: 1, revision: 1 };
      state.rules = [r];
      return ok(r);
    }
    if (path === '/admin/moderation-rules/1') {
      if (req.method() === 'DELETE') {
        state.rules = [];
        return route.fulfill({ status: 204 });
      }
      state.rules = [{ ...req.postDataJSON(), id: 1, revision: 2 }];
      return ok(state.rules[0]);
    }
    if (path === '/admin/invite-codes') {
      if (req.method() === 'GET')
        return ok({ items: state.invites, next_cursor: null });
      if (state.inviteFail) return fail(503, 'UNAVAILABLE');
      const invite = {
        id: jobId,
        label: req.postDataJSON().label,
        max_uses: req.postDataJSON().max_uses,
        used_count: 0,
        last4: 'abcd',
        expires_at: null,
        created_at: stamp,
        revoked_at: null,
        revision: 1,
      };
      state.invites = [invite];
      return ok({ invite, code: 'ati_fixture_onetime_abcd' });
    }
    if (path === `/admin/invite-codes/${jobId}`) {
      state.invites[0].revoked_at = stamp;
      return ok(state.invites[0]);
    }
    if (path === '/admin/audit')
      return ok({
        items: [
          {
            id: 1,
            actor_id: id,
            email: 'admin@gmail.com',
            action: 'ADMIN_SETTINGS_UPDATED',
            target_type: 'settings',
            target_id: 'global',
            before: { registration_mode: 'CLOSED' },
            after: { value: { registration_mode: 'OPEN' }, reason: '核对注册' },
            created_at: stamp,
          },
        ],
        next_cursor: null,
      });
    if (path === '/admin/dashboard')
      return ok({
        days: 7,
        users_total: 123,
        active_users_today: 12,
        new_users: 5,
        jobs_total: 10,
        succeeded_jobs: 8,
        failed_jobs: 1,
        active_jobs: 1,
        issued_credits: 500,
        consumed_credits: 160,
        compensated_credits: 6,
        pending_orders: 0,
        order_amounts: [],
        daily: [
          { day: '2026-10-22', jobs: 3, succeeded: 3, failed: 0, consumed: 60 },
          {
            day: '2026-10-23',
            jobs: 7,
            succeeded: 5,
            failed: 1,
            consumed: 100,
          },
        ],
        qualities: [{ quality: 'high', jobs: 10 }],
        health: [
          {
            status: 'ACTIVE',
            accounts: 2,
            capacity: 4,
            live_slots: 1,
            quota_remaining: 200,
          },
        ],
        notifications: [],
        pending_reviews: 0,
        estimated_costs: [],
        unpriced_units: 8,
      });
    return fail(404, 'NOT_FOUND');
  });
  page.on('dialog', () => {
    throw new Error('Native browser dialog is not allowed');
  });
  return state;
}
test('ordinary users cannot mount admin requests and can see only own usage', async ({
  page,
}) => {
  const state = await mock(page, 'USER');
  for (const path of [
    '/admin',
    '/admin/users',
    '/admin/jobs',
    '/admin/settings',
    '/admin/policy',
    '/admin/audit',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
  }
  expect(state.requests.some((p) => p.includes('/admin/'))).toBe(false);
  await page.goto('/usage');
  await expect(
    page.getByRole('heading', { name: '用量分析', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('本期积分消费', { exact: true })).toBeVisible();
  expect(state.requests.some((p) => p.includes('/me/usage?'))).toBe(true);
});
test('administrator has no settings or audit surface', async ({ page }) => {
  const state = await mock(page, 'ADMIN');
  await page.goto('/admin/settings');
  await expect(page.getByText('管理员专属', { exact: true })).toHaveCount(3);
  await expect(page.getByText('超级管理员专属', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: '平台设置', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: '系统管理', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: '上游账号池', exact: true }),
  ).toBeVisible();
  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
  expect(state.requests.some((p) => p.includes('/admin/'))).toBe(false);
});
test('user pagination search and credit confirmation preserve financial retry', async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto('/admin/users');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByText('下一页用户', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.getByLabel('搜索用户').fill('creator');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect
    .poll(() => state.requests.some((r) => r.includes('q=creator')))
    .toBe(true);
  await page.getByRole('button', { name: '查看用户', exact: true }).click();
  await page.getByRole('button', { name: '调整积分', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '调整积分', exact: true });
  await modal.getByLabel('调整积分', { exact: false }).fill('7');
  await modal.getByRole('button', { name: '扣减', exact: true }).click();
  await modal.getByLabel('调整积分', { exact: true }).fill('36');
  await expect(
    modal.getByRole('button', { name: '核对调整', exact: true }),
  ).toBeDisabled();
  await modal.getByRole('button', { name: '+10', exact: true }).click();
  await expect(
    modal.getByRole('button', { name: '增加', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await modal.getByLabel('调整积分', { exact: true }).fill('7');
  await modal.getByRole('combobox', { name: '调整原因' }).click();
  await page.getByRole('option', { name: '运营奖励', exact: true }).click();
  await modal.getByLabel('补充说明').fill('补充验收积分');
  await modal.getByRole('button', { name: '核对调整', exact: true }).click();
  expect(state.keys).toHaveLength(0);
  await expect(modal.locator('.credit-confirm-balance')).toContainText('35');
  await expect(modal.locator('.credit-confirm-balance')).toContainText('42');
  await expect(modal).toContainText('运营奖励');
  await modal
    .getByRole('button', { name: '确认调整积分', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('操作未完成');
  await dismissFeedback(page);
  await expect(
    modal.getByRole('button', { name: '按原内容重试' }),
  ).toBeVisible();
  await modal.getByRole('button', { name: '按原内容重试' }).click();
  await expect(modal).toHaveCount(0);
  expect(state.keys[0]).toBe(state.keys[1]);
  expect(state.bodies[0]).toEqual(state.bodies[1]);
  expect(state.user.balance).toBe(47);
  await expect(page.getByRole('alertdialog')).toContainText('调整积分已完成');
  await dismissFeedback(page);
  await page.getByRole('button', { name: '禁用账号', exact: true }).click();
  const disable = page.getByRole('dialog', { name: '禁用账号', exact: true });
  await expect(disable).toContainText('立即撤销全部会话');
  await disable.getByLabel('处理说明').fill('验收禁用');
  await disable
    .getByRole('button', { name: '确认禁用账号', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('禁用账号已完成');
  await dismissFeedback(page);
  await expect(
    page.getByRole('button', { name: '恢复账号', exact: true }),
  ).toBeVisible();
});
test('settings changes require an explicit review and audit reason', async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto('/admin/settings');
  await page.getByRole('radio', { name: '开放注册', exact: false }).check();
  await page.getByLabel('注册赠送积分', { exact: false }).fill('25');
  await page.getByRole('button', { name: '核对并保存' }).click();
  const dialog = page.getByRole('dialog', { name: '确认变更平台设置' });
  await expect(dialog).toContainText('CLOSED → OPEN');
  expect(state.bodies).toHaveLength(0);
  await dialog.getByLabel('变更说明').fill('开放小范围验收');
  await dialog.getByRole('button', { name: '确认保存设置' }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.settings.values.registration_mode).toBe('OPEN');
  expect(state.settings.values.signup_bonus).toBe(25);
  await expect(page.getByRole('button', { name: '核对并保存' })).toBeDisabled();
  await page.getByRole('link', { name: '审计日志', exact: true }).click();
  await page.getByRole('button', { name: '查看变更' }).click();
  await expect(page.getByRole('dialog')).toContainText('核对注册');
});
test('rules and one-time invite creation use custom dialogs and can be revoked', async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto('/admin/policy');
  await page.getByRole('button', { name: '新增规则', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('匹配内容').fill('fixture-blocked');
  await dialog.getByLabel('处理说明').fill('测试内容拦截');
  await dialog.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('规则已保存');
  await dismissFeedback(page);
  await expect(
    page.getByText('fixture-blocked', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '删除规则', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('处理说明').fill('移除测试规则');
  await dialog.getByRole('button', { name: '确认删除规则' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('规则已删除');
  await dismissFeedback(page);
  await expect(page.getByText('暂无匹配的内容规则。')).toBeVisible();
  await page.getByRole('tab', { name: '邀请码', exact: true }).click();
  await page.getByRole('button', { name: '创建邀请码', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('邀请备注').fill('验收邀请');
  await dialog.getByLabel('处理说明').fill('测试注册');
  await dialog.getByRole('button', { name: '确认创建邀请' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('邀请码记录已更新');
  await dismissFeedback(page);
  await expect(page.getByLabel('完整邀请码', { exact: true })).toHaveValue(
    'ati_fixture_onetime_abcd',
  );
  await page.getByRole('button', { name: '已保存，关闭' }).click();
  await expect(page.getByText('•••• abcd', { exact: true })).toBeVisible();
  await expect(
    page.getByText('ati_fixture_onetime_abcd', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '撤销邀请', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('处理说明').fill('验收结束');
  await dialog.getByRole('button', { name: '确认撤销邀请' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('邀请码记录已更新');
  await dismissFeedback(page);
  await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
  expect(state.invites[0].revoked_at).toBeTruthy();
});
test('ambiguous invite creation prevents duplicate creation', async ({
  page,
}) => {
  const state = await mock(page);
  state.inviteFail = true;
  await page.goto('/admin/policy');
  await page.getByRole('tab', { name: '邀请码', exact: true }).click();
  await page.getByRole('button', { name: '创建邀请码', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('邀请备注').fill('不确定邀请');
  await modal.getByLabel('处理说明').fill('故障验收');
  await modal.getByRole('button', { name: '确认创建邀请' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('未完成');
  await expect(page.getByRole('alertdialog')).toContainText(
    '先撤销该记录再创建',
  );
  await dismissFeedback(page);
  await expect(
    modal.getByRole('button', { name: '确认创建邀请' }),
  ).toBeDisabled();
  expect(
    state.requests.filter((r) => r === 'POST /admin/invite-codes'),
  ).toHaveLength(1);
});
test('job compensation retries keep the same request and disable a second compensation', async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto('/admin/jobs');
  await page.getByRole('button', { name: '补偿积分', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认补偿积分' });
  await expect(dialog).toContainText('不会恢复原订单');
  await dialog.getByLabel('处理说明').fill('质量问题人工补偿');
  await dialog
    .getByRole('button', { name: '确认补偿积分', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('未完成');
  await dismissFeedback(page);
  await dialog.getByRole('button', { name: '按原请求重试' }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.keys[0]).toBe(state.keys[1]);
  expect(state.bodies[0]).toEqual(state.bodies[1]);
  await expect(page.getByRole('alertdialog')).toContainText('积分补偿已入账');
  await dismissFeedback(page);
  await expect(
    page.getByRole('button', { name: '补偿积分', exact: true }),
  ).toBeDisabled();
});
test('dashboard and settings remain contained on desktop and mobile', async ({
  page,
}) => {
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/admin');
  await expect(page.getByText('8 个输出单位未计入估算。')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('m9-dashboard.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/settings');
  await expect(page.getByRole('button', { name: '核对并保存' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath('m9-settings-mobile.png'),
    fullPage: true,
  });
});

test('job status cards filter the list and preserve counts in the search scope', async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto('/admin/jobs');
  const cards = page.getByRole('region', { name: '任务状态筛选' });
  await expect(cards.getByRole('button')).toHaveCount(9);
  expect(
    await cards
      .getByRole('button')
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute('aria-label')),
      ),
  ).toEqual([
    '全部任务',
    '已完成',
    '已取消',
    '已失败',
    '部分完成',
    '排队中',
    '正在分配',
    '生成中',
    '正在保存',
  ]);

  await expect(
    cards.getByRole('button', { name: '全部任务', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    cards
      .getByRole('button', { name: '已完成', exact: true })
      .locator('strong'),
  ).toHaveText('1');
  await cards.getByRole('button', { name: '已失败', exact: true }).click();
  await expect
    .poll(() => state.requests.some((r) => r.includes('status=FAILED')))
    .toBe(true);
  await expect(
    page.getByRole('table').getByText('Studio Image', { exact: true }),
  ).toHaveCount(0);
  await expect(
    cards
      .getByRole('button', { name: '已完成', exact: true })
      .locator('strong'),
  ).toHaveText('1');
  await expect(
    cards
      .getByRole('button', { name: '已失败', exact: true })
      .locator('strong'),
  ).toHaveText('0');
  await cards.getByRole('button', { name: '全部任务', exact: true }).click();
  await expect(
    page.getByRole('table').getByText('Studio Image', { exact: true }),
  ).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索任务' }).fill('nonexistent');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(
    cards
      .getByRole('button', { name: '全部任务', exact: true })
      .locator('strong'),
  ).toHaveText('0');
});

test('clipboard success uses an unobtrusive toast on pages and inside user details', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });
  await mock(page);
  await page.goto('/admin/jobs');
  const copy = page.getByRole('button', {
    name: `复制任务 ID ${jobId}`,
    exact: true,
  });
  await copy.click();
  await expect(page.locator('.app-toast [role="status"]')).toHaveText(
    '任务 ID 已复制',
  );
  await expect(page.locator('.app-toast-viewport')).toHaveAttribute(
    'data-position',
    'top-center',
  );
  await expect(page.locator('.app-toast-progress')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(copy).toBeFocused();
  await copy.click();
  await expect(page.locator('.app-toast')).toHaveCount(1);
  await page
    .getByRole('searchbox', { name: '搜索任务' })
    .fill('still editable');
  await expect(page.locator('.app-toast')).toHaveCount(0, { timeout: 6000 });
  await page.goto('/admin/users');
  await page.getByRole('button', { name: '查看用户', exact: true }).click();
  const details = page.getByRole('dialog', { name: '用户详情', exact: true });
  const copyUser = details.getByRole('button', {
    name: '复制用户 ID',
    exact: true,
  });
  await copyUser.click();
  await expect(details.locator('.app-toast [role="status"]')).toHaveText(
    '用户 ID 已复制',
  );
  await expect(details.locator('.app-toast-viewport')).toHaveJSProperty(
    'popover',
    'manual',
  );
  await expect(copyUser).toBeFocused();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await details.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(page.locator('.app-toast')).toHaveCount(0);
  await expect(details).toBeVisible();
});

test('job email opens user details in place and has a separate copy action', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          Object.assign(window, { copiedEmail: text });
        },
      },
    });
  });
  const state = await mock(page);
  await page.goto(`/admin/jobs?user=${owner}`);
  const cards = page.getByRole('region', { name: '任务状态筛选' });
  await cards.getByRole('button', { name: '已完成', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索任务' }).fill('creator');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page
    .getByRole('button', { name: `复制邮箱 ${person.email}`, exact: true })
    .click();
  await expect(page.locator('.app-toast [role="status"]')).toHaveText(
    '邮箱已复制',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'copiedEmail'))).toBe(
    person.email,
  );
  await expect(
    page.getByRole('dialog', { name: '用户详情', exact: true }),
  ).toHaveCount(0);
  expect(
    state.requests.some((request) => request.includes(`/admin/users/${owner}`)),
  ).toBe(false);
  const before = page.url();
  await page
    .getByRole('button', { name: `查看用户 ${person.email}`, exact: true })
    .click();
  const details = page.getByRole('dialog', { name: '用户详情', exact: true });
  await expect(
    details.getByRole('heading', { name: '创作者', exact: true }),
  ).toBeVisible();
  expect(page.url()).toBe(before);
  expect(
    state.requests.some((request) => request.startsWith('GET /admin/users?')),
  ).toBe(false);
  await details.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: '搜索任务' })).toHaveValue(
    'creator',
  );
  await expect(
    cards.getByRole('button', { name: '已完成', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: `查看用户 ${person.email}`, exact: true }),
  ).toBeFocused();
  expect(page.url()).toBe(before);
});
