import { test, expect, type Page } from '@playwright/test';
import { dismissFeedback } from './feedbackTestHelpers';

async function fixture(page: Page) {
  let checked = false;
  let uploads = 0;
  let redemptions = 0;
  const asset = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Sample.png',
    kind: 'image',
    source: 'upload',
    state: 'READY',
    bytes: 68,
    width: 1,
    height: 1,
    duration_ms: null,
    thumbnail_url: null,
    media_url: null,
    created_at: '2026-10-24T00:00:00Z',
    expires_at: '2026-11-24T00:00:00Z',
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/me')
      return route.fulfill({
        json: {
          user: {
            id: asset.id,
            email: 'feedback@gmail.com',
            display_name: 'Feedback',
            role: 'USER',
            mfa_enabled: false,
          },
          csrf_token: 'feedback-csrf',
          mfa_required: false,
        },
      });
    if (path === '/api/v1/public/config')
      return route.fulfill({ json: { registration_mode: 'CLOSED' } });
    if (path === '/api/v1/wallet')
      return route.fulfill({
        json: {
          balance: checked ? 30 : 20,
          held: 0,
          available: checked ? 30 : 20,
          checked_in_today: checked,
          streak: checked ? 1 : 0,
          next_reward: checked ? 11 : 10,
          local_date: '2026-10-24',
          timezone: 'Asia/Shanghai',
        },
      });
    if (path === '/api/v1/wallet/ledger')
      return route.fulfill({ json: { items: [], next_cursor: null } });
    if (path === '/api/v1/me/usage')
      return route.fulfill({ json: { daily: [], qualities: [] } });
    if (path === '/api/v1/wallet/checkin') {
      checked = true;
      return route.fulfill({
        json: {
          local_date: '2026-10-24',
          streak: 1,
          credits: 10,
          already_checked_in: false,
        },
      });
    }
    if (path === '/api/v1/wallet/redeem') {
      redemptions++;
      return route.fulfill({
        status: 422,
        json: { error: { code: 'INVALID_REDEEM_CODE' } },
      });
    }
    if (path === '/api/v1/assets/limits')
      return route.fulfill({
        json: {
          image_max_bytes: 20000000,
          video_max_bytes: 200000000,
          max_video_seconds: 60,
          video_enabled: false,
        },
      });
    if (path === '/api/v1/assets/uploads') {
      uploads++;
      return route.fulfill({ json: asset });
    }
    if (path === '/api/v1/assets')
      return route.fulfill({
        json: {
          items: uploads ? [asset] : [],
          total: uploads,
          next_cursor: null,
        },
      });
    throw new Error(`Unexpected feedback fixture request ${path}`);
  });
  page.on('dialog', () => {
    throw new Error('Native browser dialog is forbidden');
  });
  return { redemptions: () => redemptions, uploads: () => uploads };
}

test('operation results use the shared overlay and errors trap focus, dismiss safely and can recur', async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/wallet');
  await page.getByRole('button', { name: '领取今日积分' }).click();
  const feedback = page.getByRole('alertdialog');
  await expect(feedback).toContainText('签到成功，获得 10 积分，连续 1 天');
  await expect(page.locator('.wallet-feedback')).toHaveCount(0);
  await expect(feedback).toHaveCSS('border-radius', '24px');
  expect(
    await feedback.evaluate(
      (el) => getComputedStyle(el, '::backdrop').backgroundColor,
    ),
  ).toBe('rgba(0, 0, 0, 0.45)');
  await expect(feedback.getByRole('button', { name: '知道了' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(feedback.getByRole('button', { name: '知道了' })).toBeFocused();
  await page.screenshot({
    path: info.outputPath('feedback-success-desktop.png'),
  });
  await page.keyboard.press('Escape');
  await expect(feedback).toHaveCount(0);
  await page.getByLabel('兑换码', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: '兑换', exact: true }).click();
  await expect(feedback).toContainText('兑换码无效、已使用或已过期');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: '兑换', exact: true }),
  ).toBeFocused();
  expect(state.redemptions()).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    await page
      .getByRole('button', { name: '收起导航', exact: true })
      .isVisible()
  )
    await page.getByRole('button', { name: '收起导航', exact: true }).click();
  await page.getByRole('button', { name: '兑换', exact: true }).click();
  await expect(feedback).toContainText('兑换码无效、已使用或已过期');
  const box = await feedback.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(358);
  expect(box!.height).toBeLessThanOrEqual(812);
  await page.screenshot({ path: info.outputPath('feedback-error-mobile.png') });
  await dismissFeedback(page);
  expect(state.redemptions()).toBe(2);
});

test('simultaneous upload results queue one dialog at a time and leave the page without stale notices', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/assets');
  await expect(
    page.getByRole('button', { name: '上传素材', exact: true }),
  ).toBeEnabled();
  await page.getByLabel('选择上传素材', { exact: true }).setInputFiles([
    {
      name: 'Sample.png',
      mimeType: 'image/png',
      buffer: Buffer.from('test image'),
    },
    {
      name: 'Unsupported.gif',
      mimeType: 'image/gif',
      buffer: Buffer.from('invalid'),
    },
  ]);
  await expect(page.getByRole('alertdialog')).toContainText('已上传 1 个素材');
  await expect(page.locator('dialog[data-feedback-dialog]')).toHaveCount(1);
  await dismissFeedback(page);
  await expect(page.getByRole('alertdialog')).toContainText('暂不支持上传');
  await expect(page.locator('dialog[data-feedback-dialog]')).toHaveCount(1);
  expect(state.uploads()).toBe(1);
  await page.goto('/wallet');
  await expect(page.getByRole('heading', { name: '我的积分' })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
