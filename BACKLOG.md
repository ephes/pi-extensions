# Backlog

Keep this file short and actionable.

## Next

- [ ] Add more unit tests for redirect handling, fetch-size limiting, and Kagi response formatting.
- [ ] Evaluate a more robust readability/extraction approach.

## Later

- [ ] Revisit repo structure once the extension count grows enough to justify a multi-package workspace split.

## Done

- [x] Strict UTF-8 Kagi response admission and credential-safe transport/body failures.

- [x] Finite aggregate agent usage and one bounded readable-output limit policy.

- [x] Offline `agent_workflow` test for a parallel-mode protocol failure in one agent, covering result order, per-agent errors and `renderResult` (collapsed and expanded).
- [x] One `kagi_search` limit policy (`normalizeKagiLimit` in `shared/kagi.ts`: round, clamp to 1–20) used by both the tool and `searchKagi`.
- [x] Single shared user-agent constant in `shared/http.ts`.
- [x] DNS TOCTOU in `web_content`: no longer a limitation. `shared/web.ts` validates DNS answers once per hop and pins the approved addresses to the connection (`resolveApprovedAddresses` plus the pinned lookup), covered by `tests/web.test.ts`.
