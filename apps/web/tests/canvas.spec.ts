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
async function fixture(page: Page, initial = graph(), edit = true) {
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
                supports_edit: edit,
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
  await expect(page.getByLabel('画布创作参数')).not.toBeVisible();
  await page.getByRole('button', { name: '切换创作参数' }).click();
  await expect(page.getByLabel('画布创作参数')).toBeVisible();
  await expect(page.getByLabel('画布检查器')).not.toBeVisible();
  await page.getByRole('button', { name: '打开属性面板' }).click();
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
  await page.getByRole('button', { name: '打开属性面板' }).click();
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
  const api = await fixture(page, initial);
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
  await page.getByRole('button', { name: '选择工具', exact: true }).click();
  const pick = await page.locator('.react-flow__node').evaluateAll(
    (nodes) =>
      nodes
        .map((n) => ({
          id: n.getAttribute('data-id'),
          box: n.getBoundingClientRect(),
        }))
        .filter(
          (n) =>
            n.box.left > 550 &&
            n.box.top > 170 &&
            n.box.right < innerWidth - 30 &&
            n.box.bottom < innerHeight - 100,
        )
        .map((n) => n.id)[0],
  );
  expect(pick).toBeTruthy();
  const moving = page.locator(`.react-flow__node[data-id="${pick}"]`);
  const box2 = (await moving.boundingBox())!;
  const original = api.saved().nodes.find((n) => n.id === pick)!.position.x;
  const nodeFrames = page.evaluate(async () => {
    const frames: number[] = [];
    let previous = performance.now();
    await new Promise<void>((resolve) => {
      const next = (now: number) => {
        frames.push(now - previous);
        previous = now;
        if (frames.length >= 60) resolve();
        else requestAnimationFrame(next);
      };
      requestAnimationFrame(next);
    });
    return frames.slice(5);
  });
  await drag(page, box2.x + 70, box2.y + 80, 100, 45);
  const nodeIntervals = await nodeFrames;
  expect(
    nodeIntervals.reduce((a, b) => a + b, 0) / nodeIntervals.length,
  ).toBeLessThan(1000 / 30);
  await expect
    .poll(() => api.saved().nodes.find((n) => n.id === pick)!.position.x)
    .toBeGreaterThan(original + 80);
  expect(api.saved().nodes).toHaveLength(500);
});

