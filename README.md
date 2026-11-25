# pi-extensions

A monorepo of Pi extensions that adds reusable tools for search, web access, and agent workflows.

## Install

### Local path

Use Node 22.19.0 or newer and Pi 1.5.0 or newer in the 1.x series
(`@earendil-works/pi-coding-agent`). The retired `@mariozechner/pi-*` packages
are no longer supported. Update the Pi host and this extension together; the SDK
peers now use `@earendil-works/pi-*` >=1.5.0 and `typebox` >=1.3.27 (1.x).
For an npm-installed host, run `npm install -g @earendil-works/pi-coding-agent@^1.5.0`. Install runtime dependencies in the checkout before registering it with Pi; local-path installation does not install them automatically.

```bash
cd <path-to-pi-extensions>
npm install --omit=dev
pi install <path-to-pi-extensions>
```

### Git

```bash
pi install git:github.com/jochen/pi-extensions
```

## Current extensions

- `kagi_search` — search the web with the official Kagi Search API
- `web_content` — fetch and extract readable page content from a URL
- `agent_workflow` — run bundled specialist agent workflows with isolated context

## Bundled agents and prompts

Bundled agents live in `agents/`:

- `implementer` — implementation specialist with `read`, `bash`, `edit`, and `write`
- `reviewer` — review specialist with `read`, `grep`, `find`, `ls`, and read-only git bash usage

Bundled prompt templates live in `prompts/` and are registered through the Pi package manifest:

- `/implement` — implement with the bundled implementer
- `/review` — review the current diff with the bundled reviewer
- `/implement-and-review` — implement, review, then apply feedback in a chain

