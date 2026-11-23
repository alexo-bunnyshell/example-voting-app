# Voting app end-to-end tests

Playwright tests that follow a vote through every service of the voting app:
vote → redis → worker → postgres → result.

They run inside each Bunnyshell environment on every deploy (the `playwright` and
`e2e-tests` components in `../bunnyshell.yaml`). A failing test fails the deploy, and the
HTML report is published at `https://e2e-<env domain>`.

Built on [template-playwright](https://github.com/alexo-bunnyshell/template-playwright).
See its README for the runner scripts and variables.

| Test | What it proves |
|---|---|
| `vote-page.spec.ts` | The vote page renders both options. |
| `vote-flow.spec.ts` › a vote is marked and counted | The page marks the choice, and the vote reaches Postgres and the result service. |
| `vote-flow.spec.ts` › changing a vote | Re-voting updates the existing vote instead of adding one. |
| `vote-flow.spec.ts` › results page updates live | The results page picks up new votes over its websocket. |

Variables: `VOTE_URL`, `RESULT_URL` (public URLs), `RESULT_INTERNAL_URL` (in-cluster address
used for the tally), plus the template's `WAIT_FOR_URLS`, `PW_TRACE`, `PW_VIDEO`, `PW_BROWSERS`.

Run against any deployed environment:

```sh
docker build -t voting-e2e e2e
docker run --rm -e VOTE_URL=https://vote-... -e RESULT_URL=https://result-... voting-e2e run
```
