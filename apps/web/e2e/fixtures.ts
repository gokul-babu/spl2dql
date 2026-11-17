import { test as base, expect, type Page } from '@playwright/test';

/** Every test records requests to other origins and console errors (CSP violations included). */
export const test = base.extend<{ watch: { external: string[]; api: string[]; errors: string[] } }>({
  watch: async ({ page }, use) => {
    const external: string[] = [];
    const api: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.protocol === 'data:' || u.protocol === 'blob:') return;
      if (u.host !== '127.0.0.1:4173' && !u.host.startsWith('127.0.0.1:')) external.push(r.url());
      if (u.pathname.startsWith('/api/')) api.push(r.url());
    });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await use({ external, api, errors });
  },
});

export { expect };

export async function loadExample(page: Page, index: number): Promise<void> {
  await page.getByLabel('Load an example search').selectOption(String(index));
  await expect(page.getByTestId('confidence')).toBeVisible();
}

export async function typeSpl(page: Page, text: string): Promise<void> {
  const editor = page.getByLabel('Splunk SPL search');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
}

/** Opens a view through the navigation, as a person would. */
export async function openView(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name, exact: true }).click();
}
