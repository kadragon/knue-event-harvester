# Tasks

## Review backlog — PR #64 (out-of-scope polish)

Deferred from dev-review-cycle on 2026-04-17. Cross-feed ingestion is shipping; these are quality-of-life improvements for the multi-feed path.

- [ ] **Harness: Gemini review script fails on macOS** — `kadragon-tools:dev-review-cycle/scripts/gemini-review.sh` uses GNU `timeout`, which is absent by default on macOS. Not a repo issue, but skipped Gemini's review on this cycle. Either install `coreutils` locally or patch the script upstream (`gtimeout`/`perl -e alarm`).

## Review backlog — PR #76 (out-of-scope polish)

Deferred from dev-review-cycle on 2026-05-23. Refactor stage-pipeline improvements; these are quality-of-life polish not introduced by the PR.

- [ ] **index.ts:218 — distinguish AI error vs. no events** — `eventInputs.length === 0` fires for both Ollama failure and genuine "no events". Scoped out of the 2026-07 polish pass: fixing this properly means changing `generateEventInfos`'s return type (e.g. `{ events, parseFailed }`), which ~10 unit tests in `test/lib/ai.test.ts` plus mocks in `test/index.integration.test.ts`/`test/index.test.ts` assert as a plain array — a real API change, not a small polish edit. Needs its own sprint with test updates in scope.
