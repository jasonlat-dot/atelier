import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const png = readFileSync(
  new URL(
    '../../../services/api/crates/app/tests/fixtures/reference.png',
    import.meta.url,
  ),
);
const id = '4990bf00-78bd-4260-9001-f80d449af100';
const initial = (suffix: number, name: string) => ({
  id: id.slice(0, -1) + suffix,
  name,
  kind: 'image',
  source: 'upload',
  state: 'READY',
  error_code: null,
  bytes: 200,
  width: 16,
  height: 8,
  duration_ms: null,
  media_url: `/media/${id.slice(0, -1) + suffix}/original?expires=9999999999&signature=test-only`,
  thumbnail_url: `/media/${id.slice(0, -1) + suffix}/thumbnail?expires=9999999999&signature=test-only`,
  created_at: '2026-10-22T00:00:00Z',
  expires_at: '2026-11-21T00:00:00Z',
});
async function fixture(page: Page, failLimits = false) {
  let items = [
    initial(1, 'Reference.png'),
    initial(2, 'Landscape.png'),
    initial(3, 'Poster.png'),
  ];
  const writes: string[] = [];
  await page.route('**/media/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: png }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          user: {
            id,
            display_name: 'Library',
            email: 'library@gmail.com',
            role: 'USER',
            mfa_enabled: false,
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
          local_date: '2026-10-22',
          timezone: 'Asia/Shanghai',
          checked_in_today: false,
          streak: 0,
          next_reward: 10,
        },
      });
    if (path === '/api/v1/assets/limits') {
      if (failLimits) {
        return route.fulfill({
          status: 503,
          json: { error: { code: 'SERVICE_UNAVAILABLE' } },
        });
      }
      return route.fulfill({
        json: {
          image_max_bytes: 20971520,
          video_max_bytes: 209715200,
          video_enabled: false,
          max_video_seconds: 60,
        },
      });
    }
    if (request.method() !== 'GET') {
      expect(request.headers()['x-csrf-token']).toBe('csrf');
      writes.push(request.method() + ' ' + path);
    }
    if (path === '/api/v1/assets/uploads') {
      expect(request.headers()['content-type']).toMatch(
        /^multipart\/form-data; boundary=/,
      );
      expect(request.postDataBuffer()?.includes(png)).toBe(true);
      items = [initial(4, 'Uploaded.png'), ...items];
      return route.fulfill({ status: 201, json: items[0] });
    }
    if (path === '/api/v1/assets' && request.method() === 'DELETE') {
      const ids = request.postDataJSON().ids as string[];
      items = items.filter((item) => !ids.includes(item.id));
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/v1/assets') {
      const matches = items.filter(
        (item) =>
          (!url.searchParams.get('kind') ||
            item.kind === url.searchParams.get('kind')) &&
          (!url.searchParams.get('source') ||
            item.source === url.searchParams.get('source')) &&
          item.name
            .toLowerCase()
            .includes((url.searchParams.get('search') || '').toLowerCase()),
      );
      const before = url.searchParams.get('before');
      const offset = before
        ? matches.findIndex((item) => item.id === before) + 1
        : 0;
      const list = matches.slice(offset, offset + 2);
      return route.fulfill({
        json: {
          items: list,
          total: matches.length,
          next_cursor:
            offset + list.length < matches.length ? list.at(-1)?.id : null,
        },
      });
    }
    if (path.startsWith('/api/v1/assets/')) {
      const item = items.find((item) => item.id === path.split('/').at(-1));
      if (item) return route.fulfill({ json: item });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });
  return {
    writes,
    recoverLimits: () => {
      failLimits = false;
    },
  };
}
test('video processing stays unplayable until server completion and failures stay actionable', async ({
  page,
}) => {
  await fixture(page);
  let completed = false;
  await page.route(/\/api\/v1\/assets(?:\?.*)?$/, (route) => {
    return route.fulfill({
      json: {
        items: [
          {
            ...initial(1, 'Film.mp4'),
            kind: 'video',
            duration_ms: 2000,
            state: completed ? 'READY' : 'PROCESSING',
            thumbnail_url: completed ? '/media/film/thumbnail' : null,
            media_url: completed ? '/media/film/original' : null,
          },
          {
            ...initial(2, 'Broken.mp4'),
            kind: 'video',
            state: 'FAILED',
            thumbnail_url: null,
            media_url: null,
          },
        ],
        total: 2,
        next_cursor: null,
      },
    });
  });
  await page.goto('/assets');
  await expect(
    page.getByRole('button', { name: '预览 Film.mp4' }),
  ).toBeDisabled();
  await expect(page.getByText('正在处理…', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '预览 Broken.mp4' }),
  ).toBeDisabled();
  await expect(
    page.getByText('处理失败，请重新上传', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('未生成可用文件')).toBeVisible();
  completed = true;
  await expect(page.getByRole('button', { name: '预览 Film.mp4' })).toBeEnabled(
    { timeout: 10000 },
  );
  await expect(page.getByText('16 × 8 · 1 KB · 2.0 秒')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '删除 Broken.mp4' }),
  ).toBeEnabled();
});
test('prototype library uploads multipart, previews fresh media, filters and confirms batch deletion', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { writes } = await fixture(page);
  await page.goto('/');
  await page.getByRole('link', { name: /^素材库/ }).click();
  await expect(page.getByRole('heading', { name: '我的素材库' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: '我的素材库', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('共 3 个素材', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(
    page.getByRole('button', { name: '预览 Poster.png' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '预览 Reference.png' }).click();
  const preview = page.getByRole('dialog', { name: 'Reference.png' });
  await expect(
    preview.getByRole('img', { name: 'Reference.png' }),
  ).toBeVisible();
  await expect(preview.getByRole('link', { name: '下载素材' })).toHaveAttribute(
    'download',
    /\.png$/,
  );
  await page.keyboard.press('Escape');
  await expect(preview).not.toBeVisible();
  await page.getByLabel('搜索素材', { exact: true }).fill('Landscape');
  await expect(page.getByText('共 1 个素材', { exact: true })).toBeVisible();
  await page.getByLabel('搜索素材', { exact: true }).fill('');
  await expect(page.getByText('共 3 个素材', { exact: true })).toBeVisible();
  await page.getByLabel('选择上传素材', { exact: true }).setInputFiles({
    name: 'Uploaded.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(
    page.getByText('已上传 1 个素材', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('共 4 个素材', { exact: true })).toBeVisible();
  await page.getByLabel('选择 Uploaded.png', { exact: true }).check();
  await page.getByRole('button', { name: '删除已选（1）' }).click();
  const confirmation = page.getByRole('dialog', { name: '删除 1 个素材？' });
  await expect(
    confirmation.getByRole('button', { name: '取消' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  expect(writes.filter((write) => write.startsWith('DELETE'))).toHaveLength(0);
  await page.getByRole('button', { name: '删除已选（1）' }).click();
  await confirmation.getByRole('button', { name: '确认删除素材' }).click();
  await expect(
    page.getByText('已删除 1 个素材', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '预览 Uploaded.png' }),
  ).toHaveCount(0);
  expect(writes).toEqual([
    'POST /api/v1/assets/uploads',
    'DELETE /api/v1/assets',
  ]);
  await page.getByRole('button', { name: '视频', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '没有符合条件的素材' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('failed limits can be retried and invalid local uploads do not write requests', async ({
  page,
}) => {
  const { writes, recoverLimits } = await fixture(page, true);
  await page.goto('/assets');
  await expect(page.getByRole('alert')).toContainText('素材服务暂不可用');
  await expect(
    page.getByRole('button', { name: '上传素材', exact: true }),
  ).toBeDisabled();
  recoverLimits();
  await page.getByRole('button', { name: '重试读取' }).click();
  await expect(
    page.getByRole('button', { name: '上传素材', exact: true }),
  ).toBeEnabled();
  await page.getByLabel('选择上传素材', { exact: true }).setInputFiles({
    name: 'not-supported.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg/>'),
  });
  await expect(page.getByRole('alert')).toContainText('暂不支持上传');
  expect(writes).toEqual([]);
});

test('mobile library keeps filters, preview and delete confirmation reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await fixture(page);
  await page.goto('/assets');
  await page.getByRole('button', { name: '预览 Reference.png' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '删除 Reference.png' }).click();
  await expect(
    page.getByRole('button', { name: '确认删除素材' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '视频', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '没有符合条件的素材' }),
  ).toBeVisible();
  expect(
    await page
      .locator('.app-content')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});
