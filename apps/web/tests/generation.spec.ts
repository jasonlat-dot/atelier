import { test, expect, type Page } from '@playwright/test';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const image = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '参考海报',
  kind: 'image',
  source: 'upload',
  state: 'READY',
  bytes: 100,
  width: 1024,
  height: 1024,
  created_at: '2026-10-23T00:00:00Z',
  expires_at: '2026-11-23T00:00:00Z',
  media_url: '/fixture.png',
  thumbnail_url: '/fixture.png',
};
const caps = {
  qualities: ['low', 'high'],
  ratios: ['1:1', '16:9'],
  resolutions: ['1K', '2K', '4K'],
  max_n: 3,
  max_refs: 2,
  supports_edit: true,
  size_mode: 'flex',
  sizes: [],
  seconds: [],
};
const catalog = {
  models: [
    {
      id: 'image',
      kind: 'image',
      display_name: 'Atelier Image',
      capabilities: caps,
      prices: [],
    },
    {
      id: 'video',
      kind: 'video',
      display_name: 'Atelier Video',
      capabilities: {
        ...caps,
        max_n: 1,
        max_refs: 1,
        resolutions: ['720p'],
        seconds: [4, 8],
      },
      prices: [],
    },
  ],
  multipliers: [],
};
const jobBase = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'image',
  model_id: 'image',
  display_name: 'Atelier Image',
  prompt: '海边日落',
  params: {
    quality: 'low',
    ratio: '1:1',
    resolution: '1K',
    seconds: null,
    references: [],
  },
  size: '1024x1024',
  n: 1,
  cost: 7,
  cost_per_output: 7,
  settled: 0,
  released: 0,
  status: 'QUEUED',
  error_code: null as string | null,
  attempts: 0,
  progress: 0,
  cancel_requested: false,
  outputs: [] as { idx: number; asset: typeof image }[],
  created_at: '2026-10-23T00:00:00Z',
  updated_at: '2026-10-23T00:00:00Z',
  finished_at: null as string | null,
};
async function fixture(
  page: Page,
  options: {
    ambiguous?: boolean;
    empty?: boolean;
    jobs?: (typeof jobBase)[];
  } = {},
) {
  const writes: { body: Record<string, unknown>; key?: string }[] = [];
  const state = {
    jobs: options.jobs || ([] as (typeof jobBase)[]),
    available: 100,
    held: 0,
    expired: false,
    quotes: 0,
    cancelled: 0,
  };
  await page.addInitScript(() => {
    class Stream {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      callback: ((event: MessageEvent) => void) | null = null;
      constructor() {
        (window as unknown as { stream: Stream }).stream = this;
        setTimeout(() => this.onopen?.(), 100);
      }
      addEventListener(_name: string, callback: (event: MessageEvent) => void) {
        this.callback = callback;
      }
      close() {}
    }
    window.EventSource = Stream as unknown as typeof EventSource;
  });
  await page.route('**/fixture.png', (r) =>
    r.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (state.expired)
      return route.fulfill({
        status: 401,
        json: { error: { code: 'UNAUTHENTICATED' } },
      });
    if (method !== 'GET') expect(req.headers()['x-csrf-token']).toBe('csrf-m5');
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          user: {
            id: 'user',
            email: 'user@gmail.com',
            display_name: '创作者',
            role: 'USER',
            mfa_enabled: false,
          },
          csrf_token: 'csrf-m5',
          mfa_required: false,
        },
      });
    if (path === '/api/v1/wallet')
      return route.fulfill({
        json: {
          balance: state.available + state.held,
          held: state.held,
          available: state.available,
          checked_in_today: false,
          streak: 0,
          next_reward: 10,
          local_date: '2026-10-23',
          timezone: 'Asia/Shanghai',
        },
      });
    if (path === '/api/v1/models')
      return route.fulfill({
        json: options.empty ? { models: [], multipliers: [] } : catalog,
      });
    if (path === '/api/v1/generation/limits')
      return route.fulfill({
        json: {
          tier: 'FREE',
          max_resolution: '2K',
          max_active_jobs: 1,
          video_enabled: true,
        },
      });
    if (path === '/api/v1/generation/quote') {
      state.quotes++;
      const body = req.postDataJSON();
      return route.fulfill({
        json: {
          kind: body.model_id,
          cost: 7 * body.n + body.ref_count * 2,
          cost_per_output: 7,
          size: body.model_id === 'video' ? '1280x720' : '1024x1024',
          model_revision: 1,
          pricing_revision: 1,
          timeout_seconds: 120,
        },
      });
    }
    if (path === '/api/v1/generation/jobs' && method === 'POST') {
      const body = req.postDataJSON();
      writes.push({ body, key: req.headers()['idempotency-key'] });
      state.jobs = [
        {
          ...jobBase,
          prompt: body.prompt,
          n: body.n,
          kind: body.model_id,
          params: { ...jobBase.params, ...body },
          cost: 7 * body.n,
        },
      ];
      state.available = 100 - 7 * body.n;
      state.held = 7 * body.n;
      if (options.ambiguous && writes.length === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: 'UNAVAILABLE' } },
        });
      await new Promise((r) => setTimeout(r, 150));
      return route.fulfill({ status: 202, json: { job: state.jobs[0] } });
    }
    if (path.endsWith('/cancel')) {
      state.cancelled++;
      state.jobs[0] = {
        ...state.jobs[0],
        status: 'CANCELLED',
        released: state.jobs[0].cost,
        finished_at: '2026-10-23T00:01:00Z',
      };
      state.available = 100;
      state.held = 0;
      return route.fulfill({ json: { job: state.jobs[0] } });
    }
    if (path === '/api/v1/generation/jobs')
      return route.fulfill({ json: { items: state.jobs, next_cursor: null } });
    if (path.startsWith('/api/v1/generation/jobs/'))
      return route.fulfill({ json: state.jobs[0] });
    if (path === '/api/v1/assets')
      return route.fulfill({
        json: { items: [image], total: 1, next_cursor: null },
      });
    if (path.startsWith('/api/v1/assets/'))
      return route.fulfill({ json: image });
    throw new Error(`Unexpected ${method} ${path}`);
  });
  await page.goto('/generate');
  await expect(page.getByRole('heading', { name: '生成工作台' })).toBeVisible();
  return { writes, state };
}
test('result preview stays within the workspace and viewport for wide screens and portrait media', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 2473, height: 1138 });
  const fixtureData = await fixture(page, {
    jobs: [
      {
        ...jobBase,
        status: 'SUCCEEDED',
        progress: 100,
        settled: 7,
        outputs: [{ idx: 0, asset: image }],
      },
    ],
  });
  await page.route('**/fixture.png', (route) => {
    const { width, height } = fixtureData.state.jobs[0].outputs[0].asset;
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#e8e1d4"/><rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#8c7358" stroke-width="16"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#cbb9a0"/></svg>`,
    });
  });
  for (const viewport of [
    { width: 2473, height: 1138 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const [width, height] of [
      [1024, 1024],
      [900, 1600],
      [1600, 900],
    ]) {
      fixtureData.state.jobs[0].outputs[0].asset = { ...image, width, height };
      await page.reload();
      const media = page.getByRole('button', {
        name: '预览结果 1',
        exact: true,
      });
      await expect(media).toBeVisible();
      const bounds = await media.boundingBox();
      await page.screenshot({
        path: info.outputPath(
          `preview-${viewport.width}-${width}x${height}.png`,
        ),
        fullPage: false,
      });
      expect(bounds!.height).toBeLessThanOrEqual(480);
      expect(bounds!.height).toBeGreaterThanOrEqual(180);
      expect(
        await media
          .locator('img')
          .evaluate((el) => getComputedStyle(el).objectFit),
      ).toBe('contain');
      expect(
        await page
          .locator('.generation-page')
          .evaluate((el) => el.getBoundingClientRect().width),
      ).toBeLessThanOrEqual(1440);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (viewport.width >= 1181) {
        expect(bounds!.y).toBeGreaterThanOrEqual(64);
        expect(bounds!.y + bounds!.height).toBeLessThan(viewport.height);
        const action = await page
          .getByRole('button', { name: '复用参数', exact: true })
          .boundingBox();
        expect(
          action!.y + action!.height,
          JSON.stringify(
            await page.locator('.gen-stage').evaluate((el) => ({
              width: el.getBoundingClientRect().width,
              top: el.getBoundingClientRect().top,
              html: [...el.children].map((child) => ({
                name: child.className,
                height: child.getBoundingClientRect().height,
              })),
            })),
          ),
        ).toBeLessThan(viewport.height);
        const submit = await page
          .getByRole('button', { name: '生成图片', exact: true })
          .boundingBox();
        expect(submit!.y + submit!.height).toBeLessThan(viewport.height);
      }
    }
    await page.screenshot({
      path: info.outputPath(`bounded-preview-${viewport.width}.png`),
      fullPage: false,
    });
  }
  expect(fixtureData.writes).toHaveLength(0);
});
test('home composer carries a private draft into generation without submitting a paid job', async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.route(/\/api\/v1\/projects(?:\?|$)/, (r) =>
    r.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.goto('/');
  await page.getByLabel('描述你想创作的内容').fill('雨夜城市里的电影海报');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page).toHaveURL(/\/generate$/);
  await expect(page.getByLabel('画面描述')).toHaveValue('雨夜城市里的电影海报');
  expect(writes).toHaveLength(0);
});

