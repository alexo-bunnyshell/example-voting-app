import { expect, test } from '@playwright/test';
import { voteUrl } from './helpers';

// Read-only checks. Anything that casts a vote belongs in vote-flow.spec.ts, which
// runs serially so that votes do not skew each other's tally.
test('vote page shows both options', async ({ page }) => {
  await page.goto(voteUrl);
  await expect(page.getByRole('heading', { name: 'Cast Your Vote' })).toBeVisible();
  await expect(page.locator('button#a')).toBeEnabled();
  await expect(page.locator('button#b')).toBeEnabled();
  await expect(page).toHaveTitle(/ vs .* - Modern Voting App/);
});
