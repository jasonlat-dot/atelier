import { dismissFeedback } from './feedbackTestHelpers';
import { test, expect, type Page } from '@playwright/test';
const sampleAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '图片主池',
  kind: 'openai_compatible',
  group_tag: 'images',
  priority: 0,
  weight: 100,
  concurrency_limit: 2,
  quota_total: 100,
  quota_remaining: 80,
  quota_reset_at: null,
  status: 'ACTIVE',
  cooldown_until: null,
  consecutive_failures: 0,
  last_error: null,
  last_used_at: null,
  secret_last4: '1234',
  endpoint_configured: true,
  revision: 1,
  in_flight: 0,
  requests_24h: 10,
  successes_24h: 9,
  average_ms: 123,
  created_at: '2026-10-23T00:00:00Z',
};
const sampleModel = {
  id: 'atelier-image',
  display_name: 'Atelier Image',
  kind: 'image',
  upstream_configured: true,
  enabled: false,
  sort_order: 0,
  revision: 1,
  account_ids: [] as string[],
  group_tags: [] as string[],
  capabilities: {
    qualities: ['low', 'medium', 'high'],
    ratios: ['1:1', '16:9'],
    resolutions: ['1K', '2K'],
    max_n: 2,
    max_refs: 1,
    supports_edit: true,
    size_mode: 'flex',
    sizes: [],
    seconds: [],
  },
};
async function fixture(page: Page, role = 'SUPER_ADMIN') {
  const accounts = [structuredClone(sampleAccount)];
  const models = [structuredClone(sampleModel)];
  let pricing = {
    revision: 1,
    rules: [] as {
      model_id: string;
      quality: string;
      base_credits: number;
      edit_surcharge: number;
    }[],
    multipliers: ['1K', '2K', '4K', '720p', '1080p', 'text'].map(
      (resolution, i) => ({ resolution, multiplier: [1, 2, 4, 1, 2, 1][i] }),
    ),
  };
  const writes: { path: string; body: Record<string, unknown> | null }[] = [];
  const reads: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (method !== 'GET') {
      expect(req.headers()['x-csrf-token']).toBe('csrf-m4');
      writes.push({ path, body: req.postDataJSON() });
    } else reads.push(path);
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          user: {
            id: 'admin',
            email: 'admin@gmail.com',
            display_name: '管理员',
            role,
            mfa_enabled: true,
          },
          csrf_token: 'csrf-m4',
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
    if (path === '/api/v1/admin/upstream-accounts') {
      if (method === 'GET')
        return route.fulfill({
          json: {
            items: accounts.filter(
              (a) =>
                a.name.includes(url.searchParams.get('search') || '') ||
                a.group_tag.includes(url.searchParams.get('search') || ''),
            ),
            next_cursor: null,
          },
        });
      const b = req.postDataJSON();
      accounts.push({
        ...sampleAccount,
        ...b,
        id: '22222222-2222-4222-8222-222222222222',
        base_url: undefined,
        secret: undefined,
      });
      return route.fulfill({ status: 201, json: accounts.at(-1) });
    }
    if (path.endsWith('/import'))
      return route.fulfill({ status: 201, json: [sampleAccount] });
    if (path.endsWith('/test')) {
      await new Promise((r) => setTimeout(r, 150));
      return route.fulfill({ json: { ok: true, code: null, elapsed_ms: 45 } });
    }
    if (path.endsWith('/stats'))
      return route.fulfill({
        json: {
          total: 10,
          successes: 9,
          average_ms: 123,
          errors: [{ code: 'UPSTREAM_ERROR', count: 1 }],
        },
      });
    if (path.includes('/upstream-accounts/')) {
      const id = path.split('/')[5];
      const index = accounts.findIndex((a) => a.id === id);
      const a = accounts[index];
      if (path.endsWith('/refresh-quota')) {
        Object.assign(a, req.postDataJSON(), { revision: a.revision + 1 });
        return route.fulfill({ json: a });
      }
      if (method === 'DELETE') {
        accounts.splice(index, 1);
        return route.fulfill({ status: 204 });
      }
      if (method === 'PATCH') {
        const b = req.postDataJSON();
        Object.assign(a, b, {
          revision: a.revision + 1,
          status: b.enabled ? 'ACTIVE' : 'DISABLED',
          secret: undefined,
          base_url: undefined,
        });
        return route.fulfill({ json: a });
      }
    }
    if (path === '/api/v1/admin/models') {
      if (method === 'GET') return route.fulfill({ json: models });
      const b = req.postDataJSON();
      const old = models.find((m) => m.id === b.id);
      if (b.enabled && !old?.group_tags.length && !old?.account_ids.length)
        return route.fulfill({
          status: 422,
          json: { error: { code: 'INVALID_ARGUMENT' } },
        });
      if (old)
        Object.assign(old, b, {
          revision: old.revision + 1,
          upstream_model: undefined,
        });
      else models.push({ ...sampleModel, ...b, upstream_model: undefined });
      return route.fulfill({
        status: old ? 200 : 201,
        json: old || models.at(-1),
      });
    }
    if (path.endsWith('/accounts')) {
      const m = models[0];
      Object.assign(m, req.postDataJSON(), { revision: m.revision + 1 });
      return route.fulfill({ json: m });
    }
    if (path === '/api/v1/admin/pricing') {
      if (method === 'PUT')
        pricing = { ...req.postDataJSON(), revision: pricing.revision + 1 };
      return route.fulfill({ json: pricing });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });
  return { accounts, models, writes, reads };
}
test('account management writes once, hides saved credentials and uses accessible confirmation', async ({
  page,
}) => {
  const f = await fixture(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', () => {
    throw Error('native dialog');
  });
  await page.goto('/admin/accounts');
  await expect(page.getByRole('cell', { name: /^图片主池/ })).toBeVisible();
  await page.getByRole('button', { name: '新增账号', exact: true }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('账号名称').fill('新账号');
  await d.getByLabel('接口地址').fill('http://localhost:3000/v1');
  await d.getByLabel('API 密钥').fill('synthetic-secret-9876');
  await d.getByRole('button', { name: '保存配置' }).dblclick();
  await expect(d).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toContainText('账号配置已保存');
  await dismissFeedback(page);
  expect(
    f.writes.find((w) => w.path === '/api/v1/admin/upstream-accounts')?.body
      ?.base_url,
  ).toBe('http://localhost:3000/v1');
  expect(
    f.writes.filter((w) => w.path === '/api/v1/admin/upstream-accounts'),
  ).toHaveLength(1);
  await expect(page.locator('body')).not.toContainText('synthetic-secret');
  await page.getByRole('button', { name: '编辑 新账号', exact: true }).click();
  await expect(d.getByLabel('接口地址')).toHaveValue('');
  await expect(d.getByLabel('API 密钥')).toHaveValue('');
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: '测试连接 图片主池', exact: true })
    .dblclick();
  await expect(
    page.getByRole('status').filter({ hasText: '图片主池 连接正常' }),
  ).toBeVisible();
  expect(f.writes.filter((w) => w.path.endsWith('/test'))).toHaveLength(1);
  await dismissFeedback(page);
  await page.getByRole('button', { name: '查看统计 图片主池' }).click();
  await expect(d).toContainText('90%');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '更新额度 图片主池' }).click();
  await d.getByLabel('剩余额度').fill('101');
  await d.getByRole('button', { name: '更新额度', exact: true }).click();
  await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText(
    '不能超过',
  );
  await dismissFeedback(page);
  await d.getByLabel('剩余额度').fill('90');
  await d.getByRole('button', { name: '更新额度', exact: true }).click();
  await expect(d).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toContainText('额度已更新');
  await dismissFeedback(page);
  await expect(
    page.getByRole('progressbar', { name: '图片主池 剩余额度' }),
  ).toHaveAttribute('value', '90');
  await page.getByRole('button', { name: '停用 图片主池' }).click();
  await expect(d.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Escape');
  expect(f.writes.filter((w) => w.body?.enabled === false)).toHaveLength(0);
  await page.getByRole('button', { name: '停用 图片主池' }).click();
  await d.getByRole('button', { name: '停用账号', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('已停用');
  await dismissFeedback(page);
  await expect(page.getByText('已停用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除 新账号' }).click();
  await d.getByRole('button', { name: '删除账号', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑 新账号' })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
});
test('JSON import validates before sending and clears materials on close; search has an empty state', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/admin/accounts');
  await page.getByRole('button', { name: 'JSON 导入' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('账号 JSON').fill('{}');
  await d.getByRole('button', { name: '校验并导入' }).click();
  await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText(
    '有效 JSON',
  );
  await dismissFeedback(page);
  expect(f.writes).toHaveLength(0);
  await d
    .getByLabel('账号 JSON')
    .fill(JSON.stringify([{ name: 'import', secret: 'temporary-only' }]));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'JSON 导入' }).click();
  await expect(d.getByLabel('账号 JSON')).toHaveValue('');
  await d
    .getByLabel('账号 JSON')
    .fill(JSON.stringify([{ name: 'import', secret: 'temporary-only' }]));
  await d.getByRole('button', { name: '校验并导入' }).click();
  await expect(d).toHaveCount(0);
  expect(f.writes[0].path).toMatch(/\/import$/);
  await expect(page.getByRole('alertdialog')).toContainText('已导入');
  await dismissFeedback(page);
  await page.getByLabel('搜索账号名称或分组').fill('missing');
  await expect(page.getByText('没有匹配的账号', { exact: true })).toBeVisible();
});
test('models need bindings and pricing; price drafts survive tabs and native identifiers stay write only', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/admin/models');
  await page
    .getByRole('button', { name: '启用 Atelier Image', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('账号绑定及价格');
  await dismissFeedback(page);
  await page.getByRole('button', { name: '绑定账号 Atelier Image' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('动态分组').fill('images');
  await d.getByLabel('图片主池 · images').check();
  await d.getByRole('button', { name: '保存绑定' }).click();
  await expect(d).toHaveCount(0);
  expect(f.models[0].group_tags).toEqual(['images']);
  await expect(page.getByRole('alertdialog')).toContainText('路由绑定已保存');
  await dismissFeedback(page);
  await page.getByRole('tab', { name: '积分定价' }).click();
  await page.getByLabel('Atelier Image low 基础积分').fill('10');
  await page.getByLabel('Atelier Image medium 基础积分').fill('20');
  await page.getByLabel('Atelier Image high 基础积分').fill('30');
  await page.getByLabel('Atelier Image low 编辑附加费').fill('2');
  await page.getByRole('tab', { name: '模型目录' }).click();
  await page.getByRole('tab', { name: '积分定价' }).click();
  await expect(page.getByLabel('Atelier Image low 基础积分')).toHaveValue('10');
  await page.getByRole('button', { name: '保存全部价格' }).click();
  await expect(page.getByRole('status')).toContainText('价格已保存');
  await dismissFeedback(page);
  expect(
    f.writes.find((w) => w.path.endsWith('/pricing'))?.body?.revision,
  ).toBe(1);
  await page.getByRole('tab', { name: '模型目录' }).click();
  await page
    .getByRole('button', { name: '启用 Atelier Image', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('模型已启用');
  await dismissFeedback(page);
  await expect(page.getByText('已启用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑 Atelier Image' }).click();
  await expect(d.getByLabel('上游模型标识')).toHaveValue('');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '新增模型' }).click();
  await d.getByLabel('公开模型标识').fill('video-one');
  await d.getByLabel('展示名称').fill('Video One');
  await d.getByLabel('模型类型').selectOption('video');
  await expect(d.getByLabel('支持时长（秒）')).toHaveValue('4, 8, 12');
  await d.getByLabel('上游模型标识').fill('private-native-video');
  await d.getByRole('button', { name: '保存模型' }).click();
  await expect(d).toHaveCount(0);
  const create = f.writes.find((w) => w.body?.id === 'video-one')?.body;
  expect(create?.enabled).toBe(false);
  expect(create?.kind).toBe('video');
  await expect(page.locator('body')).not.toContainText('private-native-video');
});
test('ordinary users cannot fetch management data; mobile tables scroll within the page', async ({
  page,
}) => {
  const f = await fixture(page, 'USER');
  await page.goto('/admin/accounts');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await page.goto('/admin/models');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
  expect(f.reads.some((p) => p.includes('/admin/'))).toBe(false);
});
test('initial empty search never resets a page selected before the search debounce', async ({
  page,
}) => {
  await fixture(page);
  const now = new Date('2026-10-24T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.route('**/api/v1/admin/upstream-accounts?*', (route) => {
    const nextPage = new URL(route.request().url()).searchParams.has('before');
    return route.fulfill({
      json: {
        items: [{ ...sampleAccount, name: nextPage ? '备用池' : '图片主池' }],
        next_cursor: nextPage ? null : sampleAccount.id,
      },
    });
  });
  await page.goto('/admin/accounts');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑 备用池' })).toBeVisible();
  await page.clock.fastForward(600);
  await expect(page.getByRole('button', { name: '编辑 备用池' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '上一页', exact: true }),
  ).toBeEnabled();
});

test('temporary failures retry, cursor paging restores the first page and failed probes are explicit', async ({
  page,
}) => {
  await fixture(page);
  let first = true;
  await page.route('**/api/v1/admin/upstream-accounts?*', async (route) => {
    const u = new URL(route.request().url());
    if (first) {
      return route.fulfill({
        status: 503,
        json: { error: { code: 'SERVICE_UNAVAILABLE' } },
      });
    }
    return route.fulfill({
      json: {
        items: [
          {
            ...sampleAccount,
            name: u.searchParams.has('before') ? '备用池' : '图片主池',
          },
        ],
        next_cursor: u.searchParams.has('before') ? null : sampleAccount.id,
      },
    });
  });
  await page.goto('/admin/accounts');
  await expect(page.getByRole('alert')).toContainText('服务暂不可用');
  first = false;
  await page.getByRole('button', { name: '重试加载' }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑 备用池' })).toBeVisible();
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '编辑 图片主池' }),
  ).toBeVisible();
  await page.route('**/api/v1/admin/upstream-accounts/*/test', (route) =>
    route.fulfill({
      json: { ok: false, code: 'ACCOUNT_INVALID', elapsed_ms: 5 },
    }),
  );
  await page.getByRole('button', { name: '测试连接 图片主池' }).click();
  await expect(page.getByRole('alert')).toContainText('凭据无效');
  await dismissFeedback(page);
  await page.route('**/api/v1/admin/upstream-accounts/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    return route.fulfill({
      status: 409,
      json: { error: { code: 'CONFIG_CONFLICT' } },
    });
  });
  await page.getByRole('button', { name: '编辑 图片主池' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByRole('alertdialog').getByRole('alert')).toContainText(
    '配置已变更',
  );
  await dismissFeedback(page);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: '编辑 图片主池' }),
  ).toBeFocused();
});
test('320px account drawer and model pricing fit viewport without native dialogs', async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/admin/accounts');
  await expect(
    page.getByRole('button', { name: '编辑 图片主池' }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('accounts-desktop.png') });
  await page.getByRole('button', { name: '新增账号', exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath('account-drawer-desktop.png'),
  });
  await page.keyboard.press('Escape');
  await page.goto('/admin/models');
  await expect(
    page.getByRole('button', { name: '编辑 Atelier Image' }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('models-desktop.png') });
  await page.getByRole('tab', { name: '积分定价' }).click();
  await page.screenshot({ path: testInfo.outputPath('pricing-desktop.png') });
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/admin/accounts');
  await page.getByRole('button', { name: '新增账号', exact: true }).click();
  const d = page.getByRole('dialog');
  await expect(d).toBeVisible();
  expect(await d.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('account-drawer-mobile.png'),
  });
  await page.keyboard.press('Escape');
  await page.goto('/admin/models');
  await page.getByRole('tab', { name: '积分定价' }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
