import { dismissFeedback } from './feedbackTestHelpers';
import { test, expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
async function google(page: Page, kind: 'user' | 'admin') {
  await page.route('**/api/v1/auth/google/start*', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const authorization = new URL(response.headers().location);
    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.pathname).toBe('/o/oauth2/v2/auth');
    const query = authorization.searchParams;
    expect(query.get('client_id')).toBe('browser-test');
    expect(query.get('code_challenge_method')).toBe('S256');
    const code = [kind, query.get('nonce'), query.get('code_challenge')].join(
      '~',
    );
    const callback = new URL('/api/v1/auth/google/callback', page.url());
    callback.searchParams.set('state', query.get('state') || '');
    callback.searchParams.set('iss', 'https://accounts.google.com');
    callback.searchParams.set('code', code);
    // Playwright routes only the first request in a redirect chain. Preserve
    // the real backend cookie and assert its Google URL before emulating IdP.
    await route.fulfill({
      response,
      headers: { ...response.headers(), location: callback.toString() },
    });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: '使用 Google 登录' }).click();
}
function otp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, '0');
}
test('real database and Redis login reaches workspace, survives reload and revokes the old cookie', async ({
  page,
  context,
}) => {
  await google(page, 'user');
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link', { name: '账号设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-sid');
  expect(cookie?.secure).toBe(true);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  const me = await (await page.request.get('/api/v1/me')).json();
  expect(me.user.role).toBe('USER');
  expect(JSON.stringify(me)).not.toMatch(/token_hash|mfa_secret|id_token/);
  await page.getByLabel('显示名').fill('Live account');
  await page.getByRole('button', { name: '保存资料' }).click();
  await expect(page.getByText('显示名已更新')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('显示名')).toHaveValue('Live account');
  await page.getByRole('link', { name: '积分与订阅', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的积分' })).toBeVisible();
  await expect(page.getByRole('button', { name: /注册赠送/ })).toBeVisible();
  const initial = await (await page.request.get('/api/v1/wallet')).json();
  expect(initial.balance).toBe(20);
  await page.getByRole('button', { name: '领取今日积分' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('签到成功');
  await dismissFeedback(page);
  await expect(page.getByRole('button', { name: '今日已签到' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: '今日已签到' })).toBeDisabled();
  const wallet = await (await page.request.get('/api/v1/wallet')).json();
  expect(wallet.balance).toBe(30);
  await page.getByRole('link', { name: '我的素材库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的素材库' })).toBeVisible();
  const image = readFileSync(
    new URL(
      '../../../services/api/crates/app/tests/fixtures/reference.png',
      import.meta.url,
    ),
  );
  await page.getByLabel('选择上传素材', { exact: true }).setInputFiles({
    name: 'Live reference.png',
    mimeType: 'image/png',
    buffer: image,
  });
  await expect(
    page.getByText('已上传 1 个素材', { exact: true }),
  ).toBeVisible();
  await dismissFeedback(page);
  await page.reload();
  await page.getByRole('button', { name: '预览 Live reference.png' }).click();
  const preview = page.getByRole('dialog', { name: 'Live reference.png' });
  await expect
    .poll(() =>
      preview
        .getByRole('img', { name: 'Live reference.png' })
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(16);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '删除 Live reference.png' }).click();
  await page.getByRole('button', { name: '确认删除素材' }).click();
  await expect(
    page.getByText('已删除 1 个素材', { exact: true }),
  ).toBeVisible();
  await dismissFeedback(page);
  await expect(page.getByLabel('选择上传素材', { exact: true })).toBeEnabled();
  const video = readFileSync(
    new URL(
      '../../../services/api/crates/app/tests/fixtures/reference.mp4',
      import.meta.url,
    ),
  );
  await page.getByLabel('选择上传素材', { exact: true }).setInputFiles({
    name: 'Live film.mp4',
    mimeType: 'video/mp4',
    buffer: video,
  });
  await expect(page.getByRole('alertdialog')).toContainText('已上传 1 个素材');
  await dismissFeedback(page);
  const film = page.getByRole('button', { name: '预览 Live film.mp4' });
  await expect(film).toBeEnabled({ timeout: 20000 });
  await page.reload();
  await film.click();
  const player = page
    .getByRole('dialog', { name: 'Live film.mp4' })
    .locator('video');
  await expect
    .poll(() => player.evaluate((element) => element.readyState), {
      timeout: 15000,
    })
    .toBeGreaterThanOrEqual(2);
  expect(await player.evaluate((element) => element.duration)).toBeGreaterThan(
    1,
  );
  await player.evaluate((element) => {
    element.currentTime = 1;
  });
  await expect
    .poll(() => player.evaluate((element) => element.currentTime))
    .toBeGreaterThanOrEqual(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '删除 Live film.mp4' }).click();
  await page.getByRole('button', { name: '确认删除素材' }).click();
  await expect(film).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toContainText('已删除 1 个素材');
  await dismissFeedback(page);
  await page.getByRole('link', { name: '账号设置', exact: true }).click();
  await page.getByRole('button', { name: '退出所有设备' }).click();
  await page
    .getByRole('dialog', { name: '退出所有设备？' })
    .getByRole('button', { name: '退出所有设备并返回登录' })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  const revoked = await page.request.get('/api/v1/me', {
    headers: { cookie: `__Host-sid=${cookie?.value}` },
  });
  expect(revoked.status()).toBe(401);
});
test('bootstrap administrator binds real encrypted TOTP and cannot replay the accepted code', async ({
  page,
}) => {
  test.setTimeout(120000);
  await google(page, 'admin');
  await expect(
    page.getByRole('heading', { name: '管理员身份验证' }),
  ).toBeVisible();
  let me = await (await page.request.get('/api/v1/me')).json();
  expect(me.user.role).toBe('SUPER_ADMIN');
  expect((await page.request.get('/api/v1/admin/users')).status()).toBe(403);
  await page.getByRole('button', { name: '绑定验证器' }).click();
  await expect(
    page.getByRole('img', { name: 'Atelier 验证器绑定二维码' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '无法扫码？使用密钥' }).click();
  const secret = await page.getByLabel('验证器密钥').inputValue();
  const code = otp(secret);
  await page.getByLabel('六位验证码').fill(code);
  await page.getByRole('button', { name: '验证并继续' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link', { name: '账号设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();
  me = await (await page.request.get('/api/v1/me')).json();
  expect(me.mfa_required).toBe(false);
  expect((await page.request.get('/api/v1/admin/users')).status()).toBe(200);
  const replay = await page.request.post('/api/v1/admin/mfa/verify', {
    headers: {
      origin: new URL(page.url()).origin,
      'X-CSRF-Token': me.csrf_token,
    },
    data: { code },
  });
  expect(replay.status()).toBe(401);
  expect((await replay.json()).error.code).toBe('MFA_INVALID');
  await page.getByRole('link', { name: '上游账号池', exact: true }).click();
  await page.getByRole('button', { name: '新增账号', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const origin = readFileSync(
    new URL('../test-results/upstream-origin.txt', import.meta.url),
    'utf8',
  );
  await dialog.getByLabel('账号名称').fill('Live upstream');
  await dialog.getByLabel('接口地址').fill(`${origin}/v1`);
  await dialog.getByLabel('API 密钥').fill('synthetic-browser-secret');
  await dialog.getByRole('button', { name: '保存配置' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toContainText('账号配置已保存');
  await dismissFeedback(page);
  await page.getByRole('button', { name: '测试连接 Live upstream' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Live upstream 连接正常' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('cell', { name: /^Live upstream/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: '编辑 Live upstream' }).click();
  await expect(dialog.getByLabel('API 密钥')).toHaveValue('');
  await expect(dialog.getByLabel('接口地址')).toHaveValue('');
  await page.keyboard.press('Escape');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '模型与定价', exact: true })
    .click();
  await page.getByRole('button', { name: '新增模型' }).click();
  await dialog.getByLabel('公开模型标识').fill('live-image');
  await dialog.getByLabel('展示名称').fill('Live Image');
  await dialog.getByLabel('上游模型标识').fill('fixture-private-model');
  await dialog.getByRole('button', { name: '保存模型' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toContainText('模型已创建');
  await dismissFeedback(page);
  await page.getByRole('button', { name: '绑定账号 Live Image' }).click();
  await dialog.getByLabel('动态分组').fill('default');
  await dialog.getByRole('button', { name: '保存绑定' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toContainText('路由绑定已保存');
  await dismissFeedback(page);
  await page
    .getByRole('button', { name: '配置价格 Live Image', exact: true })
    .click();
  for (const quality of ['low', 'medium', 'high'])
    await page.getByLabel(`Live Image ${quality} 基础积分`).fill('10');
  await page.getByRole('button', { name: '保存价格', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('价格已保存');
  await dismissFeedback(page);
  await page
    .getByRole('switch', { name: '启用 Live Image', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('模型已启用');
  await dismissFeedback(page);
  await expect(page.getByText('已启用', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('已启用', { exact: true })).toBeVisible();
  const catalog = await (await page.request.get('/api/v1/models')).json();
  expect(catalog.models.map((m: { id: string }) => m.id)).toEqual([
    'live-image',
  ]);
  expect(JSON.stringify(catalog)).not.toMatch(
    /fixture-private-model|synthetic-browser-secret|base_url|account_ids|group_tags/,
  );
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(20);
  // M5: the browser uses real PostgreSQL/Redis, wallet transactions and durable worker.
  // Only the paid upstream is replaced with an isolated local fixture.
  await page.getByRole('link', { name: '图片与视频生成', exact: true }).click();
  await page.getByLabel('画面描述').fill('Live coastal landscape');
  await page.getByRole('button', { name: '生成图片', exact: true }).click();
  await expect(page.locator('.gen-status')).toHaveText('生成完成', {
    timeout: 20000,
  });
  await expect(page.locator('.gen-settlement')).toContainText('已结算 10');
  await page.getByRole('button', { name: '预览结果 1' }).click();
  await expect
    .poll(() =>
      page
        .getByRole('img', { name: '生成结果大图' })
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBe(16);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.gen-status')).toHaveText('生成完成');
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(10);
  await page.getByRole('link', { name: '我的素材库', exact: true }).click();
  await expect(page.locator('.asset-card')).toHaveCount(1);
  // Create a video model using the same documented management APIs and actual CSRF.
  const headers = {
    origin: new URL(page.url()).origin,
    'X-CSRF-Token': me.csrf_token,
  };
  let video = await page.request.post('/api/v1/admin/models', {
    headers,
    data: {
      id: 'live-video',
      display_name: 'Live Video',
      kind: 'video',
      upstream_model: 'fixture-private-model',
      enabled: false,
      sort_order: 0,
      capabilities: {
        qualities: ['standard'],
        ratios: ['16:9'],
        resolutions: ['720p'],
        max_n: 1,
        max_refs: 1,
        seconds: [4],
      },
    },
  });
  expect(video.status()).toBe(201);
  let videoModel = await video.json();
  video = await page.request.put('/api/v1/admin/models/live-video/accounts', {
    headers,
    data: {
      revision: videoModel.revision,
      account_ids: [],
      group_tags: ['default'],
    },
  });
  expect(video.ok()).toBe(true);
  videoModel = await video.json();
  const pricing = await (
    await page.request.get('/api/v1/admin/pricing')
  ).json();
  pricing.rules.push({
    model_id: 'live-video',
    quality: 'standard',
    base_credits: 1,
    edit_surcharge: 0,
  });
  expect(
    (
      await page.request.put('/api/v1/admin/pricing', {
        headers,
        data: pricing,
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.patch('/api/v1/admin/models', {
        headers,
        data: {
          id: 'live-video',
          display_name: 'Live Video',
          kind: 'video',
          enabled: true,
          sort_order: 0,
          revision: videoModel.revision,
          capabilities: videoModel.capabilities,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('link', { name: '图片与视频生成', exact: true }).click();
  await page.getByRole('button', { name: '视频', exact: true }).click();
  await page.getByLabel('画面描述').fill('Live gentle ocean waves');
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  // The previous image may still say "complete" while the new POST is in flight.
  await expect(page.locator('.gen-settlement')).toContainText('已结算 4', {
    timeout: 30000,
  });
  await expect(page.locator('.gen-status')).toHaveText('生成完成', {
    timeout: 30000,
  });
  await page.getByRole('button', { name: '预览结果 1' }).click();
  const generatedVideo = page.getByRole('dialog').locator('video');
  await expect
    .poll(() => generatedVideo.evaluate((el) => el.readyState), {
      timeout: 15000,
    })
    .toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Escape');
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(6);
  await page.reload();
  await expect(page.locator('.gen-status')).toHaveText('生成完成');
  // M6: one full canvas flow through the actual PG/Redis API and fake paid provider.
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const canvasPricing = await (
    await page.request.get('/api/v1/admin/pricing')
  ).json();
  for (const rule of canvasPricing.rules)
    if (rule.model_id === 'live-image') rule.base_credits = 1;
  expect(
    (
      await page.request.put('/api/v1/admin/pricing', {
        headers,
        data: canvasPricing,
      })
    ).ok(),
  ).toBe(true);
  const managedModels = await (
    await page.request.get('/api/v1/admin/models')
  ).json();
  const imageConfig = managedModels.find(
    (m: { id: string }) => m.id === 'live-image',
  );
  expect(
    (
      await page.request.patch('/api/v1/admin/models', {
        headers,
        data: {
          id: imageConfig.id,
          display_name: imageConfig.display_name,
          kind: imageConfig.kind,
          enabled: true,
          sort_order: 0,
          revision: imageConfig.revision,
          capabilities: {
            ...imageConfig.capabilities,
            supports_edit: true,
            max_refs: 4,
          },
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('link', { name: '无限创作画布', exact: true }).click();
  await page.getByRole('link', { name: '新建画布', exact: true }).click();
  await expect(page).toHaveURL(/\/canvas\/[0-9a-f-]{36}$/);
  const canvasId = new URL(page.url()).pathname.split('/').pop()!;
  await page.getByRole('button', { name: '添加文字节点', exact: true }).click();
  await page.getByRole('button', { name: '编辑文字', exact: true }).click();
  await page.getByLabel('节点文字').fill('A calm canvas ocean');
  await page.getByLabel('画布上传文件').setInputFiles({
    name: 'Canvas reference.png',
    mimeType: 'image/png',
    buffer: readFileSync(
      new URL(
        '../../../services/api/crates/app/tests/fixtures/reference.png',
        import.meta.url,
      ),
    ),
  });
  await expect(
    page.getByText('素材已上传并加入画布。', { exact: true }),
  ).toBeVisible();
  await dismissFeedback(page);
  await page.getByRole('button', { name: '添加生成节点', exact: true }).click();
  const graphState = async () =>
    await (await page.request.get(`/api/v1/projects/${canvasId}`)).json();
  await expect
    .poll(async () => (await graphState()).graph.nodes.length)
    .toBe(3);
  const firstGraph = (await graphState()).graph;
  const textId = firstGraph.nodes.find(
    (n: { type: string }) => n.type === 'text',
  ).id;
  const imageId = firstGraph.nodes.find(
    (n: { type: string }) => n.type === 'image',
  ).id;
  const generatorId = firstGraph.nodes.find(
    (n: { type: string }) => n.type === 'generate',
  ).id;
  const linkNodes = async (source: string, target: string) => {
    const a = page.locator(
        `.react-flow__node[data-id="${source}"] .react-flow__handle.source`,
      ),
      b = page.locator(
        `.react-flow__node[data-id="${target}"] .react-flow__handle.target`,
      );
    await a.dragTo(b);
  };
  // Parameters stay open after selecting a generator; explicitly clear the
  // floating panel before exercising ports underneath it.
  const parameters = page.getByRole('button', { name: '切换创作参数' });
  await expect(parameters).toHaveAttribute('aria-expanded', 'true');
  await parameters.click();
  await expect(parameters).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await linkNodes(textId, generatorId);
  await linkNodes(imageId, generatorId);
  await page
    .locator(`.react-flow__node[data-id="${generatorId}"] .graph-head`)
    .click();
  await page
    .getByRole('button', { name: '生成并连接结果', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await graphState()).graph.edges.filter(
          (e: { role: string }) => e.role === 'result',
        ).length,
      { timeout: 30000 },
    )
    .toBe(1);
  await page.reload();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  expect((await graphState()).graph.nodes.length).toBe(4);
  await page.getByRole('button', { name: '添加文字节点', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: { x: 8, y: 30 } });
  await page.getByRole('button', { name: '切换创作参数' }).click();
  await page.getByRole('button', { name: '视频生成', exact: true }).click();
  await page.getByLabel('创意描述').fill('Canvas video waves');
  await page
    .getByRole('button', { name: '生成并加入画布', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('生成任务已提交');
  await dismissFeedback(page);
  await expect
    .poll(
      async () =>
        (await graphState()).graph.nodes.filter(
          (n: { type: string }) => n.type === 'video',
        ).length,
      { timeout: 30000 },
    )
    .toBe(1);
  await expect(parameters).toHaveAttribute('aria-expanded', 'true');
  await parameters.click();
  await expect(parameters).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  const videoNode = (await graphState()).graph.nodes.find(
    (n: { type: string }) => n.type === 'video',
  );
  await page
    .locator(`.react-flow__node[data-id="${videoNode.id}"] .live-node-media`)
    .click();
  await expect
    .poll(
      () =>
        page
          .getByRole('dialog')
          .locator('video')
          .evaluate((el) => el.readyState),
      { timeout: 15000 },
    )
    .toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Escape');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出项目 ZIP', exact: true }).click();
  const download = await downloaded;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const archive = Buffer.concat(chunks);
  expect(archive.subarray(0, 2).toString()).toBe('PK');
  await expect(page.locator('.app-toast [role="status"]')).toContainText(
    '项目 ZIP 已导出',
  );
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  const beforeBalance = (
    await (await page.request.get('/api/v1/wallet')).json()
  ).balance;
  await page
    .getByRole('link', { name: '无限创作画布', exact: true })
    .first()
    .click();
  await page.getByLabel('导入项目 ZIP', { exact: true }).setInputFiles({
    name: 'canvas.zip',
    mimeType: 'application/zip',
    buffer: archive,
  });
  await expect(page).toHaveURL(/\/canvas\/[0-9a-f-]{36}$/);
  const importedId = new URL(page.url()).pathname.split('/').pop()!;
  expect(importedId).not.toBe(canvasId);
  const imported = await (
    await page.request.get(`/api/v1/projects/${importedId}`)
  ).json();
  expect(imported.graph.nodes.length).toBeGreaterThanOrEqual(6);
  expect(
    imported.graph.nodes
      .filter(
        (n: { type: string; data: { jobId?: string } }) =>
          n.type === 'generate',
      )
      .every((n: { data: { jobId?: string } }) => !n.data.jobId),
  ).toBe(true);
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(beforeBalance);
  // M7: actual SSE transport, durable messages, cancel/failure release, and draft-only actions.
  expect(
    (await page.request.post('/api/v1/wallet/checkin', { headers })).ok(),
  ).toBe(true);
  let chatResponse = await page.request.post('/api/v1/admin/models', {
    headers,
    data: {
      id: 'live-chat',
      display_name: 'Live Chat',
      kind: 'chat',
      upstream_model: 'fixture-private-model',
      enabled: false,
      sort_order: 0,
      capabilities: {
        qualities: ['message'],
        ratios: [],
        resolutions: ['text'],
        max_n: 1,
        max_refs: 0,
      },
    },
  });
  expect(chatResponse.status()).toBe(201);
  let chatModel = await chatResponse.json();
  chatResponse = await page.request.put(
    '/api/v1/admin/models/live-chat/accounts',
    {
      headers,
      data: {
        revision: chatModel.revision,
        account_ids: [],
        group_tags: ['default'],
      },
    },
  );
  expect(chatResponse.ok()).toBe(true);
  chatModel = await chatResponse.json();
  const chatPricing = await (
    await page.request.get('/api/v1/admin/pricing')
  ).json();
  chatPricing.rules.push({
    model_id: 'live-chat',
    quality: 'message',
    base_credits: 1,
    edit_surcharge: 0,
  });
  expect(
    (
      await page.request.put('/api/v1/admin/pricing', {
        headers,
        data: chatPricing,
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.patch('/api/v1/admin/models', {
        headers,
        data: {
          id: 'live-chat',
          display_name: 'Live Chat',
          kind: 'chat',
          enabled: true,
          sort_order: 0,
          revision: chatModel.revision,
          capabilities: chatModel.capabilities,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('link', { name: 'AI 智能对话', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '从一个想法，聊到下一件作品' }),
  ).toBeVisible();
  const chatBalance = (await (await page.request.get('/api/v1/wallet')).json())
    .balance;
  await page.getByLabel('对话内容').fill('生成一张海岸海报');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(
    page.getByText('回复已保存，本次 1 积分。', { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await dismissFeedback(page);
  await expect(
    page.getByRole('heading', { name: '海岸创作建议' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  const conversationId = new URL(page.url()).pathname.split('/').pop()!;
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(chatBalance - 1);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '海岸创作建议' }),
  ).toBeVisible();
  const generationCount = (
    await (await page.request.get('/api/v1/generation/jobs?limit=100')).json()
  ).items.length;
  await page.getByRole('link', { name: '在画布中生成', exact: true }).click();
  await expect(page.locator('.app-toast [role="status"]')).toContainText(
    '已填入对话草稿',
  );
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByLabel('创意描述')).toHaveValue('生成一张海岸海报');
  expect(
    (await (await page.request.get('/api/v1/generation/jobs?limit=100')).json())
      .items.length,
  ).toBe(generationCount);
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(chatBalance - 1);
  await page.getByRole('link', { name: 'AI 智能对话', exact: true }).click();
  await page
    .getByRole('link', { name: '生成一张海岸海报', exact: true })
    .click();
  await page.getByLabel('对话内容').fill('fixture slow 继续讨论海岸视觉');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('heading', { name: '海岸创作建议' })).toHaveCount(
    2,
  );
  await page.getByRole('button', { name: '停止回复', exact: true }).click();
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/v1/chat/conversations/${conversationId}`,
        );
        expect(response.ok()).toBe(true);
        const view = await response.json();
        return view.turns.at(-1).status;
      },
      { timeout: 10000 },
    )
    .toBe('CANCELLED');
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(chatBalance - 1);
  await expect(page.getByLabel('对话内容')).toBeEnabled();
  await expect(page.getByRole('alertdialog')).toContainText('已停止');
  await dismissFeedback(page);
  await page.getByLabel('对话内容').fill('fixture fail');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    '回复未完成，未扣积分，请稍后重试。',
    { timeout: 15000 },
  );
  await dismissFeedback(page);
  const chatWallet = await (await page.request.get('/api/v1/wallet')).json();
  expect(chatWallet.balance).toBe(chatBalance - 1);
  expect(chatWallet.held).toBe(0);
  await page.getByLabel('对话内容').fill('fixture truncated');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(
      async () => {
        const view = await (
          await page.request.get(`/api/v1/chat/conversations/${conversationId}`)
        ).json();
        return view.turns.filter(
          (t: { status: string }) => t.status === 'FAILED',
        ).length;
      },
      { timeout: 15000 },
    )
    .toBe(2);
  await expect(page.getByRole('alertdialog')).toContainText('回复未完成');
  await dismissFeedback(page);
  const interruptedWallet = await (
    await page.request.get('/api/v1/wallet')
  ).json();
  expect(interruptedWallet.balance).toBe(chatBalance - 1);
  expect(interruptedWallet.held).toBe(0);
  // M8 uses this real MFA session and isolated database for the manual payment flow.
  const beforePurchase = interruptedWallet.balance;
  await page.getByRole('link', { name: '套餐与订单', exact: true }).click();
  await page.getByRole('button', { name: '新增套餐', exact: true }).click();
  await page.getByLabel('套餐名称', { exact: true }).fill('Live Studio');
  await page.getByRole('radio', { name: '订阅套餐', exact: true }).check();
  await page.getByLabel('价格（元）', { exact: true }).fill('19.00');
  await page.getByLabel('发放积分', { exact: true }).fill('100');
  await page
    .getByRole('switch', { name: '上架，允许用户创建新订单', exact: true })
    .click();
  await page.getByRole('button', { name: '保存套餐', exact: true }).click();
  await expect(page.getByText('套餐已保存', { exact: true })).toBeVisible();
  await dismissFeedback(page);
  await page.getByRole('link', { name: '积分与订阅', exact: true }).click();
  await page.getByRole('button', { name: '套餐与订阅', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Live Studio', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('m8-plans.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '选择套餐', exact: true }).click();
  const checkoutResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/v1/orders') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '确认创建订单', exact: true }).click();
  const checkout = await (await checkoutResponse).json();
  const billingOrder = checkout.order.id;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toContainText('订单已创建');
  await dismissFeedback(page);
  await page.getByRole('button', { name: '我的订单', exact: true }).click();
  await expect(page.getByText('待付款', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '套餐与订单', exact: true }).click();
  await page.getByRole('tab', { name: '订单管理', exact: true }).click();
  await page.getByRole('button', { name: '确认到账', exact: true }).click();
  await page
    .getByLabel('收款凭证号', { exact: true })
    .fill('live-manual-receipt');
  await page
    .getByLabel('处理说明', { exact: true })
    .fill('隔离验收，模拟已核对线下到账');
  await page.getByRole('checkbox').check();
  await page
    .getByRole('button', { name: '确认到账并发放权益', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('到账已确认');
  await dismissFeedback(page);
  await expect(page.getByText('已发放', { exact: true })).toBeVisible();
  const paidWallet = await (await page.request.get('/api/v1/wallet')).json();
  expect(paidWallet.balance).toBe(beforePurchase + 100);
  const paidLimits = await (
    await page.request.get('/api/v1/generation/limits')
  ).json();
  expect(paidLimits.max_resolution).toBe('4K');
  expect(paidLimits.max_active_jobs).toBe(3);
  expect(
    (
      await page.request.post(
        `/api/v1/admin/orders/${billingOrder}/mark-paid`,
        {
          headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
          data: {
            amount_cents: 1900,
            currency: 'CNY',
            trade_no: 'live-manual-receipt',
            reason: '重复确认验收',
          },
        },
      )
    ).ok(),
  ).toBe(true);
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(paidWallet.balance);
  await page.getByRole('link', { name: '积分与订阅', exact: true }).click();
  await page.getByRole('button', { name: '套餐与订阅', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '当前订阅权益' }),
  ).toContainText('Live Studio');
  await page.screenshot({
    path: test.info().outputPath('m8-active-subscription.png'),
    fullPage: true,
  });
  await page.getByRole('link', { name: '套餐与订单', exact: true }).click();
  await page.getByRole('tab', { name: '订单管理', exact: true }).click();
  await page.getByRole('button', { name: '办理退款', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('19.00');
  await page
    .getByLabel('处理说明', { exact: true })
    .fill('隔离验收，模拟已完成线下全额退款');
  await page.getByRole('checkbox').check();
  await page
    .getByRole('button', { name: '登记退款并回收权益', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('退款已登记');
  await dismissFeedback(page);
  await expect(
    page.getByRole('table').getByText('已退款', { exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(beforePurchase);
  expect(
    (await (await page.request.get('/api/v1/subscription')).json()).tier,
  ).toBe('FREE');

  // M9: real management writes, wallet effects, revision and audit in the same
  // isolated PG/Redis application. No financial supplier is contacted.
  const people = await (await page.request.get('/api/v1/admin/users')).json();
  const managed = people.items.find((u: { role: string }) => u.role === 'USER');
  expect(managed).toBeTruthy();
  await page.getByRole('link', { name: '用户管理', exact: true }).click();
  await page.getByLabel('搜索用户').fill(managed.email);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: '查看用户', exact: true }).click();
  await page.getByRole('button', { name: '调整积分', exact: true }).click();
  let manageDialog = page.getByRole('dialog', {
    name: '调整积分',
    exact: true,
  });
  await manageDialog.getByLabel('调整积分', { exact: false }).fill('7');
  await manageDialog.getByRole('combobox', { name: '调整原因' }).click();
  await page.getByRole('option', { name: '运营奖励', exact: true }).click();
  await manageDialog.getByLabel('补充说明').fill('真实管理回归增加七积分');
  await manageDialog
    .getByRole('button', { name: '核对调整', exact: true })
    .click();
  await manageDialog
    .getByRole('button', { name: '确认调整积分', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('调整积分已完成');
  await dismissFeedback(page);
  await expect(manageDialog).toHaveCount(0);
  const adjusted = await (
    await page.request.get(`/api/v1/admin/users/${managed.id}`)
  ).json();
  expect(adjusted.user.balance).toBe(managed.balance + 7);
  await page.getByRole('button', { name: '禁用账号', exact: true }).click();
  manageDialog = page.getByRole('dialog', { name: '禁用账号', exact: true });
  await manageDialog.getByLabel('处理说明').fill('真实管理回归禁用');
  await manageDialog
    .getByRole('button', { name: '确认禁用账号', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('禁用账号已完成');
  await dismissFeedback(page);
  await expect(
    page.getByRole('button', { name: '恢复账号', exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`/api/v1/admin/users/${managed.id}`)).json())
      .user.status,
  ).toBe('DISABLED');
  await page.getByRole('button', { name: '恢复账号', exact: true }).click();
  manageDialog = page.getByRole('dialog', { name: '恢复账号', exact: true });
  await manageDialog.getByLabel('处理说明').fill('真实管理回归恢复');
  await manageDialog
    .getByRole('button', { name: '确认恢复账号', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('恢复账号已完成');
  await dismissFeedback(page);
  await expect(
    page.getByRole('button', { name: '禁用账号', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('link', { name: '平台设置', exact: true }).click();
  await page.getByRole('radio', { name: '仅限邀请', exact: false }).check();
  await page.getByRole('button', { name: '核对并保存', exact: true }).click();
  manageDialog = page.getByRole('dialog', { name: '确认变更平台设置' });
  await manageDialog.getByLabel('变更说明').fill('真实管理回归邀请模式');
  await manageDialog.getByRole('button', { name: '确认保存设置' }).click();
  await expect(manageDialog).toHaveCount(0);
  expect(
    (await (await page.request.get('/api/v1/admin/settings')).json()).values
      .registration_mode,
  ).toBe('INVITE_ONLY');
  await page.getByRole('link', { name: '内容与邀请', exact: true }).click();
  await page.getByRole('button', { name: '新增规则', exact: true }).click();
  manageDialog = page.getByRole('dialog');
  await manageDialog.getByLabel('匹配内容').fill('m9-browser-blocked');
  await manageDialog.getByLabel('处理说明').fill('真实管理回归内容规则');
  await manageDialog
    .getByRole('button', { name: '保存规则', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('规则已保存');
  await dismissFeedback(page);
  await expect(
    page.getByText('m9-browser-blocked', { exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: '邀请码', exact: true }).click();
  await page.getByRole('button', { name: '创建邀请码', exact: true }).click();
  manageDialog = page.getByRole('dialog');
  await manageDialog.getByLabel('邀请备注').fill('M9 browser invite');
  await manageDialog.getByLabel('处理说明').fill('真实管理回归邀请');
  await manageDialog.getByRole('button', { name: '确认创建邀请' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('邀请码记录已更新');
  await dismissFeedback(page);
  await expect(page.getByLabel('完整邀请码', { exact: true })).toHaveValue(
    /^ati_/,
  );
  await page.getByRole('button', { name: '已保存，关闭' }).click();
  await page.getByRole('button', { name: '撤销邀请', exact: true }).click();
  manageDialog = page.getByRole('dialog');
  await manageDialog.getByLabel('处理说明').fill('真实管理回归撤销邀请');
  await manageDialog.getByRole('button', { name: '确认撤销邀请' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('邀请码记录已更新');
  await dismissFeedback(page);
  await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
  const adminJobs = await (await page.request.get('/api/v1/admin/jobs')).json();
  const compensate = adminJobs.items.find(
    (j: { settled: number; refunded: number; status: string }) =>
      j.settled > 0 &&
      j.refunded === 0 &&
      ['SUCCEEDED', 'PARTIAL'].includes(j.status),
  );
  expect(compensate).toBeTruthy();
  const beforeCompensation = await (
    await page.request.get('/api/v1/wallet')
  ).json();
  await page.getByRole('link', { name: '任务管理', exact: true }).click();
  const taskRow = page.getByRole('row').filter({ hasText: compensate.id });
  await taskRow.getByRole('button', { name: '补偿积分', exact: true }).click();
  manageDialog = page.getByRole('dialog', { name: '确认补偿积分' });
  await manageDialog.getByLabel('处理说明').fill('真实管理回归补偿已结算任务');
  await manageDialog
    .getByRole('button', { name: '确认补偿积分', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText('积分补偿已入账');
  await dismissFeedback(page);
  await expect(manageDialog).toHaveCount(0);
  await expect(
    taskRow.getByRole('button', { name: '补偿积分', exact: true }),
  ).toBeDisabled();
  expect(
    (await (await page.request.get('/api/v1/wallet')).json()).balance,
  ).toBe(beforeCompensation.balance + compensate.settled);
  await page.getByRole('link', { name: '审计日志', exact: true }).click();
  await page.getByLabel('搜索审计日志').fill('ADMIN_USER_DISABLE');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page
    .getByRole('button', { name: '查看变更', exact: true })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toContainText('真实管理回归禁用');
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('link', { name: '运营总览', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '运营总览', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('平台注册用户', { exact: true })).toBeVisible();
  await expect(page.getByText('账号池健康', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('m9-real-dashboard.png'),
    fullPage: true,
  });
});
