# Tasks

## Review backlog — PR #64 (out-of-scope polish)

Deferred from dev-review-cycle on 2026-04-17. Cross-feed ingestion is shipping; these are quality-of-life improvements for the multi-feed path.

- [ ] **Harness: Gemini review script fails on macOS** — `kadragon-tools:dev-review-cycle/scripts/gemini-review.sh` uses GNU `timeout`, which is absent by default on macOS. Not a repo issue, but skipped Gemini's review on this cycle. Either install `coreutils` locally or patch the script upstream (`gtimeout`/`perl -e alarm`).

## Review backlog — AI failure handling (2026-08-02)

Found while fixing the parse-failure/no-events ambiguity. Out of scope for that sprint.

- [ ] **index.ts:282,312-322 — a failed item can still be skipped forever** — `maxSuccessfulId` is a max over *successful* items, not a stop-at-first-failure watermark. When an item throws (transport error or `AiResponseParseError`) but a newer item in the same feed succeeds, the watermark advances past the failed item, and `index.ts:286-290` skips it on the next run. So "throws → retried next run" only holds when the failed item is the newest. Pre-existing; predates the parse-failure work. Fix likely means tracking the lowest failed id and capping the watermark below it.