const imageNode = () => ({
  id: 'reference-image',
  type: 'image' as const,
  position: { x: 50, y: 60 },
  size: { width: 280, height: 270 },
  data: { assetId, naturalW: 16, naturalH: 12, label: 'Reference', gen: null },
});
const textNode = () => ({
  id: 'prompt-text',
  type: 'text' as const,
  position: { x: 420, y: 60 },
  size: { width: 280, height: 200 },
  data: { text: 'A calm coast' },
});
async function drag(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 16 });
  await page.mouse.up();
}
test('image and text bodies drag without opening a preview or editing; a gesture saves and undoes once', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const initial = graph();
  initial.viewport.zoom = 1;
  initial.nodes = [imageNode(), textNode()];
  const api = await fixture(page, initial);
  await page.goto(`/canvas/${projectId}`);
  const image = page.locator(
    '.react-flow__node[data-id="reference-image"] .live-node-media',
  );
  const box = (await image.boundingBox())!;
  await drag(page, box.x + 80, box.y + 80, 85, 45);
  await expect.poll(() => api.saved().nodes[0].position.x).toBeGreaterThan(120);
  const draggedX = api.saved().nodes[0].position.x;
  expect(api.writes.filter((p) => p.endsWith('/graph')).length).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => api.saved().nodes[0].position.x).toBe(50);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(() => api.saved().nodes[0].position.x).toBe(draggedX);
  const text = page.locator('.react-flow__node[data-id="prompt-text"]');
  const textBox = (await text.locator('.node-note').boundingBox())!;
  await drag(page, textBox.x + 75, textBox.y + 65, 45, 65);
  await expect
    .poll(
      () => api.saved().nodes.find((n) => n.id === 'prompt-text')!.position.x,
    )
    .toBeGreaterThan(450);
  await text.dblclick({ position: { x: 80, y: 90 } });
  await expect(text.getByLabel('节点文字')).toBeEditable();
  await text.getByLabel('节点文字').fill('Edited without accidental dragging');
  await page.keyboard.press('Escape');
  await expect(text.getByLabel('节点文字')).not.toBeEditable();
  await page.getByRole('button', { name: '继续创作', exact: true }).click();
  await expect
    .poll(() => api.saved().edges.filter((e) => e.role === 'prompt').length)
    .toBe(1);
  expect(
    api.writes.filter((p) => p === '/api/v1/generation/jobs'),
  ).toHaveLength(0);
});
test('ports connect by clicking, selected curves disconnect by Delete, and undo restores them', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const initial = graph();
  initial.nodes = [imageNode(), { ...gen, position: { x: 450, y: 180 } }];
  const api = await fixture(page, initial);
  await page.goto(`/canvas/${projectId}`);
  await page.locator('[data-id="generator"] .graph-head').click();
  await expect(page.getByLabel('画布创作参数')).toBeVisible();
  await page.locator('[data-id="reference-image"] .source').click();
  await expect(page.getByLabel('画布创作参数')).not.toBeVisible();
  await page.locator('[data-id="generator"] .target').click();
  await expect.poll(() => api.saved().edges.length).toBe(1);
  const edge = page.locator('.react-flow__edge');
  const midpoint = await edge
    .locator('.react-flow__edge-path')
    .evaluate((element) => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const transformed = new DOMPoint(point.x, point.y).matrixTransform(
        path.getScreenCTM()!,
      );
      return { x: transformed.x, y: transformed.y };
    });
  await page.mouse.click(midpoint.x, midpoint.y);
  await page.getByRole('button', { name: '断开连线', exact: true }).click();
  await expect.poll(() => api.saved().edges.length).toBe(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(() => api.saved().edges.length).toBe(1);
});
test('right click creation, zoom controls and quick-reference action stay usable without paid writes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const initial = graph();
  initial.nodes = [imageNode()];
  const api = await fixture(page, initial);
  await page.goto(`/canvas/${projectId}`);
  await page.locator('[data-id="reference-image"] .graph-head').click();
  await page.getByRole('button', { name: '继续创作', exact: true }).click();
  await expect
    .poll(() => api.saved().edges.some((e) => e.role === 'reference'))
    .toBe(true);
  expect(api.writes.includes('/api/v1/generation/jobs')).toBe(false);
  await page.getByRole('button', { name: '切换创作参数' }).click();
  await expect(page.getByLabel('画布创作参数')).not.toBeVisible();
  const pane = page.locator('.react-flow__pane'),
    box = (await pane.boundingBox())!;
  await page.mouse.click(box.x + 80, box.y + 80, { button: 'right' });
  await page.getByRole('menuitem', { name: /文字节点/ }).click();
  await expect(page.getByLabel('节点文字')).toBeEditable();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '100%', exact: true }).click();
  const slider = page.getByLabel('画布缩放', { exact: true });
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(page.getByLabel('当前缩放')).toHaveText('105%');
  await page.getByRole('button', { name: '100%', exact: true }).click();
  await expect(page.getByLabel('当前缩放')).toHaveText('100%');
  await page.getByRole('button', { name: '画布快捷键' }).click();
  await expect(
    page.getByRole('dialog', { name: '画布操作与快捷键' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.screenshot({
    path: fileURLToPath(
      new URL(
        '../../../.tools/canvas-interaction-desktop.png',
        import.meta.url,
      ),
    ),
  });
});
test('node generation explains missing edit support before any job submission', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const initial = graph();
  initial.nodes = [
    imageNode(),
    { ...gen, data: { ...gen.data, prompt: 'A coast' } },
  ];
  initial.edges = [
    {
      id: 'reference-link',
      source: 'reference-image',
      target: 'generator',
      role: 'reference',
    },
  ];
  const api = await fixture(page, initial, false);
  await page.goto(`/canvas/${projectId}`);
  await page.locator('[data-id="generator"] .graph-head').click();
  await expect(page.getByLabel('生成模型')).toContainText('Canvas Image');
  await page
    .locator('[data-id="generator"]')
    .getByRole('button', { name: '生成', exact: true })
    .click();
  await expect(page.locator('.live-canvas-alert')).toContainText(
    '尚未开启图片编辑',
  );
  expect(api.writes.includes('/api/v1/generation/jobs')).toBe(false);
});

