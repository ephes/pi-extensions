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
`read, bash`), and optional `model` is a string model ID. Omit optional fields
instead of setting them to YAML lists, booleans, numbers, or null. The Markdown
body supplies the system prompt; extra frontmatter fields are ignored. Invalid
or unreadable definitions are skipped with filename-only warnings, and all
otherwise valid definitions sharing an exact, case-sensitive name are excluded
with filename-only warnings so no ambiguous agent can be invoked. Discovery
warnings are included in each tool result and its display, without raw stderr
writes.

Bundled agent frontmatter prefers these model IDs:

- `implementer` — `openai/gpt-5.4`
- `reviewer` — `anthropic/claude-opus-4-6`

If an exact bundled model is unavailable, `agent_workflow` now falls back in this order:

1. the current Pi session model, when it is authenticated
2. the first authenticated model returned by Pi

If no authenticated Pi models are available at all, the delegated run fails early with a clear `/login` or API key hint.

Result provenance separates `requestedModel` (agent frontmatter), `selectedModel`
(the resolved CLI model), and `observedModel` (the latest nonempty model reported
by an assistant event). `model` uses the latest observation, falling back to the
selected model until an observation arrives. Missing observations do not erase
prior ones. Provider-qualified selections also match their bare model ID. A
reported mismatch adds one bounded warning; it never changes model selection.

If you want deterministic model pinning instead of fallback behavior, edit the frontmatter in `agents/*.md` to match your environment.

## Requirements

### Kagi search

Set a Kagi API key for `kagi_search`:

```bash
export KAGI_API_KEY="your-api-key"
```

The `limit` parameter accepts 1–20 results (default 10). One shared policy rounds it to the nearest integer and clamps it to that range, and non-finite values fall back to the default. The tool enforces this count locally even if the API returns extra rows.

The tool retains at most 24,000 characters of formatted result rows, with titles capped at 512, snippets at 2,048 and publication strings at 64 characters. URLs stay complete; rows with URLs longer than 2,048 characters are omitted. It keeps at most 10 related searches of 128 characters each and a 512-character query label. These limits keep final text below 32 Ki characters (JavaScript UTF-16 code units). Details contain only retained URLs/counts and supported metadata (`id`/`node` capped at 256 characters, plus `ms`/`api_balance`); arbitrary metadata fields are omitted. `resultCount` and `relatedCount` describe retained entries, `originalResultCount` and `originalRelatedCount` describe the API response, and `truncated` plus an output notice identify omitted rows, clipped text or metadata. Fewer than `limit` results may fit. An empty search still reports “No results found”; if all returned rows exceed the output limits, the tool reports that no results were retained. Related-only responses keep the empty-search message with zero retained related entries.

Kagi searches have a 30-second total deadline covering headers and body reads; caller cancellation is immediate. Success and error responses are limited to 1 MiB of streamed bytes, regardless of Content-Length. Timeout errors invite a retry (`TimeoutError`); cancellation uses `AbortError` with a controlled message. HTTP error diagnostics redact the configured API key. Transport and body-read failures use bounded categories without upstream messages or causes. Successful responses require valid UTF-8 before JSON admission; malformed bytes publish no search results. HTTP error bodies use replacement decoding so the status remains available even for malformed text.

Search and web result displays mark failed calls as failures with bounded diagnostics; an empty successful search remains “0 results”. Partial results retain their running status.

