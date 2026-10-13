# pi-extensions

A monorepo of Pi extensions that adds reusable tools for search, web access, and agent workflows.

## Install

### Local path

Use Node 22 or newer. Install runtime dependencies in the checkout before registering it with Pi; local-path installation does not install them automatically.

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

If you want deterministic model pinning instead of fallback behavior, edit the frontmatter in `agents/*.md` to match your environment.

## Requirements

### Kagi search

Set a Kagi API key for `kagi_search`:

```bash
export KAGI_API_KEY="your-api-key"
```

Kagi searches have a 30-second total deadline covering headers and body reads; caller cancellation is immediate. Success and error responses are limited to 1 MiB of streamed bytes, regardless of Content-Length. Timeout errors invite a retry (`TimeoutError`); cancellation uses `AbortError` with a controlled message. HTTP error diagnostics redact the configured API key.

The response must contain a `data` array of result items (`t: 0`, string `url` and `title`, optional string `snippet` and string or finite numeric `published`) or related-search items (`t: 1`, string-only `list`). Optional result and metadata scalars may also be `null` for absent values. Optional metadata must be an object with string `id`/`node` and finite numeric `ms`/`api_balance` when supplied. Unknown extra fields are retained; unsupported item types and malformed fields fail with a controlled error.

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
- `web_content` canonicalizes IPv6 addresses before private/local classification, so compressed and expanded forms receive the same checks for both literal hosts and DNS answers.
- `web_content` validates and pins DNS answers for each redirect target (including IPv4/IPv6 fallback), preserves the original Host/TLS name, blocks private/local IP ranges, and enforces a streaming fetch-size limit before extraction.
- `web_content` decodes HTML entities once in extracted titles and body text, including named and numeric Unicode references. Escaped literals such as `&amp;lt;` remain `&lt;`; malformed references follow HTML decoding rules.
- `web_content` has one 30-second total deadline covering DNS, redirects, headers, and body consumption. Timeout errors invite a retry; caller cancellation remains immediate.
- `agent_workflow` discovers bundled agent definitions from `agents/` relative to the installed package path, so it works for `pi install <path>` and packaged installs.
- Agent workflow subprocesses run with `--no-extensions`, `--no-prompt-templates`, and `--no-skills` to reduce recursion risk and keep delegated runs focused on bundled agent behavior.
- Chain mode truncates `{previous}` context before passing it to the next delegated agent step to avoid oversized command-line prompts. Every placeholder receives the same literal prior output, including dollar syntax and any `{previous}` text in that output; inserted text is not expanded again.
- Parallel cancellation stops claiming queued tasks; unstarted tasks create no prompt files or children and appear as aborted in the complete, ordered summary. Already-cancelled single and chain runs fail before prompt creation.
- Agent workflow cancellation sends SIGTERM, escalates to SIGKILL after five seconds if the child has not closed, and waits for close before cleanup. Signal termination or a missing exit code fails the run and stops chained handoffs; partial output is not treated as success.

Agent workflow stdout uses streaming, strict UTF-8 decoding, including the final
line at EOF. The 1 MiB ceiling applies to every event, including cumulative
`agent_end` / `turn_end` events and partial `message_update` events. Runs with
larger events fail even if earlier work completed; this is a deliberate bounded
protocol contract. Invalid or incomplete UTF-8 and protocol lines exceeding 1 MiB fail
the run, terminate the child (SIGTERM, then SIGKILL after five seconds), and wait
for close before removing the prompt. Diagnostic stderr keeps only its last
64 KiB. Message details keep the most recent entries within 4 MiB and 256
messages, with truncation warnings; usage totals still include evicted messages.
Final output and chain handoffs use the retained messages. Prompt files have
owner-only permissions, and failed prompt writes remove their owned temporary
directory before reporting failure without spawning a child.

Consumed `message_end` and `tool_result_end` envelopes must carry a user,
assistant, or tool-result message with role-appropriate content blocks. Text,
thinking, image, and tool-call fields are validated before retention; supplied
assistant usage must contain finite, nonnegative token and cost values. Optional
usage and assistant status fields may be absent. Malformed consumed messages
fail the run with a bounded diagnostic and the same terminate-and-reap lifecycle
as protocol overflow; unknown event types remain ignored. Unsupported message
roles and block types in consumed envelopes fail closed. Extra metadata is retained.
