import { test, expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
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
    const callback = new URL(
      'http://127.0.0.1:8080/api/v1/auth/google/callback',
    );
    callback.searchParams.set('state', query.get('state') || '');
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
test('real database and Redis login reaches settings, survives reload and revokes the old cookie', async ({
  page,
  context,
}) => {
  await google(page, 'user');
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
  await page.getByRole('link', { name: '积分账本', exact: true }).click();
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
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '绑定验证器' }).click();
  const secret = await page.getByLabel('验证器密钥').inputValue();
  const code = otp(secret);
  await page.getByLabel('六位验证码').fill(code);
  await page.getByRole('button', { name: '验证并继续' }).click();
  await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();
  me = await (await page.request.get('/api/v1/me')).json();
  expect(me.mfa_required).toBe(false);
  expect((await page.request.get('/api/v1/admin/users')).status()).toBe(404);
  const replay = await page.request.post('/api/v1/admin/mfa/verify', {
    headers: { origin: 'http://127.0.0.1:8080', 'X-CSRF-Token': me.csrf_token },
    data: { code },
  });
  expect(replay.status()).toBe(401);
  expect((await replay.json()).error.code).toBe('MFA_INVALID');
});
