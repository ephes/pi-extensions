# Changelog

## Unreleased

- Deduplicate Kagi related searches after shortening them for display so identical suggestions share one slot.
- Fit more Kagi results near the text cap by shortening optional snippets and continuing past rows that still cannot fit with a complete URL.

- Omit HTML elements marked `hidden` and their descendants from readable `web_content` text.
- Preserve indentation, spacing and blank lines in HTML preformatted blocks in `web_content`. Block children, table cells and media inside them stay separated, and whitespace-only blocks are dropped.
- Use the HTML head title only as the `web_content` heading. Pages with no readable body text return the existing extraction error.
- Preserve words split by HTML comment markers in `web_content`.
- Expand self-closing XHTML tags with Unicode or punctuation in their names so `web_content` retains the following readable content.
- Preserve literal XHTML CDATA at SVG and MathML integration points while expanding later HTML tags in `web_content`.
- Preserve slashes at the end of unquoted attribute values when expanding self-closing XHTML tags in `web_content`.
- Preserve native SVG and MathML self-closing tags in XHTML responses while expanding non-void self-closing tags in HTML context.

- Return a timeout when Kagi response parsing or validation uses up the search deadline before results can be delivered.
- Return a timeout when readable content extraction uses up the `web_content` deadline before the page can be delivered.

- Recognize quoted attribute values when closing self-closing XHTML elements in `web_content`, and leave comments, processing instructions, declarations and the content of text-only elements such as `<script>` and `<style>` unchanged, ending each where the HTML parser ends it.
- Preserve words and numbers across inline formatting in `web_content` while keeping readable boundaries around blocks, breaks, table cells, form controls, embedded media and removed content.

- Cap complete Kagi search text at 24,000 UTF-16 code units, reserving space for the query label, related searches, and truncation notice while preserving whole result rows.
- Keep the first occurrence of each exact Kagi related term before applying the retained count, with duplicates still included in the original count.

- Reject empty or whitespace-only Kagi queries before credential lookup or network setup in both the tool and the shared search helper.

- Derive the `web_content` heading from the parsed document head so title-like markup in comments, scripts or the body cannot replace it. XHTML responses close self-closing non-void elements before parsing.

- Count every Kagi related-search term while collecting only the retained prefix.
- Preserve complete Unicode characters when clipping `web_content` terminal previews.

- Return a tool error for missing or mixed agent workflow modes before creating prompts or launching delegates.
- Size bundled definition read buffers to the admitted file length and remaining discovery budget, with one extra byte to detect growth or overflow.
- Preserve the bundled definition discovery limit refusal if closing a file or directory also fails, discarding the entire inventory.

- Reject Kagi queries with unpaired surrogates before progress or request URL construction.
- Reject already cancelled web fetches with the original abort reason before starting the deadline.
- Fail Web and Kagi response reads after 256 consecutive empty chunks with a fixed retry diagnostic and cancel the incomplete body.
- Clip agent workflow chain handoffs at Unicode scalar boundaries within the shared UTF-16 allowance.
- Reject unpaired surrogates in submitted workflow task text, agent names and working-directory labels before staging prompts.
- Report already cancelled Kagi calls as `AbortError` before checking credentials or starting the deadline.
- Honor cancellation and the deadline during web dispatcher cleanup while preserving earlier fetch failures.
- Decode readable web responses using their supported Content-Type charset, with UTF-8 as the fallback.
- Preserve Kagi search outcomes when body cancellation or reader release fails.
- Require HTTP 200 without Content-Range for Kagi searches and cancel refused response bodies unread.
- Stop late Kagi body reads after cancellation or deadline expiry and skip JSON validation for cancelled responses.
- Decode Kagi responses as they stream and consolidate tiny text fragments to reduce memory use.
- Require HTTP 200 without Content-Range for readable web fetches and cancel refused response bodies unread.
- Keep readable content free of replacement characters caused by cutting a UTF-8 character at the source-byte limit.
- Clip `web_content` at a Unicode scalar boundary within its UTF-16 output limit and report the actual retained length.
- Apply the Kagi result limit to retained rows so later usable hits can fill slots left by oversized URLs. Report omitted hits as truncated.

- Emit Kagi publication metadata only as validated UTC calendar dates in years 0000–9999; omit malformed, impossible or unsupported dates instead of echoing provider text or slicing extended years.

