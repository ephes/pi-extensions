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

## Requirements

### Kagi search

Set a Kagi API key for `kagi_search`:

```bash
export KAGI_API_KEY="your-api-key"
```

## Development

Install dependencies for editor support, linting, tests, and type-checking:

```bash
npm install
just lint
just typecheck
just test
just check
```

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
extensions/         Pi extension entry points
shared/             Shared helpers for auth, Kagi API access, and web fetching
tests/              Unit tests for security-sensitive helpers and formatting
justfile            Developer shorthands for lint, typecheck, test, and check
eslint.config.mjs   ESLint configuration for the TypeScript codebase
BACKLOG.md          Follow-up work tracked as Next / Later items
AGENTS.md           Repo-specific developer guidance for coding agents
```

## Notes

- This repository starts as a single Pi package with multiple extension files.
- If it grows substantially, it can later be split into multiple packages inside the same repo.
- `web_content` validates redirect targets, blocks private/local IP ranges, and enforces a streaming fetch-size limit before extraction.
