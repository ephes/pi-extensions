# pi-extensions

A monorepo of Pi extensions that adds reusable tools for search, web access, and agent workflows.

## Install

### Local path

```bash
pi install <path-to-pi-extensions>
```

### Git

```bash
pi install git:github.com/jochen/pi-extensions
```

## Current extensions

- `kagi_search` — search the web with the official Kagi Search API
- `web_content` — fetch and extract readable page content from a URL
- `subagent` — delegate work to bundled specialist subagents with isolated context

## Bundled subagents and prompts

Bundled subagents live in `agents/`:

- `implementer` — implementation specialist with `read`, `bash`, `edit`, and `write`
- `reviewer` — review specialist with `read`, `grep`, `find`, `ls`, and read-only git bash usage

Bundled prompt templates live in `prompts/` and are registered through the Pi package manifest:

- `/implement` — implement with the bundled implementer
- `/review` — review the current diff with the bundled reviewer
- `/implement-and-review` — implement, review, then apply feedback in a chain

Bundled agent model IDs currently assume these models exist in the local Pi setup:

- `implementer` — `openai/gpt-5.4`
- `reviewer` — `anthropic/claude-opus-4-6`

If your local Pi configuration uses different model IDs, edit the frontmatter in `agents/*.md` to match your environment.

## Requirements

### Kagi search

Set a Kagi API key for `kagi_search`:

```bash
export KAGI_API_KEY="your-api-key"
```

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
agents/             Bundled subagent definitions used by the subagent extension
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
- If it grows substantially, it can later be split into multiple packages inside the same repo.
- `web_content` validates redirect targets, blocks private/local IP ranges, and enforces a streaming fetch-size limit before extraction.
- `subagent` discovers bundled agent definitions from `agents/` relative to the installed package path, so it works for `pi install <path>` and packaged installs.
- Subagent subprocesses run with `--no-extensions`, `--no-prompt-templates`, and `--no-skills` to reduce recursion risk and keep delegated runs focused on bundled agent behavior.
- Chain mode truncates `{previous}` context before passing it to the next subagent step to avoid oversized command-line prompts.
