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
  await page.getByRole('button', { name: '保存显示名' }).click();
  await expect(page.getByText('显示名已更新')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('显示名')).toHaveValue('Live account');
  await page.getByRole('link', { name: '积分与订阅', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的积分' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '注册赠送' })).toBeVisible();
  const initial = await (await page.request.get('/api/v1/wallet')).json();
  expect(initial.balance).toBe(20);
  await page.getByRole('button', { name: '领取今日积分' }).click();
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
  await page.getByRole('link', { name: '账号设置', exact: true }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '退出所有设备' }).click();
  await expect(page).toHaveURL(/\/login$/);
  const revoked = await page.request.get('/api/v1/me', {
    headers: { cookie: `__Host-sid=${cookie?.value}` },
  });
  expect(revoked.status()).toBe(401);
});
test('bootstrap administrator binds real encrypted TOTP and cannot replay the accepted code', async ({
  page,
}) => {
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
  expect((await page.request.get('/api/v1/admin/users')).status()).toBe(404);
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
  await page.getByRole('button', { name: '测试连接 Live upstream' }).click();
  await expect(page.getByRole('status')).toContainText('连接正常');
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
  await page.getByRole('button', { name: '绑定账号 Live Image' }).click();
  await dialog.getByLabel('动态分组').fill('default');
  await dialog.getByRole('button', { name: '保存绑定' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('tab', { name: '积分定价' }).click();
  for (const quality of ['low', 'medium', 'high'])
    await page.getByLabel(`Live Image ${quality} 基础积分`).fill('10');
  await page.getByRole('button', { name: '保存全部价格' }).click();
  await expect(page.getByRole('status')).toContainText('价格已保存');
  await page.getByRole('tab', { name: '模型目录' }).click();
  await page
    .getByRole('button', { name: '启用 Live Image', exact: true })
    .click();
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
  await expect(page.locator('.gen-status')).toHaveText('生成完成', {
    timeout: 30000,
  });
  await expect(page.locator('.gen-settlement')).toContainText('已结算 4');
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
});
