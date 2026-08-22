# Git Governance — Local Deployment Operating Rules

**Scope**: this document governs how *this specific local checkout* of
gbrain (`/Users/lab/AI_Workspace/gbrain`) is operated — remote roles,
branch roles, commit timing, and the upstream-sync workflow. It applies to
any agent working in this checkout — Claude Code, Codex, a Hermes instance,
or a human — equally; nothing here is tool-specific. This is **not**
upstream contribution guidance (see `AGENTS.md` / `CLAUDE.md` for that —
including the "Conductor branch-name = workspace-name" rule, which is
garrytan's own contributor workflow for pushing to `origin` and unrelated
to the origin/fork boundary this document is about).

This is the second implementation of Universal Git Governance — the first
was `/Users/lab/.hermes/hermes-agent` (commit
`35d37c000468dd5fdffb43d41c2e14bd64c8bfad`), built after a local-reset
incident stranded 6 unmerged commits there, recoverable only via reflog
before `git gc`. The hook logic (`.githooks/`) is ported from that repo
essentially verbatim; only branch names and remote roles differ, and are
factored out into `.git-governance/profile.conf` rather than hardcoded, so
future repos need less rewriting than this one did.

## Why this matters here specifically

This repo already had its own version of the "local git state silently
reaches production" problem — see `docs/PRODUCTION-DEPLOYMENT.md`: the
production `com.user.gbrain` service used to run `bun` directly against
this working tree, so an uncommitted stash in a session broke the live
ChatGPT Connector's `/mcp-v2` route until the stash was restored. That was
fixed at the *deployment* layer (a versioned-release pipeline —
`/Users/lab/AI_Production/gbrain/releases/<timestamp>-<sha>/`, promoted
explicitly via `scripts/release/deploy.sh`, decoupled from this working
tree). This document and its hooks are the analogous fix at the *git*
layer: they don't touch deployment at all, they stop *local commits*
(as opposed to uncommitted edits) from becoming unrecoverable.

At the point this was set up, local `master` here was **27 commits ahead**
of `origin/master` with no backup anywhere but this one machine, and 6
`phase9b-*` branches (verification snapshots from an internal review, now
static/historical) were in the same position. All of that is now pushed to
`fork` — see the repo's git log for the exact commit that did this.

## Remote roles

| remote | role |
|---|---|
| `origin` | Official upstream (`garrytan/gbrain`), a third-party project. **Fetch only** — this account has read-only access there in any case, but `remote.origin.pushurl` is additionally set to a deliberately invalid value, and `.githooks/pre-push` independently refuses any push whose remote name or URL resolves to origin. `remote.pushDefault=fork` means a bare `git push` never targets it by accident either. |
| `fork` | Personal writable remote (`donfan2323/gbrain`). All local work gets backed up here. Not used to open PRs against upstream unless that's a deliberate, separate decision. |

## Branch roles

| branch pattern | role | rules |
|---|---|---|
| `master` | The branch this repo already treats as primary. **Not** a pure upstream mirror the way Hermes's `main` is — it currently carries local-only history (see "Why this matters here" above) and there is no separate `production/*`/`integration/*` convention here, because this repo's production runtime does not read this working tree directly (see `docs/PRODUCTION-DEPLOYMENT.md`). Protected: non-fast-forward moves or deletions are refused unless the old tip is already reachable elsewhere. | Ordinary local commits and merges from upstream are fine; just don't `reset --hard` it backward without protecting whatever it's about to lose first. |
| `rescue/*` | Holds commits that would otherwise be reachable from nowhere else. `rescue/local-master-20260820` specifically holds the 27-commit local `master` history from before this repo's `origin/master` tracking ref was refreshed to the current, further-advanced upstream — kept separate from `master` itself rather than force-merged, since reconciling it is a real judgment call, not a mechanical one. | Never delete a `rescue/*` branch while it's the only ref keeping some commit reachable — `.githooks/reference-transaction` checks this on every update, but treat it as a backstop, not permission to be careless. |
| `phase9b-*` | Historical verification-run snapshots from an internal review (see their own commit messages). Static — not part of ongoing protected-branch coverage (`.git-governance/profile.conf` only protects `master` and `rescue/*`), but now backed up to `fork` alongside everything else. If any of these need active protection going forward, that's a deliberate rename into `rescue/*`, not something this rollout did automatically (branches are never renamed without being asked). |
| anything else (feature work, `phase-scratch/*`, etc.) | Normal day-to-day work. | No special protection; use like any other branch. |

