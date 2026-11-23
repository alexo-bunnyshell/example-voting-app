import { expect, test } from '@playwright/test';
import { castVote, expectTally, resultUrl, tally, voteUrl } from './helpers';

// These tests follow a vote through every service: vote -> redis -> worker ->
// postgres -> result. Vote counts are shared state, so the tests run one at a
// time and assert on changes to the tally, not on absolute numbers.
test.describe.configure({ mode: 'serial' });

test.describe('vote flow', () => {
  test('a vote is marked on the page and counted', async ({ page, context, request }) => {
    const before = await tally(request);

    await page.goto(voteUrl);
    await castVote(page, 'a');
    await expect(page.locator('button#a .fa-check-circle')).toBeVisible();
    await expect(page.locator('button#b')).toBeEnabled();
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === 'voter_id')?.value).toBeTruthy();

    await expectTally(request, { a: before.a + 1, b: before.b });
  });

  test('changing a vote moves it to the other option', async ({ page, request }) => {
    const before = await tally(request);

    await page.goto(voteUrl);
    await castVote(page, 'a');
    await expectTally(request, { a: before.a + 1, b: before.b });

    // Same browser, same voter_id cookie: this must update the vote, not add one.
    await castVote(page, 'b');
    await expectTally(request, { a: before.a, b: before.b + 1 });
  });

  test('the results page updates live', async ({ browser, request }) => {
    const results = await browser.newPage();
    await results.goto(resultUrl);
    const before = await tally(request);
    const total = before.a + before.b;
    await expect(results.locator('#result')).toContainText(
      new RegExp(total === 0 ? 'No votes yet' : `\\b${total} votes?\\b`),
    );

    const voter = await browser.newPage();
    await voter.goto(voteUrl);
    await castVote(voter, 'b');

    // No reload: the new total arrives over the results page's websocket.
    await expect(results.locator('#result')).toContainText(new RegExp(`\\b${total + 1} votes?\\b`), {
      timeout: 20_000,
    });
  });
});
