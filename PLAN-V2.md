# hedera-harness — minimal plan

**Status:** draft, not built. Written 2026-09-08.

## What it is

A command that takes a spec and an existing Hedera dApp repo, and loops an agent until the spec is implemented or the budget is spent.

```
harness run --spec ~/path/to/spec.md
```

Run from inside the target repo. Nothing else is required on the command line.

The agent is **Claude Code**, driven through `@anthropic-ai/claude-agent-sdk` (which runs the Claude Code CLI). There is no provider abstraction and no other agent.

## The loop

```
DOCTOR → GENERATE → TEST → EVALUATE → done
             ↑         │        │
             └─────────┴────────┘   repair, up to --max-attempts (default 3)
```

| Stage | What | Who |
|---|---|---|
| **DOCTOR** | Check dependencies are installed. Resolve how to install, build, test, and serve this repo. Run build and test once on the untouched tree so pre-existing breakage aborts here, not later. | code, plus one agent call to read the repo's scripts |
| **GENERATE** | Implement the spec in the repo. | Claude Code, `cwd` = repo |
| **TEST** | Run the resolved install (if dependencies changed), then `build`, then `test`. Deterministic. | code |
| **EVALUATE** | Start the dev server. Check the running app against the spec: web2 through a browser, web3 through the Hedera mirror node. Return pass/fail with a list of what failed. | Claude Code, `cwd` = a directory containing only the spec |

A failure at TEST or EVALUATE goes back to GENERATE with the failure as the prompt. The Claude Code session is resumed, so the agent keeps its context. After `--max-attempts` the run stops and reports.

### DOCTOR

Checks, in order; any failure stops the run before anything is touched:

