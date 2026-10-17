# How a feature goes from spec to production

CaravelWay is built by AI coding agents working to written rules, with a product owner deciding what
gets built and a person pressing the deploy button. This page describes that process as it actually
runs in the repository. Nothing here is aspirational; each step is enforced by a file, a hook or a CI
check.

## Who does what

| Role | Who | Can | Cannot |
|---|---|---|---|
| Product owner | Me | Decide what to build, rule on trade-offs, deploy | Nothing is skipped on my behalf: a deploy still needs every check green |
| Builders | Claude Code sessions (main builder), OpenAI Codex (second builder) | Write code, tests and docs on a branch; open a pull request | Merge, deploy, or touch production in any way |
| Reviewers | Specialist reviewer agents, plus models from other AI labs | Find problems in a change | Approve their own findings. Every finding is checked against the code first |
| Merge conductor | A separate Claude Code session | Merge pull requests that meet the READY bar, through the merge queue | Merge anything that is not READY; deploy |
| Deploy | A person, by pressing a button | Ship the current main branch | Ship a branch, or ship past a red check |

By the numbers, over five months: about 1,800 commits and 1,600 merged pull requests, most of them
co-authored by Claude Code.

## 1. Decide, in plain language

Every product decision is written down first, in plain language, as a dated entry in an append-only
decisions log (about 230 entries so far). An entry says what was decided, why, and what it replaces.
Later work may not contradict a logged decision without flagging it.

Anything substantial also gets a numbered design document (about 90 so far). Each carries a status
(*proposed*, *partial*, *applied*, *living*) that CI checks. A spec follows a fixed template:

- context
- invariants (what must always hold)
- acceptance criteria as checkboxes
- performance budget
- non-goals
- open questions

A CI advisory flags a build pull request that arrives without its design document.

## 2. Brief the builder

Work is handed out as **lanes**: short plain-language briefs that a fresh agent session can pick up
from one line. Every session also inherits a standing contract, without being told:

- **`CLAUDE.md`** (for Claude Code) and **`AGENTS.md`** (for Codex) carry the project rules.
- **A lane contract** carries the non-negotiables: never merge, never touch production, end every pull
  request READY or PARKED (never a forgotten draft), and *verify rather than inherit*: "every claim
  about the code is hearsay until read at file:line".
- **Binding engineering standards** cover sixteen areas:
  - types and validation at every boundary
  - append-only database migrations, and money in integer cents
  - idempotency and transactions
  - versioned, additive APIs
  - tenants as data, never code
  - jobs that are safe to re-run
  - testing, security and error handling
  - state machines
  - a debt ratchet: known violations may only go down

The governing rule is to build for many operators and many partners, never a one-off. New code must
comply in full. Existing violations are registered and ratcheted down, not copied.

## 3. Build in isolation

- Each session works in its own git worktree or cloud sandbox. This rule exists because two sessions
  once shared one working copy and one switched branches under the other.
- Hooks block edits to protected files (database files, environment files, lockfiles) and block
  commits on the main branch. Another hook refuses a commit to the pricing code unless the pricing
  test suite passes.
- Database migrations are written unnumbered. A single allocator assigns the number late, so two
  parallel lanes can never claim the same one.
- Risky behaviour ships **dark**, behind a switch that is off by default. It is turned on separately,
  after a controlled check.

## 4. Test

- About 1,200 test files, run against a real Postgres database rather than mocks.
- **Golden tests** pin exact outputs for pricing and proration. **Property tests** throw hundreds of
  generated cases at the pricing engine.
- **Mutation testing** deliberately breaks the money code and checks the tests notice.
- Time-dependent tests run on a frozen clock, so a result never depends on when the suite runs.
- Fourteen GitHub workflows. The required checks include the full test suite, type checking, pricing
  goldens, a secret scan over the full git history, migration safety rules, a check that the published
  partner API contract has not changed shape by accident, and the standards ratchet.
- Most gates ship with a self-test that plants a known failure, because a gate should not certify itself.

## 5. Review, scaled to risk

The review a change needs is worked out **mechanically from the files it touches**, not chosen by
whoever wrote it.

| Tier | Covers | Review owed |
|---|---|---|
| Full | Money, database migrations, privacy and consent, authentication and tenancy, bookings, the public site | Internal review, then an external council: two models from different labs look for defects, Claude checks every finding against the code, one strong model tries to refute what is left, one final re-read |
| Single | Other product code, CI and deploy | Internal review, then one strong external pass |
| Internal | Tooling and gates | Internal review only, recorded as such |

Internal review always runs first. It combines a general code review with specialist reviewer agents
(for example, one that checks booking and payment safety, and one that checks the data layer).

Two rules keep the council honest:

- **Agreement is not truth.** A finding is accepted only after it is reproduced or confirmed in the
  code. Reviewers are often wrong, and the record shows findings refuted empirically as well as fixed.
- **Different lineages.** When Codex wrote the change, the reviewing seats come from other labs.

The review record goes in the pull request body, and a CI check verifies it is there.

## 6. READY, or PARKED

A pull request is **READY** only when all four hold:

1. Every required check is green on the actual latest commit.
2. GitHub reports the merge state as clean, read in the same call as mergeability.
3. For a protected change (money, migrations, the public site, gates and so on), the review its tier
   requires is recorded and every finding has been adjudicated.
4. Nothing is parked and no question is waiting for the owner.

Otherwise it is **PARKED**, with the reason written down. Never a silent draft.

## 7. Merge

The merge conductor lands READY pull requests through GitHub's merge queue and reports each merge to
me afterwards. Nobody merges outside the queue, and a builder never merges its own work.

## 8. Deploy: people only

Agents have no production access: no server login, no production database, no deploy. Production is
deployed only by a person pressing the deploy button, which:

1. asks for a typed confirmation phrase;
2. refuses anything but the main branch, and refuses unless every required check is green on that exact commit;
3. runs a read-only preflight;
4. applies database migrations before anything restarts, and stops if one fails;
5. deploys through a key that can run one fixed deploy script and nothing else; that script backs up
   the database before it switches the code;
6. checks that production now reports the commit that was shipped, with no migrations left pending.

**Merge first, then deploy** is a rule because once a feature went live straight from a branch. The
next routine deploy would have wiped it silently. Since then the only deploy source is main.

## 9. Live database migration, in peak season

In July 2026 the production database moved from SQLite to Postgres, in the middle of the rental high
season. The plan:

- a straight one-to-one move first, with multi-tenancy left for later;
- the new system run beside the old one, fed identical requests, with every response compared;
- writes frozen, a full dump and load, and row counts, checksums and invariants as a hard go/no-go;
- an atomic switch of traffic to the new system, with the old one kept frozen as an instant rollback.

Three models from different labs reviewed the plan before it ran. Afterwards, parallel agents and an
adversarial verifier audited the result. They found one bug, which was fixed. No bookings were lost.

## 10. Lessons become rules

When something goes wrong, the fix includes a written rule so it cannot recur: in the contract, a
hook, or a CI gate. The examples above come from that log: merge before deploy, one session per
working copy, late-assigned migration numbers, and gates that must prove they can fail.