test('dragging an output to blank space preserves its preview and creates the chosen linked generator without submitting', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const initial = graph();
  initial.viewport.zoom = 1;
  initial.nodes = [textNode()];
  const api = await fixture(page, initial);
  await page.goto(`/canvas/${projectId}`);
  const source = page.locator('[data-id="prompt-text"] .source');
  const port = (await source.boundingBox())!;
  const draw = () =>
    drag(page, port.x + port.width / 2, port.y + port.height / 2, 180, 80);
  await draw();
  const menu = page.getByRole('menu', { name: '引用该节点生成' });
  await expect(menu).toBeVisible();
  await expect(page.locator('.canvas-pending-link path')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  expect(api.saved().nodes).toHaveLength(1);
  await draw();
  await menu.getByRole('menuitem', { name: /图片生成/ }).click();
  await expect.poll(() => api.saved().nodes.length).toBe(2);
  expect(api.saved().edges).toHaveLength(1);
  expect(api.saved().edges[0].role).toBe('prompt');
  const panel = page.getByLabel('画布创作参数');
  await expect(panel).toBeVisible();
  await expect(page.getByLabel('生成模型')).toHaveValue('image');
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThan(300);
  expect(box.y + box.height).toBeLessThanOrEqual(1000);
  await page.screenshot({
    path: fileURLToPath(
      new URL('../../../.tools/canvas-local-parameters.png', import.meta.url),
    ),
  });
  await page.setViewportSize({ width: 1040, height: 720 });
  const compact = (await panel.boundingBox())!;
  expect(compact.x).toBeGreaterThanOrEqual(0);
  expect(compact.x + compact.width).toBeLessThanOrEqual(1040);
  expect(compact.y + compact.height).toBeLessThanOrEqual(720);
  await expect(
    panel.getByRole('button', { name: '生成并连接结果' }),
  ).toBeInViewport();
  await page.screenshot({
    path: fileURLToPath(
      new URL(
        '../../../.tools/canvas-local-parameters-1040.png',
        import.meta.url,
      ),
    ),
  });
  await page.getByRole('button', { name: '关闭创作参数' }).click();
  await expect(panel).not.toBeVisible();
  expect(api.writes.includes('/api/v1/generation/jobs')).toBe(false);
});

test('blank drag pans by default, Shift selects nodes, toolbar hints and layer search are discoverable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const initial = graph();
  initial.viewport.zoom = 1;
  initial.nodes = [imageNode(), textNode()];
  const api = await fixture(page, initial);
  await page.goto(`/canvas/${projectId}`);
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await drag(page, pane.x + 100, pane.y + 400, 65, 40);
  await expect
    .poll(() => api.saved().viewport.x)
    .toBeGreaterThan(initial.viewport.x + 50);
  const nodes = page.locator('.react-flow__node');
  await nodes.first().locator('.graph-head').click();
  await nodes
    .nth(1)
    .locator('.graph-head')
    .click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.getByRole('button', { name: '上传素材到画布' }).hover();
  await expect(
    page.getByRole('tooltip', { name: '图片 / 视频 · I' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '打开属性面板' }).click();
  await page.getByRole('button', { name: '图层', exact: true }).click();
  await page.getByLabel('搜索画布节点').fill('calm');
  await expect(page.locator('.layer-list > button')).toHaveCount(1);
  await page.getByLabel('搜索画布节点').fill('no such node');
  await expect(
    page.getByText('没有匹配的节点，试试其他关键词。'),
  ).toBeVisible();
  expect(api.writes.includes('/api/v1/generation/jobs')).toBe(false);
});
