# hedera-harness

Give it a spec and a Hedera dApp repo. It loops a coding agent until the spec is met, and decides for itself whether it was.

> The harness adjudicates. The agent does the work.

An agent that reports its own success is worth nothing, so nothing here takes the agent's word for it. Tests are run by the harness. The app is judged by a second agent that is never allowed to see the source. Evidence for any claimed failure has to exist on disk before the verdict is accepted.

## Quick start

From inside the project you want to build in:

```bash
harness init payment-flow      # works out how to build this project, drafts a spec
$EDITOR specs/payment-flow.md  # fill it in
harness run --spec specs/payment-flow.md
```

`init` is optional. `harness run --spec <path>` works on a project that has never seen the harness — it just resolves the commands on the way past.

## What it does

```
DOCTOR → GENERATE → TEST → EVALUATE → done
             ↑         │        │
             └─────────┴────────┘   repair, up to --max-attempts (default 3)
```

| Stage | What happens |
|---|---|
| **DOCTOR** | Checks tooling and a clean tree. Works out how to install, build, test and serve this project, then runs those commands on the untouched repo — so a project that was already broken fails here rather than being blamed on the agent. |
| **GENERATE** | An agent implements the spec. It decides which files to touch and whether to write tests. |
| **TEST** | Install, build, test — stopping at the first failure. No agent involved. |
| **EVALUATE** | A second agent judges the running app against the spec, driving a real browser and reading chain state from the public mirror node. It cannot see your code. |

Each attempt is committed to a `harness/<timestamp>` branch. When the run ends you are back on the branch you started from, with the work waiting on that branch.

## Writing a spec

A spec is markdown. The only rule that matters: **anything you assert should be checkable by a person using the app**, because that is how it will be judged.

```markdown
# Network status page

The page at `/status` shows which Hedera network the app is pointed at.

## What a user sees
- the network name, in an element with id `network-name`
- the latest consensus timestamp, fetched live from the mirror node

## Behaviour
- while the request is in flight the page shows a loading state, not `undefined`
- if the mirror node is unreachable, a readable error appears in `#status-error`

## Constraints
- read-only; no transaction, no operator key
```

"The hook polls every 10 seconds" is not checkable from outside. "The number updates without a page reload, roughly every 10 seconds" is. `harness init` drafts a skeleton with this framing, tailored to your project.

## harness.yaml

Written by the harness on first use, and committed, because it describes the project rather than a run:

```yaml
# Root next:build delegates to `next build` in @sh/nextjs, the only production
# build in the repo (hardhat has only compile).
build: yarn next:build
# next:dev runs `next dev` and keeps running; note next:start also runs
# `next dev` while next:serve runs the production `next start`.
serve: yarn next:dev
```

An agent reads your manifests and proposes these; you confirm them once. Script names lie often enough that this is worth an agent rather than a guess — in scaffold-hbar the root has no `build`, `test` or `dev` at all, and inside `packages/nextjs`, `start` is a dev server while `serve` runs the production build.

The comments are the agent's reasoning, kept so the next person to read the file knows why this command and not the obvious-looking one. Edit any line by hand; the harness will not overwrite it.

Each command is a string, or `{ run, cwd }` when it must run somewhere other than the repo root.

## Commands

```
harness init [name]         set the project up and draft specs/<name>.md
harness run --spec <path>   build the feature described by a spec

  --max-attempts N          repair attempts before giving up (default 3)
  --model NAME              sonnet (default), opus, haiku, or a full model id
  --yes                     skip the first-run command confirmation
```

## What a run leaves behind

```
.harness/runs/<timestamp>/
  harness.log          one line per stage transition
  spec.md              what the run was asked to build
  baseline/            install.txt, build.txt, test.txt, serve.txt — from before
                       the agent touched anything
  attempt-N/
    generate.jsonl     every message from the building agent
    install.txt        command output, one file per stage that ran
    build.txt
    test.txt
    evaluate.jsonl     every message from the judging agent
    verdict.json       pass/fail with findings
    feedback.json      what this attempt was told went wrong
    evidence/          screenshots, page snapshots, saved responses
  result.json          { passed, attempts, branch, timings }
```

`.harness/` is added to `.git/info/exclude`, so it never appears in your diffs and never needs a `.gitignore` entry.

## How it decides

Four rules, each guarding a specific way this could lie to you.

**The evaluator cannot see your code.** It runs in a directory containing only the spec, with the repo denied at the sandbox. Judging the code instead of the app is the failure that makes a passing run worthless.

**A verdict must show its work.** Every failure cites evidence, and the harness confirms those files exist before accepting the verdict. A finding it cannot see is not a finding.

**A verdict is never re-rolled.** If the evaluator answers, that answer stands. Only the *absence* of an answer — no verdict, a malformed one, or evidence that is not there — earns a second look, once.

**Secrets never reach git history.** `.env` files are refused during generation and, more importantly, can never be staged — the enforceable half, since the harness owns the commit.

## Requirements

- Node 20+
- git, and a repo with at least one commit and a clean tree
- A `package.json` at the repo root
- Claude Code credentials — a subscription login or `ANTHROPIC_API_KEY`
- `@playwright/cli` browsers installed, for EVALUATE

## Configuration

Machine-level settings are environment variables, deliberately kept out of `harness.yaml`:

| | |
|---|---|
| `HARNESS_MODEL` | Default agent model. Same as `--model`. |
| `HEDERA_SKILLS_DIR` | Extra skill plugins, for a project that ships none of its own. Unset by default — a scaffolded project carries its skills in `.claude/skills/` and they load automatically. |
| `HEDERA_NETWORK` | `testnet` (default), `previewnet`, `mainnet`. |
| `HEDERA_MIRROR_NODE` | Overrides the mirror node URL derived from the network. |
| `HEDERA_OPERATOR_ID` | Account the evaluator is told to inspect on chain. Never a key. |

Every stage is bounded: 60 minutes for generation, 20 for evaluation, 20 per command, 2 minutes for the dev server to answer.

## What it does not do yet

- **No signer.** The evaluator reads chain state but cannot sign, so anything behind a wallet is judged on what the UI offers rather than by completing the transaction.
- **One spec at a time.** No sequencing of multiple specs into a larger feature.
- **Claude only.** No provider abstraction.
- **It does not scaffold projects.** Use `create-scaffold-hbar`; the harness works on a repo that already exists.

## Development

```bash
npm install
npm run build
npm link          # puts `harness` on your PATH
```

Design notes and parked work are in [PLAN-V2.md](./PLAN-V2.md).