## Commit policy (for agents and humans)

Same policy as the Hermes implementation, restated here rather than just
linked so this file is self-contained per-repo:

1. Know your baseline before you start — note current branch/HEAD, or run
   `scripts/git_safe_checkpoint.sh`, before making changes.
2. Don't mix unrelated changes into one commit — `git add` the specific
   files for your change, not `-A`.
3. Commit at the level of one logical feature/fix: describable in one
   sentence without "and" joining unrelated concerns, rollback-able on its
   own, tests passing at that commit.
4. Don't let a dirty tree sit for hours — checkpoint or explicitly note
   why it's still in progress.
5. Never commit secrets or generated runtime data. This repo already has
   `scripts/check-privacy.sh`, `scripts/check-proposal-pii.sh`, and
   related `check:all` scripts — running those still applies; this
   document doesn't replace them.
6. Push only to `fork`, explicitly: `git push fork <branch>`. Never
   `git push origin ...`, and be wary of a bare `git push` if unsure what
   `pushDefault` resolves to.
7. Never commit directly onto `master` for work-in-progress that isn't
   ready to be there — use a feature branch, same as any other repo.

## Hard protection — what's actually enforced, and what isn't

- **`.githooks/pre-push`** *can* and *does* block: any push to `origin`
  (by remote name or by URL), and any force-push (non-fast-forward) to
  `master` or `rescue/*`, on any remote. Real, exit-code-enforced — with
  the caveat that any client-side hook, this one included, can be skipped
  with `git push --no-verify`. It's a guardrail against mistakes, not a
  security boundary against a deliberate bypass. `origin`'s disabled push
  URL is a separate, independent layer unaffected by `--no-verify`.
- **`.githooks/reference-transaction`** *can* block, and does, for
  `master` and `rescue/*`. Per `git help hooks`, a non-zero exit in the
  "prepared" state aborts the transaction — verified empirically (not
  assumed) in Hermes before this was relied on there, and the logic here
  is unchanged. `git reset --hard`, `git branch -f`, `git branch -D`, and
  `git update-ref` (all forms) each fail outright with the target ref's
  SHA unchanged when they'd strand an unprotected commit.
- It does **not** create a rescue ref itself as a side effect — see the
  Hermes implementation's rationale (nested-reference-transaction safety);
  the refusal message names the exact `git branch rescue/<name> <sha>`
  command instead.
- Neither hook affects `scripts/release/*` or the production deploy
  pipeline at all — those operate on `/Users/lab/AI_Production/gbrain/`,
  not this working tree, and this rollout does not touch them.
- Both hooks only run when `core.hooksPath=.githooks` is set (repo-local —
  confirmed set for this checkout, not global, so it can't affect any
  other repository on this machine).

## RULE-8.K-1 — Controlled Exception Record

At rollout time (2026-08-20) there was no RULE-8-aware exception for this
repo — CONSTITUTION.md RULE-8.K had already been in effect since
2026-08-10, and the governance commit did not reference it. That gap was
undocumented **policy drift**, not a documented exception. This section,
added 2026-08-22, retroactively formalizes that rollout under RULE-8.K-1
(added the same day) on the basis of the evidence below — it does not
claim a formal exception existed at the time.

**1. Warn-only materially insufficient** — at rollout time, local
`master` was 27 commits ahead of `origin/master` with no backup anywhere
but this machine, plus 6 `phase9b-*` branches in the same position: a
standing, present-tense exposure, not a past or hypothetical one. A
warn-only/observation window leaves that exposure live throughout — any
ordinary `reset --hard`, `branch -D`, or force-push during that window
would realize the same largely-irreversible loss pattern already proven
concrete at Hermes days earlier, on the same operator's machine. Warn-only
periods exist to catch false positives in unproven detection logic before
it blocks real work; that logic was not unproven here — it is ported
verbatim from Hermes's already isolated-clone-verified implementation —
so there was materially less to gain from observing it, while every day
of delay left the 27+6 exposure live for no offsetting benefit.

**2. Scope limited** — the exception covers exactly two hooks:
`.githooks/reference-transaction` and `.githooks/pre-push`. Protected
refs: `refs/heads/master`, `refs/heads/rescue/*`. Remote scope: blocks
push to `origin` (garrytan/gbrain, by name or URL) and any force-push to
the protected patterns on any remote. This exception does not extend to
other repos, other hooks, or any future enforcement mechanism in this
repo — each would need its own K-1 record.

