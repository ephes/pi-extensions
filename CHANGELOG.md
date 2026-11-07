# Changelog

## Unreleased

- Enforce Kagi result counts locally and bound retained rows, related searches and metadata; preserve complete useful URLs and report original/retained counts and truncation

- Block IPv6 site-local and private well-known NAT64 destinations before transport for literals and DNS answers; reject unsupported local-use NAT64 layouts

- Fail workflows safely when progress delivery throws: stop updates and queued tasks, terminate active process groups, and await child cleanup before removing prompts
- Omit URL credentials, queries and fragments from web progress, call previews, output URL labels and diagnostics; drop raw transport/body error chains while preserving full transport URLs and final result details
- Report source truncation only after observing bytes beyond the fetch limit; bound the EOF probe by the existing deadline and cancellation
- Render failed search and web calls as failures with bounded diagnostics, preserving empty-success and running displays

- Require a completed final assistant answer before reporting success or handing output to the next chain step
- Own POSIX subprocess groups and terminate descendants on cancellation/protocol failure, including escalation after direct-child close; reject unsupported Windows launches before preparation
- Isolate parallel preparation failures and await started siblings while continuing queued tasks in input order
- Align workflow success counts, summaries, rendering and tool error flags, including exit-zero provider failures and mixed batches
- Older saved workflow results without a final assistant stop status may now display as failed when session history is rendered again

- Audit production dependencies in CI at the high-severity threshold; fail on scanner/network errors and document remediation commands

- Dispatch web responses by Content-Type: extract HTML/XHTML, preserve plain text verbatim, and reject unsupported types before reading their bodies; missing headers retain HTML compatibility

- Migrate SDK imports, development dependencies and peers to `@earendil-works/pi-*` >=1.5.0 (1.x) and `typebox` >=1.3.27 (1.x); require Node >=22.19.0 and a matching maintained Pi host

- Require undici >=7.30.1 (7.x) to prevent process crashes on excessive response content encodings; cover early-close responses in an isolated child process

- Apply one Kagi result-limit policy in the tool and in `searchKagi`: round to an integer and clamp to 1–20 (previously the shared helper accepted up to 100 and neither path rounded); non-finite limits use the default of 10
- Share one user-agent constant between Kagi search and web fetching
- Test a parallel agent workflow where one agent fails the protocol while the others finish, covering result order, per-agent errors and collapsed/expanded rendering
- Close stale backlog items, including the DNS check-then-use item already solved by pinned DNS answers

- Validate consumed agent message envelopes, content blocks and supplied usage before retention; fail malformed messages and reap the child
- Preserve every final assistant text block in output and chain handoffs, joining blocks with a newline

- Test the packed publish layout through Pi’s public resource loader with lockfile-installed development peers for unique tool registration and bundled assets, with offline guards and missing-file regression fixtures

- Skip queued parallel agents after cancellation and report every task as completed or aborted; check cancellation before prompt creation and spawning

- Preserve literal prior output in every chained `{previous}` placeholder while retaining context truncation
- Isolate malformed bundled agent definitions with filename-only warnings, validate frontmatter types, and exclude all definitions with duplicate names

- Preserve split UTF-8 agent protocol characters and fail malformed or incomplete UTF-8
- Remove owned temporary prompt directories after failed writes, including partial files
- Bound agent protocol lines to 1 MiB, stderr tails to 64 KiB, and recent message details to 4 MiB / 256 entries; report truncation and reap children on protocol overflow

- Validate Kagi response envelopes, result and related-search fields while retaining extra fields and nullable optional scalars
- Limit Kagi success and error response bodies to 1 MiB of streamed bytes
- Apply a 30-second total Kagi search deadline with immediate caller cancellation and stream/timer cleanup, controlled error names and API-key redaction in HTTP diagnostics

- Canonicalize IPv6 addresses before web-fetch classification, blocking expanded loopback and equivalent private mapped forms in both literals and DNS answers

- Decode HTML entities in one pass with a maintained runtime decoder, preserving escaped literals and supporting named and numeric Unicode references in page titles and bodies

- Fix agent workflow cancellation escalation and listener/timer cleanup; fail signal-terminated or missing-exit-code runs and stop incomplete chain handoffs

- Bound web fetches to a 30-second total deadline across DNS, redirects and response bodies, with immediate caller cancellation and stream cleanup

- Pin validated web-fetch DNS addresses to each connection and redirect, preserving Host/TLS names and blocking private-address fallback; add Undici as a runtime dependency and document the required dependency install for local-path usage

- Add a GitHub Actions CI workflow (Node 22, `npm ci`, `npm run check`) with SHA-pinned actions, npm caching and read-only permissions
- Refresh vulnerable transitive dev dependencies in `package-lock.json` (clears the critical `protobufjs` advisory); the remaining advisories need a breaking `@mariozechner/pi-*` upgrade
- Rename the workflow tool from `subagent` to `agent_workflow` to reduce collisions and better match its orchestration role
- Add an `agent_workflow` extension with bundled `implementer` and `reviewer` agent definitions
- Add `/implement`, `/review`, and `/implement-and-review` prompt templates for bundled agent workflows
- Fix package extension discovery for installed Pi sessions by registering the conventional `./extensions` directory in the manifest
- Register package prompt templates through the Pi package manifest
- Add a bundled-agent discovery test for the `agent_workflow` extension
- Harden agent workflow subprocesses with `--no-extensions`, `--no-prompt-templates`, and `--no-skills`
- Truncate chained `{previous}` context before handing it to the next delegated agent step
- Add authenticated model fallback for `agent_workflow` subprocesses when bundled model IDs are unavailable
- Document bundled model ID assumptions and reviewer bash limitations
- Harden `web_content` against redirect-based SSRF
- Block IPv4-mapped IPv6 private and loopback addresses
- Enforce a streaming fetch-size limit before extraction
- Rename `kagi_content` to `web_content`
- Add initial unit tests for security-sensitive helpers
- Add a repository backlog for follow-up work
- Add `just` shorthands for linting, type-checking, tests, repo line counts, and aggregate checks
- Document repo guidance in `README.md` and `AGENTS.md`

## 0.1.0

- Scaffold initial Pi package structure
- Add `kagi_search` extension
- Add `kagi_content` extension
