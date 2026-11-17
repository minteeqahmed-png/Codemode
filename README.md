# Codemode

[![CI & Policy Benchmark](https://github.com/minteeqahmed-png/Codemode/actions/workflows/ci.yml/badge.svg)](https://github.com/minteeqahmed-png/Codemode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Turn **any** large OpenAPI v3 or Swagger 2.0 specification (Cloudflare, GitHub, Stripe, Kubernetes, OpenAI, Slack, DigitalOcean, Jira) into a zero-dependency 2-tool **Code Mode MCP Server** (`search` + `execute`) with **99.7% fewer tokens**, resolved TypeScript type hints, async VM isolation, and built-in policy auditing.

## Why Code Mode?
Traditional MCP servers register 1 tool per REST endpoint. For large APIs (500–2,500+ endpoints), tool schemas alone consume **75k–1.1M+ tokens** before the conversation even starts.

Following Cloudflare's **Code Mode** pattern, this project exposes only two MCP tools (~290 tokens total):
1. **`search`**: Queries the OpenAPI spec with relevance ranking, tag filtering (`tag` + `availableTags` taxonomy discovery + `*` wildcard browsing), cycle-safe `$ref` schema resolution, and compact TypeScript type hints (`typeHints`).
2. **`execute`**: Runs a lightweight async JavaScript snippet in an isolated `node:vm` sandbox using `await api.request(method, path, body)`, `await api.paginate(method, path, options)`, `await api.batch(requests, options)`, and `api.simulate(requests)` while enforcing same-origin isolation, real-time security guardrails, wall-clock async timeouts (`AbortController`), exponential-backoff retries, and `maxResponseBytes` truncation.

## What's New & Fixed in v0.3.0

See [CHANGELOG.md](./CHANGELOG.md) for the complete version history.

### New Features
- **Concurrent Batch Helper (`await api.batch(requests, options)`)**: Runs an array of `{ method, path, body }` requests with bounded concurrency (`concurrency` 1–10, default `5`), optional `continueOnError` fault isolation, and full per-call policy & SSRF checks.
- **Pre-Flight Policy Simulator (`api.simulate(requests)`)**: Dry-validates a batch of planned `{ method, path, body }` operations against all active security policies and same-origin SSRF guards before making any network call or incrementing the live request counter.
- **Tag Filtering & Taxonomy Discovery (`search`)**: Added optional `tag` filtering (`searchSpec(..., { includeTypes, tag, limit })`), wildcard/empty query browsing (`"*"`), and sorted `availableTags` lists in `search` tool outputs.
- **3 New CLI API Presets & Live `/metrics` Telemetry**: Added built-in presets for `openai`, `slack`, and `digitalocean` (7 presets total) plus `server.getMetrics()` and `GET /metrics` (also embedded in `GET /health`) reporting `uptimeMs`, `endpointsIndexed`, `availableTagsCount`, `totalSearches`, `totalExecutions`, and `totalBlockedCalls`.
- **v0.2.0 Foundations Included**: Cycle-safe `$ref` resolution with compact TypeScript `typeHints`, zero-dependency Streamable HTTP & SSE transport (`POST /mcp`, `GET /sse`, `POST /messages`), async `AbortController` wall-clock timeouts, and `dryRunSummary`.

### What's Fixed
- **Same-Origin SSRF & Credential Exfiltration Guard (`executeCodeMode`)**: Blocked cross-origin absolute URLs in `api.request()` by default (`allowCrossOrigin: false`) before `fetch()` (and during `dryRun`), and stripped `options.headers` (e.g., `Authorization` tokens) when `allowCrossOrigin` is enabled.
- **URL-Decoded Path Traversal Protection (`normalizeApiPath`)**: Normalized and percent-decoded request paths (`decodeURIComponent` + `path.posix.normalize`) in `protect-sensitive-account-paths` to block obfuscated bypasses such as `/accounts/123/%69%61%6d/roles` and `/accounts/123/zones/../iam/roles`.
- **Direct Insecure `http://` Request URL Blocking**: Extended `block-insecure-http-origins` to reject direct non-local `http://` request URLs across all HTTP methods (including `GET`), alongside multi-URL request body scanning.
- **Quote-Aware YAML `$ref` & Object-List Parser (`parseSimpleYaml`, `stripYamlComment`)**: Fixed comment stripping so `#` inside quoted `$ref: '#/components/schemas/...'` or unspaced URL fragments is preserved, and added YAML object-list item (`- key: value` / `-`) parsing.
- **OpenAPI 3.x Server Variables & Path-Level Parameters**: Interpolated `servers[0].variables.*.default` placeholders in `resolveBaseUrl()` and merged path-item level `parameters` into operations cleanly (with operation-level overrides on matching `name` + `in`).
- **JSON-RPC 2.0 & HTTP Payload Guardrails**: Added standard `{}` responses for `ping`, returned `null` for notifications without `id`, returned `-32601 Method not found` for unknown methods, prevented double settlement in `readJsonBody`, and returned HTTP `413 Payload Too Large` on >1MB payloads.
- **Cross-Platform TypeScript Scripts (`package.json`)**: Updated `npm run build` and `npm run typecheck` to run `node ./node_modules/typescript/bin/tsc` directly for consistent Windows and Linux execution.

## Quick Start

### 1. Run the Live Proof-of-Concept & Benchmark Suite
```bash
npm run demo
npm run typecheck
```

### 2. Connect Any OpenAPI URL or Local File via CLI
```bash
# Stdio MCP transport (default for local MCP clients)
node src/server.ts --preset github --dry-run

# Streamable HTTP / SSE MCP transport with /health and /metrics endpoints
node src/server.ts --preset openai --transport http --port 3000 --dry-run

# Custom OpenAPI JSON/YAML spec URL or file with custom policies & timeout
node src/server.ts --spec ./openapi.yaml --policies ./policies.json --timeout-ms 5000 --dry-run
```

## Sandbox Helpers (`execute` Tool)

Inside `execute`, scripts run in an isolated `node:vm` sandbox with four audited helpers:
```js
// 1. Pre-flight check planned operations without firing HTTP calls
const plan = api.simulate([
  { method: "GET", path: "/zones" },
  { method: "DELETE", path: "/dns_records/1" },
]);

// 2. Concurrent bounded batch execution with optional continueOnError isolation
const batch = await api.batch(
  [
    { method: "GET", path: "/zones/z1" },
    { method: "GET", path: "/zones/z2" },
  ],
  { concurrency: 2, continueOnError: true }
);

// 3. Auto-pagination (page/per_page & cursor detection)
const pages = await api.paginate("GET", "/zones", { limit: 25, maxPages: 3 });

// 4. Single HTTP call with auto-retry and policy enforcement
return await api.request("GET", "/zones");
```

## CLI Reference & Flags

`src/server.ts` supports the following command-line flags and environment variable fallbacks:

| Flag | Short | Description | Environment Variable |
| --- | --- | --- | --- |
| `--preset <name>` | `-P` | Built-in preset (`cloudflare`, `github`, `stripe`, `kubernetes`, `openai`, `slack`, `digitalocean`) | - |
| `--spec <url-or-file>` | `-s` | Remote OpenAPI v3 / Swagger 2.0 JSON/YAML URL or local file path | `OPENAPI_SPEC_PATH` |
| `--base-url <url>` | `-b` | API base URL (overrides preset or spec server default) | `API_BASE_URL` |
| `--token <api-token>` | `-t` | Bearer token passed in the `Authorization` header for requests | `API_TOKEN` |
| `--policies <file>` | `-p` | Path to custom security policy JSON configuration file | `POLICIES_PATH` |
| `--timeout-ms <ms>` | - | Sandbox CPU & async wall-clock timeout in milliseconds | `TIMEOUT_MS` |
| `--transport <mode>` | - | MCP transport protocol: `stdio` (default), `http`, or `sse` | `MCP_TRANSPORT` |
| `--port <port>` | - | Port for HTTP/SSE server (`POST /mcp`, `GET /sse`, `GET /health`, `GET /metrics`) | `PORT` |
| `--dry-run` | - | Simulate API calls with a visual `dryRunSummary` without firing live HTTP calls | `DRY_RUN` (`"true"`) |
| `--help` | `-h` | Display CLI usage instructions and exit | - |

### 3. Add to Your MCP Client (`mcp_config.json`)
```json
{
  "mcpServers": {
    "github-codemode": {
      "command": "node",
      "args": [
        "path/to/Codemode/src/server.ts",
        "--preset",
        "github"
      ],
      "env": {
        "API_TOKEN": "your_token_here"
      }
    }
  }
}
```

## Author & Maintainer

Created and solely maintained by **Minteeq Ahmed** ([@minteeqahmed-png](https://github.com/minteeqahmed-png)).

## License

MIT © [Minteeq Ahmed](https://github.com/minteeqahmed-png)