test('authoritative quote, tier and model capabilities drive an idempotent submission and cancellation', async ({
  page,
}) => {
  const f = await fixture(page);
  await expect(page.getByLabel('分辨率').locator('option')).toHaveText([
    '1K',
    '2K',
  ]);
  await expect(page.getByLabel('生成数量').locator('option')).toHaveCount(3);
  await page.getByLabel('画面描述').fill('海边日落');
  const submit = page.getByRole('button', { name: '生成图片', exact: true });
  await expect(submit).toBeEnabled();
  await expect(page.locator('.gen-price strong')).toContainText('7');
  await submit.dblclick();
  await expect(page.getByRole('button', { name: '取消任务' })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(f.writes[0].body).not.toHaveProperty('cost');
  await page.getByRole('button', { name: '取消任务' }).click();
  await expect(page.locator('.gen-settlement')).toContainText('已退回 7 积分');
  expect(f.state.cancelled).toBe(1);
  await expect(page.getByLabel('侧栏积分').locator('strong')).toHaveText('100');
});
test('an ambiguous submission freezes the draft and retries exactly the same key and body', async ({
  page,
}) => {
  const f = await fixture(page, { ambiguous: true });
  await page.getByLabel('画面描述').fill('雨后街角');
  await page.getByRole('button', { name: '生成图片', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('提交结果尚未确认');
  await expect(page.getByLabel('画面描述')).toBeDisabled();
  await page.getByRole('button', { name: '重试确认提交' }).click();
  await expect(page.getByRole('button', { name: '取消任务' })).toBeVisible();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]).toEqual(f.writes[1]);
});
test('reference selection and video parameters obey actual model capabilities', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: '参考图生成', exact: true }).click();
  await page.getByLabel('画面描述').fill('将参考图改为水彩风格');
  await expect(
    page.getByRole('button', { name: '生成图片', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择参考图片' });
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '使用所选图片' }).click();
  await expect(page.locator('.gen-price strong')).toContainText('9');
  await page.getByRole('button', { name: '生成图片', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].body.references).toEqual([
    { asset_id: image.id, role: 'reference' },
  ]);
  await page.getByRole('button', { name: '视频', exact: true }).click();
  await expect(page.getByLabel('视频时长').locator('option')).toHaveText([
    '4 秒',
    '8 秒',
  ]);
  await expect(page.getByLabel('生成数量')).toHaveCount(0);
  await expect(page.locator('.gen-ref-list img')).toHaveCount(0);
});
test('SSE refreshes partial results and wallet, preview downloads use stored media and reuse does not submit', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.getByLabel('画面描述').fill('海边日落');
  await page.getByLabel('生成数量').selectOption('3');
  await page.getByRole('button', { name: '生成图片', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消任务' })).toBeVisible();
  f.state.jobs[0] = {
    ...f.state.jobs[0],
    status: 'PARTIAL',
    progress: 100,
    settled: 7,
    released: 14,
    outputs: [{ idx: 0, asset: { ...image, source: 'generation' } }],
    finished_at: '2026-10-23T00:01:00Z',
  };
  f.state.available = 93;
  f.state.held = 0;
  await page.evaluate(() =>
    (
      window as unknown as { stream: { callback: (e: unknown) => void } }
    ).stream.callback({ lastEventId: '88' }),
  );
  await expect(
    page.getByText('已完成 1 / 3 个结果，未完成部分已退回积分。'),
  ).toBeVisible();
  await expect(page.getByLabel('侧栏积分').locator('strong')).toHaveText('93');
  await page.getByRole('button', { name: '预览结果 1' }).click();
  await expect(page.getByRole('img', { name: '生成结果大图' })).toBeVisible();
  await expect(page.getByRole('link', { name: '下载原文件' })).toHaveAttribute(
    'href',
    '/fixture.png',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '复用参数' }).click();
  expect(f.writes).toHaveLength(1);
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.locator('.app-content').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: info.outputPath('generation-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  if (
    (await page
      .getByRole('button', { name: '展开折叠边栏' })
      .getAttribute('aria-expanded')) === 'true'
  )
    await page.getByRole('button', { name: '收起导航' }).click();
  await page.locator('.app-content').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: info.outputPath('generation-mobile.png'),
    fullPage: true,
  });
});
test('SSE failure falls back to polling and session expiry returns to login', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.evaluate(() =>
    (window as unknown as { stream: { onerror: () => void } }).stream.onerror(),
  );
  await expect(page.getByRole('status')).toContainText('自动刷新');
  f.state.jobs = [
    { ...jobBase, status: 'FAILED', released: 7, error_code: 'TIMEOUT' },
  ];
  await expect(page.getByText('这次没有生成结果')).toBeVisible({
    timeout: 8000,
  });
  f.state.expired = true;
  await page.getByRole('button', { name: '刷新生成记录' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
test('no enabled model gives an actionable empty state without a fake generation button', async ({
  page,
}) => {
  await fixture(page, { empty: true });
  await expect(page.getByText('还没有可用模型')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '生成图片', exact: true }),
  ).toHaveCount(0);
});