- Admit Kagi queries up to 8,192 UTF-8 bytes before trimming, progress or URL construction; bound progress query previews to 512 characters while preserving the full admitted search text for requests. Clipped query labels, titles, snippets, related searches and metadata never end in a split surrogate pair.

- Pin the bundled reviewer to authenticated `openai-codex/gpt-6.2-sol` and refuse missing, unapproved or unavailable review models before prompt creation/launch, including whole chains and parallel batches that contain the reviewer; preserve generic implementer fallback.

- Reject agent definitions changed during reading using descriptor generation, consumed length and final named identity, while preserving stable intentional links and discovery budgets.

- Enforce the eight-task parallel ceiling in the schema and before discovery/input preparation; oversized batches return one bounded error and no task results.

- Bound each delegate’s total protocol work to 64 MiB stdout and 65,536 nonblank events, including ignored events; refuse exhaustion after earlier answers and retire the owned process before prompt cleanup.
- Cancel response bodies delivered by noncooperative fetches after cancellation or deadline, observing cleanup failures while preserving the primary outcome.

- Project external web, Kagi and workflow display text through public Pi TUI safe-text helpers before styling, preserving structured content, visible Unicode, tabs and line breaks.
- Exclude upstream Kagi HTTP error bodies from diagnostics; cancel them unread and report the status with a fixed service/access retry hint.

- Validate all Kagi result URLs as absolute HTTP(S) without credentials before retention; refuse malformed response evidence without disclosing the URL or fetching destinations.
- Cover real two-step workflow handoffs with offline IPC process journeys: bounded literal context, previous descendant retirement before launch, and prompt/group cleanup on success and cancellation.

- Refuse chains above 32 steps before prompt creation or process launch, preserving ordered execution and bounded literal handoffs at the limit.
- Iterate bundled definitions with the public directory API; refuse the entire discovery above 256 entries or 4 MiB actual reads with one safe diagnostic and descriptor cleanup.

- Decode bounded agent-definition bytes with fatal UTF-8 validation, isolating invalid files through existing filename-only diagnostics.

- Share parallel history/task/stderr retention budgets, retain all task outcomes and independent answers within a shared 1 MiB output allowance, and disclose answer/metadata omissions.

- Admit task input before preparation (1 MiB per task, 4 MiB per workflow including system prompts/labels); retire owned descendants on successful exit as well as failures, retaining answers and reporting unconfirmed cleanup. A transient EPERM from macOS while only zombies of the group remain no longer fails a successful run; a persistent EPERM still does.

- Require nonnegative safe-integer token counts and exact aggregate counts before retaining assistant messages; keep fractional finite costs and provider metadata, and diagnose unsafe display totals across agents.

- Reject assistant/user messages in `tool_result_end` before retention or accounting, stopping chained handoffs even after an earlier completed answer; preserve tool-result messages in both consumed event forms.

- Coalesce intermediate workflow progress at 100 ms and project bounded previews before cloning; flush complete final results and preserve observer-failure/cancellation cleanup.
- Bound web dispatcher destruction to 100 ms, stop waiting on cancellation, and preserve primary fetch outcomes without exposing cleanup errors or leaving late rejections unobserved.

- Admit bundled definitions through bounded regular-file descriptors (256 KiB), preserving regular-file symlinks and refusing FIFO targets without blocking discovery.
- Fail and reap agent subprocesses on malformed or incomplete JSON stdout, including corruption after a completed answer; keep raw protocol lines out of diagnostics.

- Reject explicit empty or unknown bundled-agent tool policies instead of falling back to default capabilities; retain omitted-field defaults and exact built-in allowlists.
- Verify against Pi’s own `@file` processing that the delegated task file becomes the exact `Task: …` initial message, and report agent input file write failures as “Unable to create agent input files.”
- Pass delegated tasks through private temporary files using Pi’s public file input, keeping large and private task text out of process arguments while preserving literal text and existing cleanup and chain limits.

- Reject deeply nested consumed protocol messages before serialization; share message/task/stderr retention budgets across chain steps and cap repeated handoff substitutions with omission metadata.

- Detach workflow progress snapshots and distinguish requested, selected and assistant-reported model provenance with bounded mismatch warnings.

- Reject malformed UTF-8 Kagi responses and keep transport/body-read diagnostics credential-safe.

- Reject overflowing aggregate agent usage and share a finite integer readable-output limit policy between helper and tool.

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
