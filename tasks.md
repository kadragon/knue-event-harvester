# Tasks

## Review backlog — PR #64 (out-of-scope polish)

Deferred from dev-review-cycle on 2026-04-17. Cross-feed ingestion is shipping; these are quality-of-life improvements for the multi-feed path.

- [ ] **Harness: Gemini review script fails on macOS** — `kadragon-tools:dev-review-cycle/scripts/gemini-review.sh` uses GNU `timeout`, which is absent by default on macOS. Not a repo issue, but skipped Gemini's review on this cycle. Either install `coreutils` locally or patch the script upstream (`gtimeout`/`perl -e alarm`).

## Review backlog — PR #76 (out-of-scope polish)

Deferred from dev-review-cycle on 2026-05-23. Refactor stage-pipeline improvements; these are quality-of-life polish not introduced by the PR.

- [ ] **transforms.ts:33 — fail-open comment** — `isWithinLastWeek` catch returns `true` with no explanation. Add one-line `// fail-open: process if date unparseable` comment.
- [ ] **transforms.ts:60 — formatDateForDisplay input validation** — no guard for empty/malformed strings. Pre-existing; now a public API. Add regex assertion or accept `Date` type.
- [ ] **index.ts:218 — distinguish AI error vs. no events** — `eventInputs.length === 0` fires for both Ollama failure and genuine "no events". Consider a typed result from `enrichItem` to separate the two paths and log accordingly.
