import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const voteUrl = process.env.VOTE_URL || process.env.BASE_URL!;
export const resultUrl = process.env.RESULT_URL!;
// The tally comes from the result service's /healthz, over the internal service
// address when the tests run inside the environment.
const tallyUrl = `${process.env.RESULT_INTERNAL_URL || resultUrl}/healthz`;

export type Tally = { a: number; b: number };

export async function tally(request: APIRequestContext): Promise<Tally> {
  const response = await request.get(tallyUrl);
  expect(response.ok(), `GET ${tallyUrl}`).toBeTruthy();
  return (await response.json()).votes;
}

/** Waits until the tally the result service reports equals `expected`. */
export async function expectTally(request: APIRequestContext, expected: Tally) {
  await expect
    .poll(() => tally(request), {
      message: 'votes counted by the result service',
      timeout: 20_000,
    })
    .toEqual(expected);
}

export async function castVote(page: Page, option: 'a' | 'b') {
  await page.locator(`button#${option}`).click();
  await expect(page.locator(`button#${option}`)).toBeDisabled();
}
