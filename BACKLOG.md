# Backlog

Keep this file short and actionable.

## Next

- [ ] Add more unit tests for redirect handling, fetch-size limiting, and Kagi response formatting.
- [ ] Evaluate a more robust readability/extraction approach.

## Later

- [ ] Revisit repo structure once the extension count grows enough to justify a multi-package workspace split.

## Done

- [x] Admit Kagi query bytes before progress/transport and bound progress query previews.

- [x] Total protocol byte/event admission and explicit late-fetch response body ownership.

- [x] Shared SDK-based external terminal text projection and status-only Kagi HTTP diagnostics.

- [x] Strict structural Kagi JSON admission and fatal UTF-8 agent-definition decoding.

- [x] Refuse ambiguous agent events and bound completed parallel details/answers across the workflow.

- [x] Preflight workflow input bytes and retire owned descendants after normal completion.

- [x] Admit exact safe-integer token counts, check aggregate count bounds and keep fractional monetary costs compatible.

- [x] Bind consumed event types to permitted message roles before retention/accounting and stop contradictory tool-result handoffs.

- [x] Coalesced bounded progress previews with complete final snapshots; finite dispatcher cleanup that preserves primary fetch outcomes.

- [x] Bounded regular-file definition admission with compatible symlinks; fail closed on malformed JSON wire output.

- [x] Bounded consumed protocol nesting and aggregate chain detail/handoff budgets.

- [x] Detached progress snapshots and truthful requested/selected/observed model provenance.

- [x] Strict UTF-8 Kagi response admission and credential-safe transport/body failures.

- [x] Finite aggregate agent usage and one bounded readable-output limit policy.

- [x] Offline `agent_workflow` test for a parallel-mode protocol failure in one agent, covering result order, per-agent errors and `renderResult` (collapsed and expanded).
- [x] One `kagi_search` limit policy (`normalizeKagiLimit` in `shared/kagi.ts`: round, clamp to 1–20) used by both the tool and `searchKagi`.
- [x] Single shared user-agent constant in `shared/http.ts`.
- [x] DNS TOCTOU in `web_content`: no longer a limitation. `shared/web.ts` validates DNS answers once per hop and pins the approved addresses to the connection (`resolveApprovedAddresses` plus the pinned lookup), covered by `tests/web.test.ts`.