**3. Isolated pre-deployment verification** — commit
`844559531e45a4e3f308a3c106d65e90bd02ab9d` records empirical testing of
`git reset --hard`, `git branch -f`, `git branch -D`, and `git
update-ref` against isolated clones, not this checkout, before the hooks
were relied on; the hook logic itself is unchanged from Hermes's
already-verified implementation (see Hermes's own `docs/GIT_GOVERNANCE.md`
RULE-8.K-1 record), with only `.git-governance/profile.conf` values
changed for this repo.

**4. Production impact assessed** — production `com.user.gbrain` runs
from a fully decoupled, immutable release directory
(`/Users/lab/AI_Production/gbrain/releases/<timestamp>-<sha>/`, no
`.git`), promoted via a separate deploy step. There is no direct runtime
path or coupling from this working tree's git state to the running
service, and the hooks' own execution — blocking or allowing a git
operation — cannot itself modify or break the running service; they only
run during this checkout's git plumbing operations. The residual risk is
indirect and operational, not a runtime-mutation risk: if the hooks
wrongly block a legitimate commit, push, or force-push, that delays the
corresponding release-preparation step and, transitively, the next
deploy — the same category of cost as any CI gate, not a
production-safety risk.

**5. Explicit RULE-8.K deviation declaration** — both hooks went from
nonexistent to fully enforcing in one atomic commit, with no non-blocking
window at all — a stricter case than Hermes's. Evidence for conditions
1–4 above is this section and the commit it cites.

**6. Observability in lieu of a warn-only phase** — both hooks print the
specific blocked operation and the reason to stderr at the moment of
refusal (see "Hard protection" above); there is no persisted audit log
beyond that.

**7. Reassessment** — by **2026-09-19** (30 days from the 2026-08-20
rollout), or sooner if this repo's git governance is next touched, or if
RULE-8 is revised again.

## Upstream update workflow

1. `git fetch origin`
2. Reconcile `master` with the new `origin/master` — this repo's `master`
   already carries local-only commits (unlike Hermes's `main`), so this is
   a real merge/rebase judgment call each time, not a mechanical
   fast-forward. Protect whatever's at risk first
   (`git branch rescue/<description> <sha>`) if there's any doubt.
3. Run this repo's own test/check suite (`bun run check:all`, the relevant
   `test`/`heavy-tests`/`e2e` workflows) before anything gets near
   `master`.
4. Deployment is a **separate, deliberate** step via
   `scripts/release/*` — never implied by a git operation. See
   `docs/PRODUCTION-DEPLOYMENT.md` for that pipeline; this document stops
   at the git layer.
5. Push whatever moved to `fork`.

## Rescue procedure (if the hook was bypassed, or isn't active)

1. `git reflog` on the affected branch (or `git fsck --unreachable` /
   `--dangling` if the reflog has expired) to find the stranded tip.
2. `git branch rescue/<description>-<date> <sha>` — plain ref creation,
   fully reversible.
3. `git push fork rescue/<description>-<date>` immediately — a local-only
   ref is a single-machine single-point-of-failure.
4. Follow the upstream update workflow above to reconcile from there.

## Known limitations

- `reference-transaction` can't stop a deliberate bypass (direct `.git/`
  filesystem edits, `git -c core.hooksPath=/dev/null ...`). The policy in
  this document, not the hook, is what's actually relied on against that;
  the hook is what makes an *accidental* repeat of the incident require
  deliberate effort instead of one ordinary command.
- `pre-push` can be skipped with `--no-verify` — git's own documented
  escape hatch, not a bug here.
- Reachability checks only consider this local repo's refs (`refs/heads`,
  `refs/remotes/fork`, `refs/tags`) — not other clones or forks.
- These hooks are not installed by `git clone` — `core.hooksPath` must be
  set per-checkout (`git config core.hooksPath .githooks`).
- Several stale worktree registrations under
  `/private/tmp/claude-501/.../scratchpad/phase9b-*` (from past sessions)
  showed as `prunable` in `git worktree list` at the time this was set up.
  Left untouched by this rollout — worktree cleanup was explicitly out of
  scope; run `git worktree prune` separately if desired.
