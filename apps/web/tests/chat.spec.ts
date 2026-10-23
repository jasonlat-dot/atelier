import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { components } from '../src/lib/generated/api';
type Turn = components['schemas']['ChatTurn'];
const cid = '40000000-0000-4000-8000-000000000001';
async function fixture(
  page: Page,
  mode: 'normal' | 'ambiguous' | 'slow' | 'empty' = 'normal',
) {
  let balance = 20,
    title = '创作讨论',
    created = false,
    deleted = false,
    failedOnce = false;
  const turns: Turn[] = [];
  const writes: { path: string; key?: string; body: unknown }[] = [];
  const requests = new Map<string, Turn>();
  const info = () => ({
    id: cid,
    title,
    created_at: '2026-10-23T00:00:00Z',
    updated_at: '2026-10-23T00:00:00Z',
  });
  const graph = {
    version: 1,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    background: 'dots',
  };
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    if (method !== 'GET') {
      expect(req.headers()['x-csrf-token']).toBe('csrf');
      writes.push({
        path,
        key: req.headers()['idempotency-key'],
        body: req.postData(),
      });
    }
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          user: {
            id: 'chat-user',
            email: 'chat@gmail.com',
            display_name: 'Chat',
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
          balance,
          available: balance,
          held: 0,
          checked_in_today: false,
          streak: 0,
          next_reward: 10,
        },
      });
    if (path === '/api/v1/chat/config')
      return route.fulfill({
        json: {
          models:
            mode === 'empty'
              ? []
              : [{ id: 'chat', display_name: 'Atelier Chat' }],
          credits_per_message: 1,
          context_window: 8192,
          output_tokens: 2048,
        },
      });
    if (path === '/api/v1/chat/conversations' && method === 'GET')
      return route.fulfill({
        json: { items: created && !deleted ? [info()] : [], next_cursor: null },
      });
    if (path === '/api/v1/chat/conversations' && method === 'POST') {
      created = true;
      title = req.postDataJSON().title;
      return route.fulfill({ status: 201, json: info() });
    }
    if (path === `/api/v1/chat/conversations/${cid}`) {
      if (method === 'PATCH') title = req.postDataJSON().title;
      if (method === 'DELETE') {
        deleted = true;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({
        json: {
          conversation: info(),
          turns,
          next_cursor: null,
          summary: '',
          context_window: 8192,
          estimated_tokens: turns.length * 50,
        },
      });
    }
    if (path === `/api/v1/chat/conversations/${cid}/messages`) {
      const body = req.postDataJSON(),
        key = req.headers()['idempotency-key'];
      expect(key).toMatch(/^[a-f0-9-]{36}$/);
      if (mode === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return route
          .fulfill({
            status: 503,
            json: { error: { code: 'CHAT_MODEL_UNAVAILABLE' } },
          })
          .catch(() => {});
      }
      let turn = requests.get(key);
      if (!turn) {
        balance--;
        turn = {
          id: crypto.randomUUID(),
          conversation_id: cid,
          model_id: 'chat',
          content: body.content,
          reply:
            '## 海岸方案\n\n柔和的光线与安静的海浪。\n\n```js\nconst mood = "calm";\n```\n\n<img src=x onerror="window.chatXss=1"><script>window.chatXss=1</script>\n\n[unsafe](javascript:alert(1))',
          status: 'SUCCEEDED',
          cost: 1,
          charged: 1,
          intent: 'IMAGE_GENERATE',
          action: {
            type: 'open_canvas',
            draft: {
              prompt: body.content,
              quality: 'low',
              ratio: '1:1',
              resolution: '1K',
              n: 1,
            },
          },
          error_code: null,
          estimated_tokens: 88,
          created_at: '2026-10-23T00:00:00Z',
        };
        requests.set(key, turn);
        turns.push(turn);
      }
      const frame = (event: string, data: unknown) =>
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const prefix =
        frame('intent', turn.intent) +
        frame('delta', { turn_id: turn.id, text: turn.reply });
      if (mode === 'ambiguous' && !failedOnce) {
        failedOnce = true;
        return route.fulfill({
          contentType: 'text/event-stream',
          body: prefix,
        });
      }
      return route.fulfill({
        contentType: 'text/event-stream',
        body: prefix + frame('action', turn.action) + frame('done', turn),
      });
    }
    if (path === '/api/v1/projects' && method === 'POST')
      return route.fulfill({
        status: 201,
        json: {
          project: { ...info(), name: '草稿画布', revision: 0 },
          graph: req.postDataJSON().graph,
          assets: [],
        },
      });
    if (path === '/api/v1/projects')
      return route.fulfill({ json: { items: [], next_cursor: null } });
    if (path === `/api/v1/projects/${cid}`)
      return route.fulfill({
        json: {
          project: { ...info(), name: '草稿画布', revision: 0 },
          graph,
          assets: [],
        },
      });
    if (path === '/api/v1/models')
      return route.fulfill({ json: { models: [], multipliers: [] } });
    if (path === '/api/v1/generation/limits')
      return route.fulfill({
        json: {
          tier: 'free',
          max_resolution: '2K',
          max_active_jobs: 1,
          video_enabled: true,
        },
      });
    if (path === '/api/v1/generation/jobs')
      return route.fulfill({ json: { items: [], next_cursor: null } });
    if (path === '/api/v1/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: ': noop\n\n',
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });
  return { writes, balance: () => balance, turns: () => turns };
}
test('chat streams, persists, sanitizes Markdown and prepares a canvas draft without generating', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const state = await fixture(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/chat');
  await page.getByLabel('对话内容').fill('生成一张安静海岸的图片');
  await page.getByRole('button', { name: '发送', exact: true }).dblclick();
  await expect(
    page.getByText('回复已保存，本次 1 积分。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '海岸方案' })).toBeVisible();
  expect(state.writes.filter((w) => w.path.endsWith('/messages'))).toHaveLength(
    1,
  );
  await expect(
    page.locator('.chat-markdown script,.chat-markdown img'),
  ).toHaveCount(0);
  expect(await page.evaluate(() => 'chatXss' in window)).toBe(false);
  expect(
    await page
      .locator('.chat-markdown a')
      .evaluateAll((links) =>
        links.every((a) => !a.getAttribute('href')?.startsWith('javascript:')),
      ),
  ).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '海岸方案' })).toBeVisible();
  await expect(
    page.getByText('1 积分', { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: fileURLToPath(
      new URL('../../../.tools/m7-chat-desktop.png', import.meta.url),
    ),
    fullPage: true,
  });
  const balance = state.balance();
  await page.getByRole('link', { name: '在画布中生成', exact: true }).click();
  await expect(page.getByLabel('创意描述')).toHaveValue(
    '生成一张安静海岸的图片',
  );
  expect(state.writes.some((w) => w.path === '/api/v1/generation/jobs')).toBe(
    false,
  );
  expect(state.balance()).toBe(balance);
  expect(errors).toEqual([]);
});
test('an ambiguous SSE submission freezes the draft and reuses one request key', async ({
  page,
}) => {
  const state = await fixture(page, 'ambiguous');
  await page.goto('/chat');
  await page.getByLabel('对话内容').fill('生成一张海报');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '核对上次回复' }),
  ).toBeVisible();
  await expect(page.getByLabel('对话内容')).toBeDisabled();
  await page.getByRole('button', { name: '核对上次回复' }).click();
  await expect(
    page.getByText('回复已保存，本次 1 积分。', { exact: true }),
  ).toBeVisible();
  const posts = state.writes.filter((w) => w.path.endsWith('/messages'));
  expect(posts).toHaveLength(2);
  expect(posts[0].key).toBe(posts[1].key);
  expect(posts[0].body).toBe(posts[1].body);
  expect(state.balance()).toBe(19);
});
test('stopping a reply restores the composer and does not charge', async ({
  page,
}) => {
  const state = await fixture(page, 'slow');
  await page.goto('/chat');
  await page.getByLabel('对话内容').fill('讨论构图');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回复', exact: true }).click();
  await expect(
    page.getByText('回复已停止，未完成部分不会扣积分。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('对话内容')).toBeEnabled();
  expect(state.balance()).toBe(20);
});
test('chat renames and deletes with accessible dialogs and no browser confirmations', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/chat');
  await page.getByLabel('对话内容').fill('生成一张海报');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(
    page.getByText('回复已保存，本次 1 积分。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '重命名对话', exact: true }).click();
  await page.getByLabel('对话名称').fill('海岸视觉讨论');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.chat-header strong')).toHaveText('海岸视觉讨论');
  await page.getByRole('button', { name: '删除当前对话' }).click();
  await expect(
    page.getByRole('dialog', { name: '删除这段对话？' }),
  ).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '删除对话', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '从一个想法，聊到下一件作品' }),
  ).toBeVisible();
});
test('no configured chat model gives an honest empty state and mobile controls fit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, 'empty');
  await page.goto('/chat');
  await expect(
    page.getByRole('button', { name: '发送', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('还没有可用对话模型', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: '智能上下文', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: '智能上下文' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭智能上下文' }).click();
  await page.getByRole('button', { name: '展开对话列表' }).click();
  await expect(
    page.getByRole('complementary', { name: '历史对话' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(state.writes).toHaveLength(0);
});
