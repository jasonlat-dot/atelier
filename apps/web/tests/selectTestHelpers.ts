import { type Locator } from '@playwright/test';

/** Exercise the same visible combobox and listbox as a user; never write its hidden form field. */
export async function chooseSelect(control: Locator, value: string) {
  await control.click();
  await control
    .page()
    .getByRole('listbox')
    .locator(`[role="option"][data-value=${JSON.stringify(value)}]`)
    .click();
}

export async function selectOptions(control: Locator) {
  await control.click();
  return control.page().getByRole('listbox').getByRole('option');
}
