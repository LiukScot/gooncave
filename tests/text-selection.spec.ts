import { expect, test } from './helpers';

// The app's chrome is controls, not a document: Select All, a long press or a drifting drag must
// not paint headings, tiles and buttons with the selection colour. Text meant to be copied stays.
test('select all selects no interface text, while fields and copyable text stay selectable', async ({ page }) => {
  await page.goto('/app/settings/subscriptions');
  await expect(page.getByRole('heading', { name: 'Subscriptions' }).first()).toBeVisible();

  const selected = await page.evaluate(() => {
    document.getSelection()?.selectAllChildren(document.body);
    return document.getSelection()?.toString().trim() ?? '';
  });
  expect(selected).toBe('');

  const copyable = await page.evaluate(() => {
    const probe = (html: string) => {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.append(host);
      const value = getComputedStyle(host.firstElementChild as Element).userSelect;
      host.remove();
      return value;
    };
    return {
      input: probe('<input>'),
      textarea: probe('<textarea></textarea>'),
      description: probe('<div class="file-detail-source-text">text</div>'),
      log: probe('<pre class="report-log">log</pre>')
    };
  });
  expect(copyable).toEqual({ input: 'text', textarea: 'text', description: 'text', log: 'text' });
});
