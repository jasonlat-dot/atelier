import { expect, type Page } from '@playwright/test';

// Only acknowledge a result after the test has explicitly asserted it.
export async function dismissFeedback(page: Page) {
  const feedback = page.getByRole('alertdialog');
  await expect(feedback).toBeVisible();
  await feedback.getByRole('button', { name: '知道了', exact: true }).click();
}
