# Changelog

All notable changes to **Codemode** are documented in this file.

## v0.3.0 — 2026-11-17

### New Features
- **`api.batch(requests, options)` Sandbox Helper (`src/index.ts`)**: Added bounded-concurrency batch execution (`concurrency` clamped to 1–10, default `5`) with optional `continueOnError` fault isolation and full per-item policy and SSRF enforcement.
- **`api.simulate(requests)` Pre-Flight Validator (`src/index.ts`)**: Added synchronous sandbox policy & same-origin SSRF dry-validation for planned request batches without issuing HTTP calls or incrementing live rate-limit counters.
- **Tag Filtering & Taxonomy Discovery (`src/index.ts`, `src/server.ts`)**: Extended `searchSpec()` and the `search` MCP tool schema with optional `tag` filtering, `limit` (default 15, max 50), `"*"`/empty wildcard browsing, and sorted `availableTags` in `search` responses.
- **3 New Built-In CLI API Presets (`src/server.ts`)**: Added `openai`, `slack`, and `digitalocean` alongside `cloudflare`, `github`, `stripe`, and `kubernetes`.
- **Live Server Telemetry (`src/server.ts`)**: Added `CodeModeMcpServer.getMetrics()` plus `GET /metrics` (and embedded `metrics` inside `GET /health`) reporting `uptimeMs`, `endpointsIndexed`, `availableTagsCount`, `totalSearches`, `totalExecutions`, and `totalBlockedCalls`.

### Fixes & Hardening
- **Same-Origin SSRF & Credential Exfiltration Guard (`src/index.ts`)**: Added `allowCrossOrigin?: boolean` (default `false`) in `executeCodeMode()`. Cross-origin URLs are blocked before `fetch()` (and during `dryRun`), and `options.headers` are stripped on cross-origin calls even when `allowCrossOrigin` is enabled.
- **URL-Decoded Path Traversal Protection (`src/index.ts`)**: Added `normalizeApiPath()` (`decodeURIComponent` + `path.posix.normalize`) to `protect-sensitive-account-paths` to block percent-encoded and dot-traversal bypasses (`/accounts/123/%69%61%6d/roles`, `/accounts/123/zones/../iam/roles`).
- **Direct HTTP Target Enforcement (`src/index.ts`)**: Updated `block-insecure-http-origins` to reject non-local `http://` target URLs across all HTTP methods (including `GET`).
- **Quote-Aware YAML `$ref` & Object-List Parser (`src/server.ts`)**: Added `stripYamlComment()` and YAML object-list (`- key: value` / `-`) support in `parseSimpleYaml` so `#` fragments inside `$ref` values and URLs are preserved.
- **OpenAPI 3.x Server Variables & Path-Level Parameters (`src/server.ts`, `src/index.ts`)**: Interpolated `servers[0].variables.*.default` placeholders in `resolveBaseUrl()` and merged path-item level `parameters` with operation overrides in `indexOpenApiSpec()`.
- **JSON-RPC 2.0 & HTTP Body Guardrails (`src/server.ts`)**: Added `{}` handling for `ping`, returned `null` for notifications without `id`, returned `-32601 Method not found` for unknown methods, prevented double promise settlement in `readJsonBody`, and returned `413 Payload Too Large` on >1MB requests.
- **Portable TypeScript Scripts (`package.json`)**: Invoked `node ./node_modules/typescript/bin/tsc` in `build` and `typecheck` scripts for consistent Windows and Linux execution.

## v0.2.0 — 2026-11-15

- Added cycle-safe internal OpenAPI `$ref` schema resolution and compact TypeScript `typeHints` (`parameters`, `requestBody`, `response`) with relevance-ranked `searchSpec()` (`includeTypes` toggle).
- Removed external runtime dependencies (`"dependencies": {}`), relying exclusively on Node.js 24 built-in standard modules (`node:http`, `node:crypto`, `node:vm`, `node:fs/promises`, `node:readline`, `node:path`, `node:url`).
- Added zero-dependency Streamable HTTP & SSE MCP transport (`GET /health`, `POST /mcp`, `GET /sse`, `POST /messages`) via `--transport` and `--port` flags.
- Added wall-clock async `AbortController` + `Promise.race` execution timeouts, `204 No Content` / plain-text `parseResponseBody` handling, `dryRunSummary` audit counts, case-insensitive protected path matching, and multi-URL `http://` body scanning.

## v0.1.0 — 2026-11-11

- Initial release of the 2-tool Code Mode MCP Server (`search` + `execute`), `node:vm` sandbox, enterprise security policies (`policies.json`), Swagger 2.0 compatibility, YAML OpenAPI loading, `maxResponseBytes` truncation guardrail, and `api.paginate()` with exponential-backoff retry.
