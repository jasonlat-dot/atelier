import { test, expect } from '@playwright/test';
import { dismissFeedback } from './feedbackTestHelpers';

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

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/wallet', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'SERVICE_UNAVAILABLE' } },
    }),
  );
});

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
  await page.getByRole('button', { name: '保存资料' }).click();
  await expect(page.getByText('显示名已更新')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(
    page.getByText('Current browser', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '撤销设备 Other browser' }).click();
  await page
    .getByRole('dialog', { name: '撤销设备会话？' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  expect(mutations).not.toContain('DELETE /api/v1/me/sessions/other-device');
  await page.getByRole('button', { name: '撤销设备 Other browser' }).click();
  await page
    .getByRole('dialog', { name: '撤销设备会话？' })
    .getByRole('button', { name: '确认撤销', exact: true })
    .click();
  await expect
    .poll(() => mutations.includes('DELETE /api/v1/me/sessions/other-device'))
    .toBe(true);
  await expect(page.getByRole('alertdialog')).toContainText('设备会话已撤销');
  await dismissFeedback(page);
  await page.getByRole('button', { name: '退出所有设备' }).click();
  await page
    .getByRole('dialog', { name: '退出所有设备？' })
    .getByRole('button', { name: '退出所有设备并返回登录', exact: true })
    .click();
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
  await expect(page.getByRole('alertdialog')).toContainText(
    '暂时无法验证登录状态',
  );
  await dismissFeedback(page);
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

test('administrator enrolls MFA through CSRF protected endpoints and returns to workspace', async ({
  page,
}) => {
  let verified = false;
  let projectReads = 0;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
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
    if (path === '/api/v1/projects') {
      projectReads++;
      return route.fulfill({ json: { items: [], next_cursor: null } });
    }
    if (path === '/api/v1/me/sessions')
      return route.fulfill({ json: { sessions: [] } });
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });
  await page.goto('/settings');
  await expect(
    page.getByRole('list', { name: '验证器绑定步骤' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '查看安装说明' })).toBeVisible();
  await expect(
    page.getByText('Google 登录已完成', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('六位验证码')).toBeDisabled();
  await expect(page.getByRole('button', { name: '验证并继续' })).toBeDisabled();
  await page.getByRole('button', { name: '绑定验证器' }).click();
  const qr = page.getByRole('img', { name: 'Atelier 验证器绑定二维码' });
  await expect(qr).toBeVisible();
  await expect(page.getByLabel('六位验证码')).toBeFocused();
  await expect(page.getByLabel('验证器密钥')).toHaveCount(0);
  await page.getByRole('button', { name: '无法扫码？使用密钥' }).click();
  await expect(qr).toHaveCount(0);
  await expect(page.getByLabel('验证器密钥')).toHaveValue('TESTSECRET');
  await expect(page.getByText('基于时间（Time based）')).toBeVisible();
  await page.getByRole('button', { name: '返回二维码绑定' }).click();
  await expect(qr).toBeVisible();
  await expect(page.getByLabel('验证器密钥')).toHaveCount(0);
  const codeInput = page.getByLabel('六位验证码');
  await codeInput.focus();
  await codeInput.pressSequentially('12a3456');
  await expect(codeInput).toHaveValue('123456');
  await expect(page.locator('.mfa-digit')).toHaveText([
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
  ]);
  await codeInput.press('ArrowLeft');
  await codeInput.press('Backspace');
  await expect(codeInput).toHaveValue('12346');
  await expect(page.getByRole('button', { name: '验证并继续' })).toBeDisabled();
  await codeInput.press('5');
  await expect(codeInput).toHaveValue('123456');
  await page.getByRole('button', { name: '验证并继续' }).click();
  await expect(
    page.getByRole('heading', { name: '欢迎回来，Account' }),
  ).toBeVisible();
  await expect.poll(() => projectReads).toBeGreaterThan(0);
  await expect(
    page.getByText('还没有项目，从一个想法开始吧。', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Unexpected Application Error!', { exact: true }),
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('MFA binding has no native confirmation and logout uses an accessible modal', async ({
  page,
}) => {
  let setupRequests = 0;
  let logoutRequests = 0;
  let releaseSetup!: () => void;
  const setupGate = new Promise<void>((resolve) => {
    releaseSetup = resolve;
  });
  const nativeDialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(dialog.type());
    await dialog.dismiss();
  });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          ...me,
          user: { ...user, role: 'ADMIN' },
          mfa_required: true,
        },
      });
    if (path === '/api/v1/admin/mfa/setup') {
      setupRequests++;
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      await setupGate;
      return route.fulfill({
        json: {
          otpauth_uri:
            'otpauth://totp/Atelier:test?secret=TESTSECRET&issuer=Atelier',
        },
      });
    }
    if (path === '/api/v1/auth/logout') {
      logoutRequests++;
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/v1/public/config')
      return route.fulfill({
        json: { registration_mode: 'CLOSED', version: 'test' },
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/settings');
  await page
    .getByRole('button', { name: '绑定验证器', exact: true })
    .dblclick();
  await expect(
    page.getByRole('button', { name: '正在生成二维码…' }),
  ).toBeDisabled();
  await expect.poll(() => setupRequests).toBe(1);
  releaseSetup();
  await expect(
    page.getByRole('img', { name: 'Atelier 验证器绑定二维码' }),
  ).toBeVisible();
  await expect(page.getByLabel('六位验证码')).toBeFocused();
  expect(nativeDialogs).toEqual([]);
  const logout = page.getByRole('button', {
    name: '退出所有设备',
    exact: true,
  });
  const dialog = page.getByRole('dialog', { name: '退出所有设备？' });
  const confirm = dialog.getByRole('button', {
    name: '退出所有设备并返回登录',
  });
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  await logout.click();
  await expect(dialog).toBeVisible();
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(logout).toBeFocused();
  await logout.click();
  await cancel.click();
  await expect(dialog).not.toBeVisible();
  await logout.click();
  await page.mouse.click(5, 5);
  await expect(dialog).not.toBeVisible();
  expect(logoutRequests).toBe(0);
  await logout.click();
  await confirm.click();
  await expect(page).toHaveURL(/\/login$/);
  expect(logoutRequests).toBe(1);
  expect(setupRequests).toBe(1);
  expect(nativeDialogs).toEqual([]);
});

test('MFA errors distinguish wrong codes from expired enrollment and renew only on request', async ({
  page,
}) => {
  let setups = 0;
  let verifies = 0;
  let setupFailure = false;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/me')
      return route.fulfill({
        json: { ...me, user: { ...user, role: 'ADMIN' }, mfa_required: true },
      });
    if (path === '/api/v1/admin/mfa/setup') {
      setups++;
      if (setupFailure)
        return route.fulfill({
          status: 503,
          json: { error: { code: 'SERVICE_UNAVAILABLE' } },
        });
      return route.fulfill({
        json: {
          otpauth_uri: `otpauth://totp/Atelier:test?secret=${'ABCDEFGHIJKLMNOP'[setups].repeat(16)}&issuer=Atelier`,
        },
      });
    }
    if (path === '/api/v1/admin/mfa/verify') {
      verifies++;
      return route.fulfill({
        status: verifies === 1 ? 401 : 409,
        json: {
          error: {
            code: verifies === 1 ? 'MFA_INVALID' : 'MFA_ENROLLMENT_EXPIRED',
          },
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: '绑定验证器', exact: true }).click();
  const input = page.getByLabel('六位验证码');
  const submit = page.getByRole('button', { name: '验证并继续', exact: true });
  const qr = page.getByRole('img', { name: 'Atelier 验证器绑定二维码' });
  await expect(qr).toBeVisible();
  const original = await qr.locator('path').last().getAttribute('d');
  await input.fill('123456');
  await submit.click();
  const invalid = page.getByRole('alertdialog', { name: '验证码不正确' });
  await expect(invalid).toBeVisible();
  await expect(invalid.getByRole('button', { name: '重新输入' })).toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await invalid.getByRole('button', { name: '重新输入' }).click();
  await expect(invalid).not.toBeVisible();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  expect(setups).toBe(1);
  expect(await qr.locator('path').last().getAttribute('d')).toBe(original);
  await input.fill('123456');
  await submit.click();
  const expired = page.getByRole('alertdialog', { name: '绑定已过期' });
  await expect(expired).toBeVisible();
  await expect(qr).toHaveCount(0);
  await expired.getByRole('button', { name: '取消', exact: true }).click();
  await expect(expired).not.toBeVisible();
  await expect(input).toBeDisabled();
  expect(setups).toBe(1);
  await page.getByRole('button', { name: '重新绑定', exact: true }).click();
  await expect(qr).toBeVisible();
  expect(setups).toBe(2);
  expect(await qr.locator('path').last().getAttribute('d')).not.toBe(original);
  await input.fill('123456');
  await submit.click();
  await expect(expired).toBeVisible();
  await expired.getByRole('button', { name: '重新绑定', exact: true }).click();
  await expect(expired).not.toBeVisible();
  await expect(qr).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  expect(setups).toBe(3);
  await input.fill('123456');
  await submit.click();
  await expect(expired).toBeVisible();
  setupFailure = true;
  await expired.getByRole('button', { name: '重新绑定', exact: true }).click();
  const unavailable = page.getByRole('alertdialog', {
    name: '二维码生成未完成',
  });
  await expect(unavailable).toBeVisible();
  await expect(expired).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(unavailable).not.toBeVisible();
  await expect(input).toBeDisabled();
});

test('an enrolled administrator with a wrong code sees retry without a rebind action', async ({
  page,
}) => {
  let setupRequests = 0;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          ...me,
          user: { ...user, role: 'ADMIN', mfa_enabled: true },
          mfa_required: true,
        },
      });
    if (path === '/api/v1/admin/mfa/setup') setupRequests++;
    return route.fulfill({
      status: 401,
      json: { error: { code: 'MFA_INVALID' } },
    });
  });
  await page.goto('/settings');
  const input = page.getByLabel('六位验证码');
  await input.fill('123456');
  await page.getByRole('button', { name: '验证并继续' }).click();
  await expect(
    page.getByRole('alertdialog', { name: '验证码不正确' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '重新绑定', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  expect(setupRequests).toBe(0);
});