Agent definitions use YAML frontmatter with required non-blank string `name` and
`description` fields. Optional `tools` is a comma-separated string (for example,
`read, bash`), and optional `model` is a string model ID. Tool names must be
explicit built-ins: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`,
and `ls`. Empty, whitespace/commas-only, unknown, wildcard and additive tool
policies are invalid and cannot launch an agent. Omitted `tools` uses Pi defaults.
Omit optional fields instead of setting them to YAML lists, booleans, numbers, or null. The Markdown
body supplies the system prompt; extra frontmatter fields are ignored. Invalid
or unreadable definitions are skipped with filename-only warnings, and all
otherwise valid definitions sharing an exact, case-sensitive name are excluded
with filename-only warnings so no ambiguous agent can be invoked. Discovery
warnings are included in each tool result and its display, without raw stderr
writes.
Definition bytes must be valid UTF-8; malformed or incomplete sequences are rejected without replacement decoding, with the same filename-only warning. Valid multibyte names, model IDs and prompts are preserved.
Definitions are accepted only when consumed length and descriptor identity, size,
mtime and ctime remain unchanged across the read and a final pathname check
still resolves to that generation. In-place edits, truncation and replacement
(including symlink retargeting) are isolated as invalid definitions.
Definitions must resolve to regular files of at most 256 KiB. Each read buffer
is sized to the opened file length or remaining discovery byte budget, whichever
is smaller, plus one byte to detect growth or overflow. Symlinks to regular files
remain supported, including targets outside `agents/`. The opened descriptor
is used to refuse directories, devices and FIFOs. Opening uses nonblocking mode
so a FIFO target cannot stall discovery. Each invalid file gets the same
filename-only warning and does not hide other valid agents within an admitted
discovery generation.
Discovery iterates with Node's public directory API and admits at most 256
entries (including unrelated files/directories) and 4 MiB of actual definition
reads in total, including invalid definitions. At most one extra byte is read
to detect aggregate overflow. Both ceilings are inclusive. Overflow or an
iterator error discards every agent and per-file warning from that generation
and returns one fixed diagnostic; no partial allowlist can launch a delegate.
Discovery attempts to close file and directory descriptors on success and
refusal. If either close fails during a limit refusal, discovery still reports
the fixed limit diagnostic. A directory close failure on its own discards the
inventory with the fixed directory failure diagnostic.

Bundled agent frontmatter uses these model IDs:

- `implementer` — `openai/gpt-5.4`
- `reviewer` — `openai-codex/gpt-6.2-sol` (required)

The bundled `reviewer` requires the exact provider-qualified model above in its
frontmatter and Pi's authenticated model list. Authenticate `openai-codex` via
`/login` and ensure `gpt-6.2-sol` is available before using `/review` or a chain
containing the reviewer. Missing, bare or different configured models, and an
unavailable approved model, fail before review prompt files or children are
created. Chains and parallel batches containing the reviewer are refused as a
whole before any step or task launches. The reviewer never falls back to another
model or provider.

For the implementer and other agents, an unavailable configured model falls back in this order:

1. the current Pi session model, when it is authenticated
2. the first authenticated model returned by Pi

If no authenticated Pi models are available at all, the delegated run fails early with a clear `/login` or API key hint.

Result provenance separates `requestedModel` (agent frontmatter), `selectedModel`
(the resolved CLI model), and `observedModel` (the latest nonempty model reported
by an assistant event). `model` uses the latest observation, falling back to the
selected model until an observation arrives. Missing observations do not erase
prior ones. Provider-qualified selections also match their bare model ID. A
reported mismatch adds one bounded warning; it never changes model selection.

For agents other than the reviewer, edit the frontmatter in `agents/*.md` to prefer a model available in your environment; their fallback policy still applies.

## Requirements

### Kagi search

Set a Kagi API key for `kagi_search`:

```bash
export KAGI_API_KEY="your-api-key"
```

The `limit` parameter accepts 1–20 results (default 10). One shared policy rounds it to the nearest integer and clamps it to that range, and non-finite values fall back to the default. The tool also caps retained rows at this count. It scans results in API order, skips rows with oversized URLs, and stops when the count is reached or the next usable row exceeds the remaining text budget. Each omitted row contributes to the truncation flag.

Queries must contain only Unicode scalar values and fit within 8,192 UTF-8
bytes, including surrounding whitespace. The tool and shared `searchKagi`
helper validate the submitted text before trimming. Both reject empty or
whitespace-only queries before credential lookup or network setup. The tool
also checks the query before reporting progress. Kagi receives the complete
trimmed query. Progress text and details retain
only a 512-character query preview (including an ellipsis when shortened),
without splitting surrogate pairs. The final query label and every other
clipped field (titles, snippets, related searches, metadata) use the same
surrogate-safe shortening.

The complete search text fits within 24,000 JavaScript UTF-16 code units. The tool budgets the query label, related searches, separators, and space for the truncation notice before retaining whole result rows. Titles are capped at 512 characters and snippets at 2,048. Publication dates use only validated `YYYY-MM-DD` values as described below. URLs stay complete; rows with URLs longer than 2,048 characters are omitted. It keeps at most 10 related searches of 128 characters each and a 512-character query label. Details contain only retained URLs/counts and supported metadata (`id`/`node` capped at 256 characters, plus `ms`/`api_balance`); arbitrary metadata fields are omitted. `resultCount` and `relatedCount` describe retained entries, `originalResultCount` and `originalRelatedCount` describe the API response, and `truncated` plus an output notice identify omitted rows, clipped text or metadata. Fewer than `limit` results may fit. An empty search still reports “No results found”; if all returned rows exceed the output limits, the tool reports that no results were retained. Related-only responses keep the empty-search message with zero retained related entries.

The original related-search count includes duplicates across all response rows.
When at least one result URL is retained, the tool keeps the first ten distinct
terms in API order. It compares exact terms before shortening them for display
and reports skipped duplicates as truncation.

`Published` metadata accepts Unix seconds (including fractional seconds), strict
ISO calendar dates (`YYYY-MM-DD`), or explicit-zone ISO timestamps
(`YYYY-MM-DDTHH:mm:ss[.SSS]Z` or an `±HH:mm` offset, with 1–3 fractional digits).
Calendar days and clock/offset fields must be valid; timestamps are converted to
UTC. Only UTC years 0000–9999 are supported. Malformed, impossible, ambiguous or
extended-year dates, including offsets crossing that supported range, omit the
`Published` line while preserving the result. Provider text is never substituted
or clipped into date evidence; the shared response helper still retains the raw
optional field after validating its scalar type.

Kagi searches have a 30-second total deadline covering headers and body reads; caller cancellation is immediate. Success and error responses are limited to 1 MiB of streamed bytes, regardless of Content-Length. Timeout errors invite a retry (`TimeoutError`); cancellation uses `AbortError` with a controlled message. HTTP error diagnostics include only the status and a fixed service/access retry hint; upstream error body text is never copied into diagnostics. Transport and body-read failures use bounded categories without upstream messages or causes. Successful responses require valid UTF-8 before JSON admission; malformed bytes publish no search results. HTTP error bodies are cancelled unread, so stalled, oversized or malformed error bodies cannot hide the status.

If the caller's signal is already aborted, `searchKagi` returns `AbortError`
before validating the query, reading `KAGI_API_KEY`, or starting the deadline.

Kagi search accepts only HTTP 200 responses without a Content-Range header.
Other successful statuses and any Content-Range header cause the body to be
cancelled unread and the search to fail before returning results.

Successful Kagi bodies are decoded as they stream. The decoder preserves UTF-8
characters split across reads and rejects incomplete sequences at EOF. Small
decoded fragments are consolidated during reading to limit buffering overhead.
Kagi and web response bodies allow up to 256 consecutive empty reads. A
read with bytes resets that count. Exceeding the limit fails the request with
a fixed retry diagnostic and cancels the incomplete body.
Cancellation or deadline expiry stops late body reads before further decoding
and prevents the cancelled response from reaching JSON validation. Body
cancellation and reader release are best effort. Cleanup failures preserve the
original search outcome, and pending cancellation cleanup does not delay it.

All three extensions project external terminal text through Pi TUI’s public `stripTerminalSequences` and `replaceControlCharacters` helpers before application styling or Markdown rendering. Remote titles/snippets, call previews and delegate labels, diagnostics, tool arguments and answers cannot supply terminal controls. Visible Unicode, tabs and line breaks are preserved; tool content and structured details retain their original values.

Search and web result displays mark failed calls as failures with bounded diagnostics; an empty successful search remains “0 results”. Partial results retain their running status.

Successful response JSON must have unique decoded member names and finite
decoded numbers. Decoded names and string values must contain only Unicode
scalar values, including in optional extension fields. Each response admits
up to 64 container levels, 16,384 objects/arrays, 16,384 object members, and
16,384 array elements across all arrays. These limits apply before native JSON
decoding. Duplicate keys (including escaped aliases), unpaired surrogates, numeric or structural overflow, comments, trailing commas and malformed JSON yield one fixed safe parsing diagnostic before results are returned or rendered. Valid optional extension fields remain available within this envelope.

The response must contain a `data` array of result items (`t: 0`, string `url` and `title`, optional string `snippet` and string or finite numeric `published`) or related-search items (`t: 1`, string-only `list`). Optional result and metadata scalars may also be `null` for absent values. Optional metadata must be an object with string `id`/`node` and finite numeric `ms`/`api_balance` when supplied. The shared `searchKagi` helper retains unknown extra fields after validation; the tool projects bounded metadata as described above. Unsupported item types and malformed fields fail with a controlled error.
Result URLs must use an absolute `http://` or `https://` authority form, parse
with WHATWG URL, and have no username or password. One invalid URL refuses the
whole response before any actionable results are retained, including when that
row would exceed the output count or length limits. Diagnostics never echo the
rejected URL. Valid URL spellings (including Unicode hosts and query/fragment
identity) are preserved; validation does not fetch result destinations.

## Development

Install dependencies for editor support, linting, tests, type-checking, and repo line counts:

```bash
npm install
just lint
just typecheck
just test
just check
just loc
```

`just check` and `npm run check` both run lint, typecheck, and tests.
CI also runs `npm run audit:prod` (`npm audit --omit=dev --audit-level=high`)
after the locked install. High/critical production advisories and scanner or
network errors fail CI. This gate excludes development dependencies; use
`npm audit --json` to inspect the complete tree, including SDK peers installed
for development. If the gate fails, inspect the advisory, update the affected
dependency within supported ranges, refresh the lockfile and rerun `npm ci`,
`npm run check`, and `npm run audit:prod`. Retry a registry outage when service
returns; do not add blanket ignores or use `npm audit fix --force`.
The test suite packs and extracts the npm publish layout, then uses Pi’s public
resource loader with the lockfile-installed development peers to check unique
tool registration and bundled agent/prompt discovery offline. Negative fixtures
verify that missing entry points, helpers, agents, and prompts fail the smoke check.
Real-process workflow tests use only an invented local `pi` executable and IPC
file barriers, with no provider or network calls. Two-step journeys inspect the
private prompt handoff, including literal dollar syntax and repeated-placeholder
budgets, and require previous-group retirement before the next launch. Success
and second-step cancellation both remove prompt files/directories and retire
children and redirected descendants; a delayed post-settlement write probe must
remain absent. Environments denying signals to owned groups explicitly skip
these process tests; report that blocked gate instead of treating it as passed.

Equivalent npm commands:

```bash
npm run lint
npm run typecheck
npm test
npm run check
```

Run Pi with the local package while iterating:

```bash
pi -e <path-to-pi-extensions>
```

Or install it as a local package and reload Pi after changes:

```bash
pi install <path-to-pi-extensions>
```

## Structure

```text
agents/             Bundled agent definitions used by the agent_workflow extension
extensions/         Pi extension entry points
prompts/            Prompt templates registered through the Pi package manifest
shared/             Shared helpers for auth, Kagi API access, and web fetching
tests/              Unit tests for security-sensitive helpers and formatting
justfile            Developer shorthands for lint, typecheck, test, check, and loc
eslint.config.mjs   ESLint configuration for the TypeScript codebase
BACKLOG.md          Follow-up work tracked as Next / Later items
AGENTS.md           Repo-specific developer guidance for coding agents
```

## Notes

- This repository starts as a single Pi package with multiple extension files.
- The package manifest registers extensions via the conventional `./extensions` directory so installed Pi sessions discover all bundled tools end to end.
- If it grows substantially, it can later be split into multiple packages inside the same repo.
- Runtime dependencies require undici 7.30.1 or newer in the 7.x series to prevent process termination on excessive Content-Encoding responses. Reinstall dependencies after updating this checkout.
- `web_content` and the shared readable-page helper use one output limit: floor to an integer and clamp to 1,000–40,000 UTF-16 code units; omitted or non-finite limits use 12,000. The separate 2 MiB source-byte ceiling still applies.
- Readable content is clipped before any surrogate pair that crosses the output limit. `charCount` reports the retained UTF-16 code units, and `truncated` is true when either the output or source was truncated.
- Shortened `web_content` terminal previews end at a Unicode scalar boundary before adding `...`. The call preview fits in 72 UTF-16 code units including the ellipsis. Error previews keep up to 160 units when collapsed or 640 when expanded, and expanded content keeps up to 320 units, with three additional units reserved for the ellipsis.
- `web_content` canonicalizes IPv6 addresses before private/local classification, so compressed and expanded forms receive the same checks for both literal hosts and DNS answers. It blocks deprecated site-local `fec0::/10`, applies the IPv4 destination policy to mapped `::ffff:0:0/96` and well-known NAT64 `64:ff9b::/96` addresses, and conservatively rejects the entire local-use NAT64 `64:ff9b:1::/48` range because its variable embedding layouts are unsupported. Public IPv4 destinations in the well-known NAT64 prefix remain allowed; custom network-specific translation prefixes are not detected.
- `web_content` validates and pins DNS answers for each redirect target (including IPv4/IPv6 fallback), preserves the original Host/TLS name, blocks private/local IP ranges, and enforces a streaming fetch-size limit before extraction.
- `web_content` requires the final response to be HTTP 200 with no Content-Range header. Other successful statuses and any Content-Range header cause it to cancel the body before reading it.
- `web_content` accepts `text/html`, `application/xhtml+xml`, and `text/plain` (case-insensitive, with optional parameters). HTML is extracted. Plain text preserves whitespace, angle brackets and entity spellings. Missing Content-Type uses HTML extraction for compatibility. An empty or unsupported type (including PDF, images and JSON) fails before reading the body with a bounded format error. A supported Content-Type `charset` selects the Node.js text decoder. Missing, invalid or unsupported charset labels use UTF-8. The same fetch/output limits, truncation flags, deadline and cancellation apply to all supported types.
- `web_content` takes the title and readable text from the same parsed HTML document. The first title in the document head supplies the heading after whitespace normalization. With no usable head title, the heading is “Page content”. For `application/xhtml+xml`, self-closing non-void tags such as `<script/>` or `<nav/>` are closed in place before parsing, even when quoted attributes contain `>`. The normalization preserves void tags, comments, CDATA, processing instructions and declarations.
- `web_content` preserves text adjacency across inline formatting, so `AB<em>12</em>` reads as `AB12`. It normalizes existing whitespace and separates blocks, line breaks, table cells and text around removed content.
- `web_content` decodes HTML entities once in extracted titles and body text, including named and numeric Unicode references. Escaped literals such as `&amp;lt;` remain `&lt;`; malformed references follow HTML decoding rules.
- `web_content` displays URLs without userinfo, query parameters or fragments in progress, call previews, output URL labels and fetch diagnostics. The full URL remains available for transport and final machine-readable result details. Transport/body failures use controlled diagnostics without raw upstream error chains; URL privacy does not redact fetched page content.
- `web_content` marks source truncation only when response bytes were actually omitted. An exactly full 2 MiB response is complete after EOF; waiting for EOF or an overflow byte still obeys the same deadline and caller cancellation.
- At the source-byte cutoff, `web_content` drops any partial character pending in the decoder. At natural EOF the decoder retains its standard replacement behavior for malformed input.
- `web_content` has one 30-second total deadline covering DNS, redirects, headers, body consumption and dispatcher cleanup. Timeout errors invite a retry. Caller cancellation remains immediate.
- With an already-aborted caller signal, `fetchReadablePage` rejects with the original abort reason before starting the deadline or doing network work.
- If a fetch ignores cancellation and delivers a response after caller cancellation or the deadline, its late body is cancelled once through the public body API. Body cancellation throws/rejections are observed without changing the primary abort/deadline error or exposing response evidence.
- Each web dispatcher is destroyed through Undici's public API after its hop. Cleanup waits at most 100 ms and stops waiting immediately on caller cancellation or deadline expiry. Either event prevents returning a successful page. Existing fetch or body-read failures retain their original diagnostics. Cleanup errors preserve the fetch outcome, and late rejections are observed without logging private transport errors.
- `agent_workflow` discovers bundled agent definitions from `agents/` relative to the installed package path, so it works for `pi install <path>` and packaged installs.
- Agent workflow calls must select exactly one mode: a single agent and task, a parallel batch, or a chain. Missing or mixed modes return `isError: true` with empty results before prompts are created or delegates launch.
- Agent workflow subprocesses run with `--no-extensions`, `--no-prompt-templates`, and `--no-skills` to reduce recursion risk and keep delegated runs focused on bundled agent behavior.
- Parallel workflows admit at most 8 tasks in the schema and at runtime. Excess tasks return one fixed error with empty results before definition discovery or input preparation. Chain workflows admit at most 32 steps before prompt preparation or process launch; excess steps return an error verdict. Submitted workflows admit at most 1 MiB of UTF-8 task text per task and 4 MiB total before any prompt files or children are created. The total includes each invocation’s system prompt, agent label and working-directory label. Chain handoff text has its separate allowance below; it does not consume the submitted-input budget. Rejected workflows return a fixed diagnostic without echoing inputs.
  Submitted task text, agent names and working-directory labels must be valid Unicode text. An unpaired surrogate in any submitted item rejects the whole workflow before prompt files or children are created. Supplementary characters such as emoji are preserved.
- Chain mode shares a 12,000 UTF-16 code-unit handoff allowance across all `{previous}` occurrences in each prepared prompt, including truncation notices. Each placeholder receives the same bounded literal prior output, including dollar syntax and any `{previous}` text in that output; inserted text is not expanded again. Caller-authored task text is outside this handoff allowance. If a complete truncation notice cannot fit, each placeholder receives a plain output prefix (or empty text when its allowance is zero); step `handoff` metadata records source/inserted characters and whether context was truncated.
  Both clipping paths keep a complete Unicode scalar at the prefix boundary, leaving one code unit unused per placeholder if the limit would split a surrogate pair.
- Across the whole chain, bulk details retain the most recent messages within 4 MiB of serialized message bytes / 256 messages, 12,000 task-text code units and 64 KiB of stderr. The final progress snapshot uses these same budgets. Earlier steps keep their verdicts, usage and provenance; `omitted` counts removed messages, task characters and stderr bytes, with a result-detail truncation warning that can apply to the current step as well as earlier steps. Task-detail clipping does not change the prompt executed by the child. Each step still has an outcome record, so small outcome metadata grows with step count. The latest step's answer and the next handoff are preserved independently of older detail eviction. The separate 32-step admission ceiling bounds executed steps and outcome metadata.
- Parallel completed results share the chain’s 4 MiB / 256-message, 12,000-task-character and 64 KiB stderr detail limits, retaining one ordered outcome per task. Each task also retains an independent `output` answer within an equal share of a 1 MiB serialized-JSON output budget across the batch, so history eviction does not erase answers. Answers exceeding their share keep a Unicode-safe prefix and truncation notice; `omitted.outputChars` records removed source characters. Scalar provenance/agent labels are capped at 512 characters, error messages at 2,048, and at most eight 512-character warnings are retained before adding omission notices; `omitted.metadataChars` records clipped metadata. Ordinary small answers remain complete. The final callback and expanded display use these retained answers.
- Parallel cancellation stops claiming queued tasks; unstarted tasks create no prompt files or children and appear as aborted in the complete, ordered summary. Already-cancelled single and chain runs fail before prompt creation.
- Agent-workflow progress callbacks receive detached snapshots. The first intermediate update is immediate; subsequent events coalesce at a 100-ms cadence across the workflow. Child close and parallel completion flush immediately so observer failures still reach the owning supervisor. Intermediate snapshots are marked as previews and stay below 512 KiB of serialized JSON: at most eight recent result records, a 2,048-code-unit assistant-text preview per record, 512-code-unit scalar strings (including task/stderr), three 256-code-unit warnings plus a preview notice, and four 256-code-unit discovery diagnostics. Preview selection examines at most eight recent messages and sixteen blocks per assistant; arbitrary message/tool/provider metadata and full history are omitted before cloning. Each record retains usage, verdict and bounded provenance. The final callback flushes the complete returned result once, with the normal retention budgets and exact final answer; it bypasses the preview limits. Single/chain cancellation still rejects after reaping, and parallel cancellation flushes its full ordered result. Timers are cleared on every exit. Observers may retain, mutate or freeze snapshots; later updates and final results keep their own containers.
- A throwing agent-workflow progress callback fails the workflow with a bounded diagnostic, suppresses subsequent updates and cancels active tasks. Child groups (including remaining descendants) are terminated and reaped before prompt cleanup, even when the callback fails during EOF or parallel completion. Queued tasks are not launched; observer exception text is not copied into diagnostics.
- Agent workflows require POSIX process groups (Linux/macOS); Windows fails before prompt creation or launch. Each child starts in its own process group. Cancellation and protocol failure send SIGTERM to that group, escalate to SIGKILL after five seconds if it remains, and wait for child close before cleanup. Escalation also covers descendants that outlive the direct child or hold its output pipes open; descendants must stay in the inherited group. The extension host's group is never signalled. Detached groups do not receive terminal signals addressed to the host; cancel workflows before stopping it. An abrupt host exit (including a host crash or kill) can leave delegated processes running; automatic cleanup after host death is not provided. Normal child exit also retires remaining descendants with the same bounded escalation before returning the completed answer. Cleanup is confirmed for up to one second after SIGKILL; an unconfirmed group or a signal that stays denied (EPERM) through that window makes the result a failure while preserving answer details. macOS also answers EPERM while only not-yet-reaped zombies of the group remain: after the child exits, a denied group is re-probed for up to 0.5 s before escalation, so such a run completes normally without a warning or the five-second grace. Signal termination or a missing exit code fails the run and stops chained handoffs.
- A successful run needs both exit code zero and a final assistant `message_end` with `stopReason: "stop"` and nonblank text. Empty output, tool-only output, missing status, and length-truncated or tool-use turns fail with a retry hint and stop chain handoffs. Provider errors and cancellation remain failures even with exit code zero.
- Parallel prompt/setup failures become per-task failures; started siblings finish and queued tasks continue unless explicitly cancelled. Results retain input order. Success counts, task summaries, display icons and the tool error flag use the same verdict; any failed task marks the batch as an error while retaining every result.

Agent workflow stdout uses streaming, strict UTF-8 decoding, including the final
line at EOF. Every nonblank line must be complete JSON with unique decoded object-member names and finite decoded numbers at every depth, including in ignored events.
Decoded names and string values containing unpaired surrogates fail with the
same bounded invalid-JSON diagnostic. Each protocol line admits up to 128 container levels, 65,536 containers,
65,536 object members, and 65,536 array elements across all arrays before native
JSON decoding. Duplicate names (including escaped aliases) and numeric or structural overflow fail through the same bounded invalid-JSON diagnostic. Comments and trailing commas are refused; malformed or incomplete
JSON fails even after a completed answer. There is no supported non-JSON
preamble. Blank lines and unconsumed valid JSON event types remain ignored for output, but each invocation admits at most 64 MiB of total stdout bytes (including blank lines and newline bytes) and 65,536 nonblank protocol events (including ignored JSON values/types and a final line without a newline). Both ceilings are inclusive and apply before parsing/retention. Exhaustion fails the entire run even after an earlier completed answer, terminates/reaps its owned group, removes prompt files and stops chain handoffs.
Diagnostics never include the malformed line. The 1 MiB ceiling applies to every event, including cumulative
`agent_end` / `turn_end` events and partial `message_update` events. Runs with
larger events fail even if earlier work completed; this is a deliberate bounded
protocol contract. Invalid or incomplete UTF-8 and protocol lines exceeding 1 MiB fail
the run, terminate the owned process group (SIGTERM, then SIGKILL after five seconds if it remains), and wait
for close before removing the prompt. Diagnostic stderr keeps only its last
64 KiB. Message details keep the most recent entries within 4 MiB and 256
messages, with truncation warnings; usage totals still include evicted messages. Aggregate token counts and turn counts must stay within the nonnegative safe-integer range (0 through 9,007,199,254,740,991); monetary cost totals must stay finite. An overflowing addition fails before retaining the message or updating totals, uses a controlled protocol diagnostic and stops chain handoffs. If the display sum across separate agents exceeds either range, it reports that the total exceeds the numeric range and offers per-agent totals in the expanded view.
Final output and chain handoffs use the retained messages. System and task prompt files have
owner-only permissions in an owner-private temporary directory. Tasks use Pi’s
public `@file` input, preserving literal task text (including whitespace) inside
the host’s `<file name="…">` attachment wrapper (the test suite checks this against the file processing of the locked Pi dev
install) and keeping task contents out of process argv.
The same chain handoff limits apply before writing the task file. Both files and
their directory are removed after child cleanup; failed input file writes also remove
them before reporting “Unable to create agent input files.” without spawning a child.

Consumed `message_end` envelopes may carry user, assistant, or tool-result
messages; `tool_result_end` must carry a tool-result message. Contradictory
event/role pairs fail before retention or usage accounting, including after a
completed answer, and stop chain handoffs. Both envelopes require
role-appropriate content blocks. Text,
thinking, image, and tool-call fields are validated before retention; supplied
assistant usage must contain nonnegative safe integers for `input`, `output`,
`cacheRead`, `cacheWrite` and `totalTokens`. Cost fields must be finite and
nonnegative; fractional monetary values remain supported. `totalTokens` supplies
the latest context size rather than an accumulated total. Optional
usage and assistant status fields may be absent in intermediate messages; the final assistant completion must supply `stopReason: "stop"`. Malformed consumed messages
fail the run with a bounded diagnostic and the same terminate-and-reap lifecycle
as protocol overflow; unknown event types remain ignored. Unsupported message
roles and block types in consumed envelopes fail closed. Extra metadata is retained within the same bounds. Consumed messages, including nested tool arguments and extra metadata, may nest objects/arrays at most 64 levels below the message root; deeper messages fail before serialization or progress cloning with the same protocol cleanup.

Final output uses the latest retained assistant message containing text blocks,
joining every text block in order with a single newline, including empty blocks.
Thinking and tool-call blocks are excluded. Single text blocks are unchanged;
chain context truncation applies to the assembled answer.
