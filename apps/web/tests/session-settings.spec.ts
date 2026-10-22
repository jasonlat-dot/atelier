import { test, expect } from '@playwright/test';

const csrf = 'server-session-bound-csrf-token';
const id = '1f8848d3-1bd4-4eb3-8c91-a653c27a11a0';
const user = {
  id,
  email: 'account@gmail.com',
  display_name: 'Account',
  role: 'USER',
  mfa_enabled: false,
};
const me = { user, csrf_token: csrf, mfa_required: false };

test('settings uses server session, sends CSRF, confirms revocation and clears logout state', async ({
  page,
}) => {
  const mutations: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      mutations.push(request.method() + ' ' + path);
    }
    if (path === '/api/v1/public/config') {
      await route.fulfill({
        json: { registration_mode: 'CLOSED', version: 'test' },
      });
    } else if (path === '/api/v1/me') {
      if (request.method() === 'PATCH') {
        expect(request.postDataJSON()).toEqual({ display_name: 'Renamed' });
        await route.fulfill({
          json: { ...me, user: { ...user, display_name: 'Renamed' } },
        });
      } else await route.fulfill({ json: me });
    } else if (path === '/api/v1/me/sessions') {
      await route.fulfill({
        json: {
          sessions: [
            {
              id,
              current: true,
              user_agent: 'Current browser',
              ip: '127.0.0.1',
              created_at: '2026-10-22T00:00:00Z',
              last_seen_at: '2026-10-22T00:00:00Z',
            },
            {
              id: 'other-device',
              current: false,
              user_agent: 'Other browser',
              ip: null,
              created_at: '2026-10-22T00:00:00Z',
              last_seen_at: '2026-10-22T00:00:00Z',
            },
          ],
        },
      });
    } else await route.fulfill({ status: 204 });
  });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();
  await page.getByLabel('显示名').fill('Renamed');
  await page.getByRole('button', { name: '保存显示名' }).click();
  await expect(page.getByText('显示名已更新')).toBeVisible();
  await expect(
    page.getByText('Current browser', { exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '撤销设备 Other browser' }).click();
  expect(mutations).not.toContain('DELETE /api/v1/me/sessions/other-device');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '撤销设备 Other browser' }).click();
  await expect
    .poll(() => mutations.includes('DELETE /api/v1/me/sessions/other-device'))
    .toBe(true);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '退出所有设备' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole('button', { name: '使用 Google 登录' }),
  ).toBeEnabled();
});

test('unauthenticated guards redirect and temporary failures do not impersonate logged out', async ({
  page,
}) => {
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      },
    }),
  );
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: '账号设置' })).toHaveCount(0);
  await page.unroute('**/api/v1/me');
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service temporarily unavailable',
        },
      },
    }),
  );
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: '重试连接' })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
});

test('normal users cannot enter admin and admins without MFA only see enrollment status', async ({
  page,
}) => {
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: me }));
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
  await page.unroute('**/api/v1/me');
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      json: { ...me, user: { ...user, role: 'ADMIN' }, mfa_required: true },
    }),
  );
  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { name: '管理员身份验证' }),
  ).toBeVisible();
  await expect(page.getByLabel('显示名')).toHaveCount(0);
});

test('login reads current registration mode and sends invitation only to the backend start route', async ({
  page,
}) => {
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'UNAUTHENTICATED' } },
    }),
  );
  await page.route('**/api/v1/public/config', (route) =>
    route.fulfill({
      json: { registration_mode: 'INVITE_ONLY', version: 'test' },
    }),
  );
  await page.route('**/api/v1/auth/google/start*', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('invite')).toBe('invite-for-test');
    expect(url.searchParams.has('id_token')).toBe(false);
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<p>后端登录入口已收到请求</p>',
    });
  });
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByText('新账号需要邀请码或已加入白名单，已有账号可直接登录。'),
  ).toBeVisible();
  await page.getByLabel('邀请码（可选）').fill('invite-for-test');
  await page.getByRole('button', { name: '使用 Google 登录' }).click();
  await expect(page.getByText('后端登录入口已收到请求')).toBeVisible();
});

test('administrator enrolls MFA through CSRF protected endpoints and returns to settings', async ({
  page,
}) => {
  let verified = false;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          ...me,
          user: { ...user, role: 'ADMIN', mfa_enabled: verified },
          mfa_required: !verified,
        },
      });
    if (path === '/api/v1/admin/mfa/setup') {
      expect(req.method()).toBe('POST');
      expect(req.headers()['x-csrf-token']).toBe(csrf);
      return route.fulfill({
        json: {
          otpauth_uri:
            'otpauth://totp/Atelier:admin?secret=TESTSECRET&issuer=Atelier',
        },
      });
    }
    if (path === '/api/v1/admin/mfa/verify') {
      expect(req.postDataJSON()).toEqual({ code: '123456' });
      expect(req.headers()['x-csrf-token']).toBe(csrf);
      verified = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { sessions: [] } });
  });
  await page.goto('/settings');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '绑定验证器' }).click();
  await expect(page.getByLabel('验证器密钥')).toHaveValue('TESTSECRET');
  await page.getByLabel('六位验证码').fill('123456');
  await page.getByRole('button', { name: '验证并继续' }).click();
  await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();
});
