# Tasks

## Review backlog — PR #64 (out-of-scope polish)

Deferred from dev-review-cycle on 2026-04-17. Cross-feed ingestion is shipping; these are quality-of-life improvements for the multi-feed path.

- [ ] **Harness: Gemini review script fails on macOS** — `kadragon-tools:dev-review-cycle/scripts/gemini-review.sh` uses GNU `timeout`, which is absent by default on macOS. Not a repo issue, but skipped Gemini's review on this cycle. Either install `coreutils` locally or patch the script upstream (`gtimeout`/`perl -e alarm`). *(deferred: `dev-review-cycle` skill and `gemini-review.sh` no longer exist in the plugin cache — verified 2026-08-02)*

## Review backlog — watermark cap (PR #94, 2026-08-02)

Out of scope for the watermark-cap fix; both need an additive schema change or a one-off migration.

- [ ] **index.ts:335 — a permanently failing item pins the feed watermark forever** — the cap has no attempt counter or give-up path, so an item the AI never parses is retried on every run and the watermark never passes it. PR #94 only made the stall observable (`console.warn`). Fix: persist a per-item consecutive-failure count (additive `meta` key or table) and let the watermark move past an item after N failures, logging it as permanently skipped.
- [ ] **state.ts — no recovery for watermarks that already passed a failed item** — on a database written by the pre-PR-#94 code, the watermark may already sit above an item that failed, and `updateMaxProcessedId` only accepts larger values, so that item stays skipped forever. No record of which historical items failed exists, so recovery means either a one-off rewind or backfilling from `processed_items` gaps. Decide whether it is worth the re-processing cost before implementing.
