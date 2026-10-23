import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { components } from '../src/lib/generated/api';
type Graph = components['schemas']['CanvasGraph'];
const projectId = '10000000-0000-4000-8000-000000000001';
const assetId = '20000000-0000-4000-8000-000000000001';
const gen = {
  id: 'generator',
  type: 'generate' as const,
  position: { x: 380, y: 150 },
  size: { width: 280, height: 290 },
  data: {
    modelId: 'image',
    prompt: '',
    quality: 'low',
    ratio: '1:1',
    resolution: '1K',
    n: 1,
  },
};
const graph = (): Graph => ({
  version: 1,
  nodes: [],
  edges: [],
  viewport: { x: 30, y: 50, zoom: 0.7 },
  background: 'dots',
});
async function fixture(page: Page, initial = graph()) {
  let saved = initial,
    revision = 0,
    conflict = false;
  let jobs: unknown[] = [];
  const writes: string[] = [];
  const asset = {
    id: assetId,
    name: 'Canvas reference.png',
    kind: 'image',
    source: 'upload',
    state: 'READY',
    error_code: null,
    bytes: 100,
    width: 16,
    height: 12,
    duration_ms: null,
    media_url: '/canvas-image.png?original=1',
    thumbnail_url: '/canvas-image.png',
    created_at: '2026-10-23T00:00:00Z',
    expires_at: '2027-01-01T00:00:00Z',
  };
  const info = () => ({
    id: projectId,
    name: 'Test canvas',
    revision,
    created_at: '2026-10-23T00:00:00Z',
    updated_at: '2026-10-23T00:00:00Z',
  });
  const view = () => ({ project: info(), graph: saved, assets: [asset] });
  await page.route('**/canvas-image.png*', (route) =>
    route.fulfill({
      path: new URL(
        '../../../services/api/crates/app/tests/fixtures/reference.png',
        import.meta.url,
      ).pathname.replace(/^\/([A-Z]:)/, '$1'),
    }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    if (!['GET', 'HEAD'].includes(method)) {
      writes.push(path);
      expect(req.headers()['x-csrf-token']).toBe('csrf');
    }
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          user: {
            id: 'canvas-user',
            email: 'canvas@gmail.com',
            display_name: 'Canvas',
            role: 'USER',
            mfa_enabled: false,
          },
          csrf_token: 'csrf',
          mfa_required: false,
        },
      });
    if (path === '/api/v1/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: ': fixture\n\n',
      });
    if (path === '/api/v1/wallet')
      return route.fulfill({
        json: {
          balance: 100,
          held: 0,
          available: 100,
          checked_in_today: false,
          streak: 0,
          next_reward: 10,
        },
      });
    if (path === '/api/v1/models')
      return route.fulfill({
        json: {
          models: [
            {
              id: 'image',
              display_name: 'Canvas Image',
              kind: 'image',
              capabilities: {
                qualities: ['low'],
                ratios: ['1:1'],
                resolutions: ['1K'],
                max_n: 4,
                max_refs: 4,
                supports_edit: true,
              },
              prices: [
                {
                  model_id: 'image',
                  quality: 'low',
                  base_credits: 2,
                  edit_surcharge: 0,
                },
              ],
            },
          ],
          multipliers: [{ resolution: '1K', multiplier: 1 }],
        },
      });
    if (path === '/api/v1/generation/limits')
      return route.fulfill({
        json: {
          tier: 'free',
          max_resolution: '2K',
          max_active_jobs: 1,
          video_enabled: true,
        },
      });
    if (path === '/api/v1/generation/quote')
      return route.fulfill({
        json: {
          kind: 'image',
          cost: 2,
          cost_per_output: 2,
          size: '1024x1024',
          model_revision: 1,
          pricing_revision: 1,
          timeout_seconds: 60,
        },
      });
    if (path === '/api/v1/assets/uploads')
      return route.fulfill({ status: 201, json: asset });
    if (path === '/api/v1/assets')
      return route.fulfill({
        json: { items: [asset], next_cursor: null, total: 1 },
      });
    if (path === `/api/v1/assets/${assetId}`)
      return route.fulfill({ json: asset });
    if (path === '/api/v1/projects' && method === 'GET')
      return route.fulfill({ json: { items: [info()], next_cursor: null } });
    if (path === '/api/v1/projects' && method === 'POST') {
      expect(req.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
      saved = req.postDataJSON().graph;
      return route.fulfill({ status: 201, json: view() });
    }
    if (path === `/api/v1/projects/${projectId}`)
      return route.fulfill({ json: view() });
    if (path === `/api/v1/projects/${projectId}/snapshots`)
      return route.fulfill({
        json: [
          { id: 'snapshot', revision: 0, created_at: '2026-10-23T00:00:00Z' },
        ],
      });
    if (path === `/api/v1/projects/${projectId}/graph`) {
      if (conflict)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'REVISION_CONFLICT' } },
        });
      expect(req.headers()['if-match']).toBe(`"${revision}"`);
      saved = req.postDataJSON();
      revision++;
      return route.fulfill({ json: view() });
    }
    if (path === '/api/v1/generation/jobs' && method === 'POST') {
      const body = req.postDataJSON();
      expect(body.project_id).toBe(projectId);
      expect(
        saved.nodes.some((n) => n.id === body.node_id && n.type === 'generate'),
      ).toBe(true);
      expect(req.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
      const job = {
        id: '30000000-0000-4000-8000-000000000001',
        project_id: projectId,
        node_id: body.node_id,
        kind: 'image',
        model_id: 'image',
        display_name: 'Canvas Image',
        prompt: body.prompt,
        params: {
          quality: 'low',
          ratio: '1:1',
          resolution: '1K',
          references: body.references || [],
          seconds: null,
        },
        size: '1024x1024',
        n: 1,
        cost: 2,
        cost_per_output: 2,
        settled: 2,
        released: 0,
        status: 'SUCCEEDED',
        error_code: null,
        attempts: 1,
        progress: 100,
        cancel_requested: false,
        outputs: [{ idx: 0, asset: { ...asset, source: 'generated' } }],
        created_at: '2026-10-23T00:01:00Z',
        updated_at: '2026-10-23T00:01:00Z',
        finished_at: '2026-10-23T00:01:00Z',
      };
      jobs = [job];
      return route.fulfill({ status: 202, json: { job } });
    }
    if (path === '/api/v1/generation/jobs')
      return route.fulfill({ json: { items: jobs, next_cursor: null } });
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });
  return {
    saved: () => saved,
    revision: () => revision,
    writes,
    conflict: () => {
      conflict = true;
    },
  };
}
test('canvas edits autosave, survive reload, undo and redo with the prototype layout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const api = await fixture(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/canvas/${projectId}`);
  await expect(page.getByLabel('画布创作参数')).toBeVisible();
  await expect(page.getByLabel('画布检查器')).toBeVisible();
  await page.getByRole('button', { name: '添加文字节点', exact: true }).click();
  await page.getByLabel('节点文字').fill('A calm coast');
  await expect.poll(() => api.saved().nodes.length).toBe(1);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('节点文字')).toHaveValue('A calm coast');
  await page.getByRole('button', { name: '添加文字节点', exact: true }).click();
  await expect(page.getByLabel('节点文字')).toHaveCount(2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('节点文字')).toHaveCount(1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.getByLabel('节点文字')).toHaveCount(2);
  await page.getByLabel('画布背景').selectOption('lines');
  await page.getByRole('link', { name: '我的素材库', exact: true }).click();
  await expect(page).toHaveURL(/\/assets$/);
  expect(api.saved().background).toBe('lines');
  expect(api.saved().nodes.length).toBe(2);
  expect(errors).toEqual([]);
});
test('canvas upload and linked generation return result nodes once and retain them after reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const initial = graph();
  initial.nodes = [{ ...gen, data: { ...gen.data, prompt: 'A sunset' } }];
  const api = await fixture(page, initial);
  await page.goto(`/canvas/${projectId}`);
  await page.getByLabel('画布上传文件').setInputFiles({
    name: 'Canvas reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('fixture'),
  });
  await expect.poll(() => api.saved().nodes.length).toBe(2);
  await page
    .locator('.react-flow__node[data-id="generator"]')
    .click({ position: { x: 100, y: 15 } });
  await page.getByRole('button', { name: '选择参考', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('button', { name: '使用所选图片' }).click();
  await page.getByRole('button', { name: '生成并连接结果' }).click();
  await expect
    .poll(() => api.saved().edges.filter((e) => e.role === 'result').length)
    .toBe(1);
  expect(api.saved().edges.some((e) => e.role === 'reference')).toBe(true);
  expect(
    api.saved().nodes.some((n) => n.type === 'image' && !!n.data.gen),
  ).toBe(true);
  const length = api.saved().nodes.length;
  await page.reload();
  await expect(page.locator('.react-flow__node')).not.toHaveCount(0);
  await expect.poll(() => api.saved().nodes.length).toBe(length);
  await page.screenshot({
    path: fileURLToPath(
      new URL('../../../.tools/m6-canvas-desktop.png', import.meta.url),
    ),
    fullPage: true,
  });
});
test('revision conflict keeps local edits and offers a custom resolution dialog', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const api = await fixture(page);
  await page.goto(`/canvas/${projectId}`);
  api.conflict();
  await page.getByRole('button', { name: '添加文字节点', exact: true }).click();
  await page.getByLabel('节点文字').fill('Keep my edit');
  const dialog = page.getByRole('dialog', { name: '画布已在其他页面更新' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '载入最新版本' }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: '另存副本' })).toBeVisible();
  await expect(page.getByLabel('节点文字')).toHaveValue('Keep my edit');
  expect(api.saved().nodes).toHaveLength(0);
  await dialog.getByRole('button', { name: '载入最新版本' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel('节点文字')).toHaveCount(0);
});
test('small screens view the persisted canvas without editing or paid generation writes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const initial = graph();
  initial.nodes = [gen];
  const api = await fixture(page, initial);
  await page.goto(`/canvas/${projectId}`);
  await expect(
    page.getByText('当前屏幕仅支持查看画布', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('画布创作参数')).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: '添加文字节点', exact: true }),
  ).not.toBeVisible();
  await page.keyboard.press('Control+KeyA');
  await page.keyboard.press('Delete');
  expect(api.saved().nodes).toHaveLength(1);
  expect(api.writes).toHaveLength(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('500-node canvas only renders visible nodes and remains responsive while panning', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const initial = graph();
  initial.nodes = Array.from({ length: 500 }, (_, i) => ({
    id: `n${i}`,
    type: 'text',
    position: { x: (i % 25) * 330, y: Math.floor(i / 25) * 280 },
    size: { width: 240, height: 180 },
    data: { text: `Node ${i}` },
  }));
  await fixture(page, initial);
  await page.goto(`/canvas/${projectId}`);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  expect(await page.locator('.react-flow__node').count()).toBeLessThan(100);
  const measuring = page.evaluate(async () => {
    const intervals: number[] = [];
    let previous = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        intervals.push(now - previous);
        previous = now;
        if (intervals.length >= 60) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return intervals.slice(5);
  });

  await page.getByRole('button', { name: '平移工具' }).click();
  const pane = page.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2 - 250,
    box!.y + box!.height / 2 - 100,
    { steps: 30 },
  );
  await page.mouse.up();
  const frames = await measuring;
  expect(frames.reduce((a, b) => a + b, 0) / frames.length).toBeLessThan(
    1000 / 30,
  );
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
});