The response must contain a `data` array of result items (`t: 0`, string `url` and `title`, optional string `snippet` and string or finite numeric `published`) or related-search items (`t: 1`, string-only `list`). Optional result and metadata scalars may also be `null` for absent values. Optional metadata must be an object with string `id`/`node` and finite numeric `ms`/`api_balance` when supplied. The shared `searchKagi` helper retains unknown extra fields after validation; the tool projects bounded metadata as described above. Unsupported item types and malformed fields fail with a controlled error.

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
- `web_content` canonicalizes IPv6 addresses before private/local classification, so compressed and expanded forms receive the same checks for both literal hosts and DNS answers. It blocks deprecated site-local `fec0::/10`, applies the IPv4 destination policy to mapped `::ffff:0:0/96` and well-known NAT64 `64:ff9b::/96` addresses, and conservatively rejects the entire local-use NAT64 `64:ff9b:1::/48` range because its variable embedding layouts are unsupported. Public IPv4 destinations in the well-known NAT64 prefix remain allowed; custom network-specific translation prefixes are not detected.
- `web_content` validates and pins DNS answers for each redirect target (including IPv4/IPv6 fallback), preserves the original Host/TLS name, blocks private/local IP ranges, and enforces a streaming fetch-size limit before extraction.
- `web_content` accepts `text/html`, `application/xhtml+xml`, and `text/plain` (case-insensitive, with optional parameters). HTML is extracted; plain text preserves whitespace, angle brackets and entity spellings. Missing Content-Type uses HTML extraction for compatibility; an empty or unsupported type (including PDF, images and JSON) fails before reading the body with a bounded format error. Text is decoded as UTF-8; charset parameters do not select other decoders. The same fetch/output limits, truncation flags, deadline and cancellation apply to all supported types.
- `web_content` decodes HTML entities once in extracted titles and body text, including named and numeric Unicode references. Escaped literals such as `&amp;lt;` remain `&lt;`; malformed references follow HTML decoding rules.
- `web_content` displays URLs without userinfo, query parameters or fragments in progress, call previews, output URL labels and fetch diagnostics. The full URL remains available for transport and final machine-readable result details. Transport/body failures use controlled diagnostics without raw upstream error chains; URL privacy does not redact fetched page content.
- `web_content` marks source truncation only when response bytes were actually omitted. An exactly full 2 MiB response is complete after EOF; waiting for EOF or an overflow byte still obeys the same deadline and caller cancellation.
- `web_content` has one 30-second total deadline covering DNS, redirects, headers, and body consumption. Timeout errors invite a retry; caller cancellation remains immediate.
- `agent_workflow` discovers bundled agent definitions from `agents/` relative to the installed package path, so it works for `pi install <path>` and packaged installs.
- Agent workflow subprocesses run with `--no-extensions`, `--no-prompt-templates`, and `--no-skills` to reduce recursion risk and keep delegated runs focused on bundled agent behavior.
- Chain mode shares a 12,000 UTF-16 code-unit handoff allowance across all `{previous}` occurrences in each prepared prompt, including truncation notices. Each placeholder receives the same bounded literal prior output, including dollar syntax and any `{previous}` text in that output; inserted text is not expanded again. Caller-authored task text is outside this handoff allowance. If a complete truncation notice cannot fit, each placeholder receives a plain output prefix (or empty text when its allowance is zero); step `handoff` metadata records source/inserted characters and whether context was truncated.
- Across the whole chain, bulk details retain the most recent messages within 4 MiB of serialized message bytes / 256 messages, 12,000 task-text code units and 64 KiB of stderr. Progress snapshots obey the same budgets. Earlier steps keep their verdicts, usage and provenance; `omitted` counts removed messages, task characters and stderr bytes, with a result-detail truncation warning that can apply to the current step as well as earlier steps. Task-detail clipping does not change the prompt executed by the child. Each step still has an outcome record, so small outcome metadata grows with step count. The latest step's answer and the next handoff are preserved independently of older detail eviction. These budgets do not limit the number of executed steps.
- Parallel cancellation stops claiming queued tasks; unstarted tasks create no prompt files or children and appear as aborted in the complete, ordered summary. Already-cancelled single and chain runs fail before prompt creation.
- Agent-workflow progress callbacks receive detached snapshots of result messages, usage, warnings and metadata. Observers may retain, mutate or freeze them; later updates and final results keep their own containers. Snapshots follow the same retention limits as result details.
- A throwing agent-workflow progress callback fails the workflow with a bounded diagnostic, suppresses subsequent updates and cancels active tasks. Child groups (including remaining descendants) are terminated and reaped before prompt cleanup, even when the callback fails during EOF or parallel completion. Queued tasks are not launched; observer exception text is not copied into diagnostics.
- Agent workflows require POSIX process groups (Linux/macOS); Windows fails before prompt creation or launch. Each child starts in its own process group. Cancellation and protocol failure send SIGTERM to that group, escalate to SIGKILL after five seconds if it remains, and wait for child close before cleanup. Escalation also covers descendants that outlive the direct child or hold its output pipes open; descendants must stay in the inherited group. The extension host's group is never signalled. Detached groups do not receive terminal signals addressed to the host; cancel workflows before stopping it. An abrupt host exit (including a host crash or kill) can leave delegated processes running; automatic cleanup after host death is not provided. Normal child exit does not terminate remaining descendants, so agents must finish or stop their background work before returning. Signal termination or a missing exit code fails the run and stops chained handoffs.
- A successful run needs both exit code zero and a final assistant `message_end` with `stopReason: "stop"` and nonblank text. Empty output, tool-only output, missing status, and length-truncated or tool-use turns fail with a retry hint and stop chain handoffs. Provider errors and cancellation remain failures even with exit code zero.
- Parallel prompt/setup failures become per-task failures; started siblings finish and queued tasks continue unless explicitly cancelled. Results retain input order. Success counts, task summaries, display icons and the tool error flag use the same verdict; any failed task marks the batch as an error while retaining every result.

Agent workflow stdout uses streaming, strict UTF-8 decoding, including the final
line at EOF. The 1 MiB ceiling applies to every event, including cumulative
`agent_end` / `turn_end` events and partial `message_update` events. Runs with
larger events fail even if earlier work completed; this is a deliberate bounded
protocol contract. Invalid or incomplete UTF-8 and protocol lines exceeding 1 MiB fail
the run, terminate the owned process group (SIGTERM, then SIGKILL after five seconds if it remains), and wait
for close before removing the prompt. Diagnostic stderr keeps only its last
64 KiB. Message details keep the most recent entries within 4 MiB and 256
messages, with truncation warnings; usage totals still include evicted messages. Aggregate usage overflow fails the run with a controlled protocol diagnostic and stops chain handoffs; returned totals remain finite. If the display sum across separate agents overflows, it reports that the total exceeds the numeric range and offers per-agent totals in the expanded view.
Final output and chain handoffs use the retained messages. Prompt files have
owner-only permissions, and failed prompt writes remove their owned temporary
directory before reporting failure without spawning a child.

Consumed `message_end` and `tool_result_end` envelopes must carry a user,
assistant, or tool-result message with role-appropriate content blocks. Text,
thinking, image, and tool-call fields are validated before retention; supplied
assistant usage must contain finite, nonnegative token and cost values. Optional
usage and assistant status fields may be absent in intermediate messages; the final assistant completion must supply `stopReason: "stop"`. Malformed consumed messages
fail the run with a bounded diagnostic and the same terminate-and-reap lifecycle
as protocol overflow; unknown event types remain ignored. Unsupported message
roles and block types in consumed envelopes fail closed. Extra metadata is retained within the same bounds. Consumed messages, including nested tool arguments and extra metadata, may nest objects/arrays at most 64 levels below the message root; deeper messages fail before serialization or progress cloning with the same protocol cleanup.

Final output uses the latest retained assistant message containing text blocks,
joining every text block in order with a single newline, including empty blocks.
Thinking and tool-call blocks are excluded. Single text blocks are unchanged;
chain context truncation applies to the assembled answer.