1. `node`, `yarn` (or the repo's package manager), `git` present.
2. `.harness/` is listed in `.git/info/exclude`, appended if missing. That file is per-clone and untracked, so the harness's own output never dirties the repo and never appears as a diff in the branch you review. If `.harness/` is already *tracked* in this repo, the run stops and says so — ignore rules don't apply to tracked files, and the next check would fail forever.
3. Git tree clean.
4. Claude Code credentials resolve.
5. `@playwright/cli` installed and its browser downloaded; the Hedera and Playwright plugin directories exist on disk.
6. Plugins actually load. `plugins_applied` from `initializationResult()` is asserted on the first query that lists them — DOCTOR's own resolution call on a first run, GENERATE's otherwise — and a plugin listed but not applied aborts before any work starts. It cannot be checked statically: the flag only exists once a query is running. Silently skill-less generation is the failure this prevents.
7. Commands resolved: `install`, `build`, `test`, `serve` — see below. Later runs read the tracked `harness.yaml` and skip this entirely.
8. The resolution works: `install`, then `build`, then `test` on the untouched repo; then `serve` starts, prints a URL that answers, and is stopped. Only now is `harness.yaml` written and committed.

**Resolving the commands.** DOCTOR hands the agent the root `package.json`, every workspace `package.json`, the lockfile name, and any README or CONTRIBUTING section about running the project — not the whole repo. The agent replies through an in-process tool, the same pattern as `submit_verdict`, so the answer arrives typed rather than parsed out of prose. DOCTOR then checks each proposed script actually exists in the `package.json` at its `cwd`, prints the proposal, and asks for confirmation. Check 8 is the real verification: a resolution is only written down after it has been executed successfully, so a plausible-looking guess that doesn't work never reaches `harness.yaml`.

The guessing is not incidental. In `scaffold-hbar` the root has no `build`, `test` or `dev` script at all — the real ones are `next:build` and `hardhat:test` — and inside `packages/nextjs`, `start` is `next dev` while `serve` is `next start`. Name-matching gets this wrong three separate ways, which is why an agent reads it and a human confirms it.

**Why the file exists at all.** It is a cache of that resolution and, more importantly, the place to correct it. Without it every run re-resolves, so TEST could run different commands on run 5 than on run 1 — the harness's own behaviour becomes nondeterministic, which is exactly what TEST is supposed not to be. And when the agent resolves something wrong in a way check 8 can't catch (a `test` script that exists and passes but tests the wrong package), a tracked file is the only way to fix it once instead of every run. It holds no secrets, it is four lines, and it describes the project rather than the run — so it is committed, not ignored.

```yaml
install: yarn install
build: yarn next:build
test: yarn hardhat:test
serve:
  run: yarn next:dev
  cwd: packages/nextjs
```

Each command may be a string or `{ run, cwd }`. `cwd` defaults to the repo root. `test` may be empty if the repo has no test script; `build` may not.

### GENERATE

One `query()` with the spec as the prompt, `cwd` = repo, Hedera skills loaded as local plugins from `~/Work/hedera-skills/plugins/*`. A `PreToolUse` hook denies writes to `.env*` files. Everything else — which files to touch, which skills to use, whether to write tests — is the agent's call.

On a repair attempt, the same session is resumed with the failure as the next message:

- after TEST: the command that failed, its exit code, and its output
- after EVALUATE: the evaluator's list of failed items, verbatim

Each failure gets an identity — the failing command plus a normalised first error line, or the `what`/`where` of each verdict failure — hashed and recorded. Two attempts producing the same hash means the resumed session is stuck on it, so the next attempt starts a fresh session with the failure as its opening prompt instead of resuming. This is the whole convergence mechanism: it tells the report whether an attempt fixed anything or traded one failure for another, and it is the only way out of a session that has talked itself into a corner.

Every attempt also writes `feedback.json` — `{ ok: boolean, results: string[] }`, one line per failure, whichever stage produced it. The resumed session does not read it; the failure reaches the agent as the next message in its own conversation. The file exists so a human reviewing the branch afterwards can see what each attempt was told without replaying a transcript, and so a fresh session after a reset has something to be seeded with.

### TEST

Runs `install` only if `package.json` or the lockfile changed since the last attempt, then `build`, then `test`. The first non-zero exit code fails the stage; the later commands are skipped. The failing command's output is captured for the repair prompt.

`build` runs before the dev server starts and the dev server is stopped before the next `build` — a Next.js build and a running `next dev` collide on `.next/`.

### EVALUATE

The harness starts `serve`, reads the local URL from its output, and waits for it to answer. It then runs one `query()` with:

- `cwd` = a fresh directory containing only `spec.md`, plus an empty `evidence/` for the agent to write into
- containment: `Read`/`Edit`/`Glob`/`Grep` **deny** rules for everything outside that directory, under `sandbox: { enabled: true, failIfUnavailable: true }`. The rules are what restrict the filesystem — the SDK is explicit that "filesystem and network restrictions are configured via permission rules, not via these sandbox settings"; `sandbox.enabled` on its own restricts nothing. `failIfUnavailable` turns a missing bubblewrap/seatbelt into an abort instead of a silently unsandboxed run. A bare `cwd` is not enough: it constrains relative paths, and on 2026-07-24 the old evaluator read `src/promptBuilder.ts` and `src/validation/chainSigner.ts` by absolute path with `--workspace` set
- the app URL, the Hedera network name, and the mirror node URL in the prompt
- Playwright's CLI skill loaded as a local plugin; the agent drives the browser with `playwright-cli` through Bash
- one in-process tool, `submit_verdict`, registered with `createSdkMcpServer`

The evaluator is told: *read the spec, decide what a user should be able to do, try it in the browser, verify any on-chain effect through the mirror node, then call `submit_verdict`.*

**Every attempt gets a new evaluator.** GENERATE resumes its session so it remembers what it already tried; EVALUATE never does. A resumed evaluator would remember the failures it reported last time — which is exactly the list the generator was just told to fix — so it would re-check those and wave the rest through, arriving already expecting a broken app. Each verdict has to be an independent judgment of the app as it stands, not a diff against its own previous opinion. The worker remembers; the referee does not.

Three unrelated things here are called a session, and only the first is resumed: the generator's Claude Code session (one per run, across attempts), the evaluator's Claude Code session (one per EVALUATE — many Bash calls, one conversation, no `resume`), and the `playwright-cli -s=<name>` browser session that keeps the page alive between those Bash calls and is closed with the browser.

```ts
submit_verdict({
  pass: boolean,
  failures: Array<{ what: string; where: string; evidence: string }>
})
```

`evidence` is either a filename the evaluator wrote into `evidence/` (a screenshot, a page snapshot, a saved response) or a mirror-node URL. The harness resolves every filename before accepting the call and rejects the verdict if one is missing — an evaluator can otherwise cite a screenshot it never took, and nothing downstream would notice.

Web2 checks are what the browser shows. Web3 checks are mirror-node reads (`/api/v1/topics/{id}/messages`, `/api/v1/accounts/{id}`, `/api/v1/transactions/…`) — public, no credentials. The evaluator holds no keys.

A verdict is never re-rolled: a well-formed `submit_verdict` fails or passes the attempt, and `failures` become the repair prompt. Re-running an evaluator that answered is the harness grading its own homework.

EVALUATE is re-run once against the same commit only when there is **no verdict**, which means exactly three things:

1. the evaluator ended without calling the tool, including by hitting a bound,
2. the payload failed schema validation, or
3. it cited evidence the harness cannot find on disk.

Anything else is an answer. A second miss aborts the run — the app is not what broke.

The harness stops `serve` after every EVALUATE.

## Bounds

Nothing runs unbounded. Each phase adds the bound for whatever it introduces, so no phase can hang the run it just made possible. The numbers are starting points, tuned after the first real run rather than reasoned about now.

| Bounded | Phase | Bound | On breach |
|---|---|---|---|
| DOCTOR resolution query | 2 | 5 min wall clock | abort |
| `install` / `build` / `test` | 3 | 20 min each | TEST failure — repair |
| `serve` becoming ready | 3 | 2 min to a URL that answers | TEST failure — repair |
| GENERATE query | 4 | `maxTurns`, `maxBudgetUsd`, wall clock via `AbortController` | abort |
| EVALUATE query | 5 | same, shorter | no verdict — re-run once, then abort |

The split follows the third rule of the loop: an agent that hangs is the harness's problem and must not cost an attempt, while a `build` or `test` that never returns is a defect in what the agent just wrote and goes back as a repair. EVALUATE has one extra safeguard the others can't have — `_meta['claude/endTurn']` on `submit_verdict`, so answering ends the turn rather than leaving the agent to decide it is finished.

## Git

The run works on a new branch `harness/<timestamp>` created from the current commit. Each attempt that passes TEST is committed. Because `.harness/` is excluded, those commits carry only what the agent changed — the run's own logs, transcripts and screenshots stay out of the history. On exit the branch is left as-is for the user to inspect, merge or delete.

## Output

```
.harness/runs/<timestamp>/
  harness.log          one line per stage transition
  attempt-N/
    generate.jsonl     SDK messages
    build.txt          build output
    test.txt           test output
    evaluate.jsonl     SDK messages
    verdict.json       submit_verdict payload, exactly as the evaluator sent it
    feedback.json      { ok, results } — what this attempt failed on, for review
    evidence/          playwright-cli screenshots and snapshots
  result.json          { passed, attempts, branch, failures: per attempt, by hash }
```

Written into the repo but git-excluded, so the artifacts sit beside the branch they belong to without entering it. The last thing printed is the branch name and `passed: true|false`.

## Shape

```
src/
  cli.ts        harness run --spec <path> [--max-attempts N]
  doctor.ts     dependency checks, command resolution, harness.yaml, baseline test
  generate.ts   query() against the repo, session resume, .env hook
  test.ts       run install/build/test in order, capture output
  serve.ts      start dev server, capture URL, stop
  evaluate.ts   blind query(), submit_verdict tool, evidence dir
  loop.ts       the loop, attempt budget, repair prompt
  git.ts        branch, commit
  run.ts        .harness/runs/<ts>/ layout
```

## Build order

Each step ends runnable, and each carries the bound for what it introduces (see [Bounds](#bounds)).

1. `cli` + `git` + `run` — `harness run --spec` creates a branch and a run directory.
2. `doctor` — refuses to start on a broken repo, writes `harness.yaml`.
3. `test` + `serve` — install, build and test run in order and stop at the first failure; dev server starts, URL captured, server stopped.
4. `generate` — one attempt, no repair; agent edits the repo; `.env` write is denied.
5. `evaluate` — verdict arrives via the tool from a directory that cannot read the repo.
6. `loop` — repair on failure, session resume, failure hashing and the fresh-session reset, budget.

## Not in scope

Multiple specs, scaffolding (`init`), other agent providers, model selection, benchmarking, reports beyond `result.json`, wallet-connected flows in the evaluator (the evaluator has no signer; spec items that need one are judged by what the UI offers).
