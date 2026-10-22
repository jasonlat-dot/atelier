import { test, expect } from '@playwright/test';

test('mock canvas, local jobs, persistence, wallet and role switching survive M0', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /欢迎回来/ })).toBeVisible();
  await page.getByRole('link', { name: '无限创作画布', exact: true }).click();
  await expect(page.getByText('创作工具', { exact: true })).toBeVisible();
  await page.getByLabel('创意描述').fill('M0 自动化图片测试');
  await page.getByRole('button', { name: '开始生成图片' }).click();
  await expect(page.getByText('任务已提交', { exact: false })).toBeVisible();
  await expect(
    page.locator('.task-row').first().getByText('已完成', { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200); // Existing 850 ms auto-save debounce.
  await page.reload();
  await expect(
    page
      .locator('.react-flow__node')
      .filter({ hasText: 'M0 自动化图片测试' })
      .first(),
  ).toBeVisible();
  await page.getByRole('link', { name: '积分与订阅', exact: true }).click();
  await page.getByRole('button', { name: '每日签到 +20' }).click();
  await expect(page.getByRole('button', { name: '今日已签到' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: '今日已签到' })).toBeDisabled();
  await page.locator('.identity-button').click();
  await page.getByRole('button', { name: /Jordan Lee/ }).click();
  await page.getByRole('link', { name: '用户管理', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '用户管理', exact: true }),
  ).toBeVisible();
  await page.locator('.identity-button').click();
  await page.getByRole('button', { name: /Mira Chen/ }).click();
  await expect(
    page.getByRole('link', { name: '用户管理', exact: true }),
  ).toHaveCount(0);
});
