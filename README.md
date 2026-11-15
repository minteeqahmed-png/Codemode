# Codemode

[![CI & Policy Benchmark](https://github.com/minteeqahmed-png/Codemode/actions/workflows/ci.yml/badge.svg)](https://github.com/minteeqahmed-png/Codemode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Turn **any** large OpenAPI v3 or Swagger 2.0 specification (Cloudflare, GitHub, Stripe, Kubernetes, Jira) into a zero-dependency 2-tool **Code Mode MCP Server** (`search` + `execute`) with **99.7% fewer tokens**, resolved TypeScript type hints, async VM isolation, and built-in policy auditing.

## Why Code Mode?
Traditional MCP servers register 1 tool per REST endpoint. For large APIs (500–2,500+ endpoints), tool schemas alone consume **75k–1.1M+ tokens** before the conversation even starts.

Following Cloudflare's **Code Mode** pattern, this project exposes only two MCP tools (~250 tokens total):
1. **`search`**: Queries the OpenAPI spec with relevance ranking, cycle-safe `$ref` schema resolution, and compact TypeScript type hints (`typeHints`).
2. **`execute`**: Runs a lightweight async JavaScript snippet in an isolated `node:vm` sandbox using `await api.request(method, path, body)` or `await api.paginate(method, path, options)` while enforcing real-time security guardrails, wall-clock async timeouts (`AbortController`), exponential-backoff retries, and `maxResponseBytes` truncation.

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

# Streamable HTTP / SSE MCP transport for remote IDEs & web agents
node src/server.ts --preset cloudflare --transport http --port 3000 --dry-run

# Custom OpenAPI JSON/YAML spec URL or file with custom policies & timeout
node src/server.ts --spec ./openapi.yaml --policies ./policies.json --timeout-ms 5000 --dry-run
```

## CLI Reference & Flags

`src/server.ts` supports the following command-line flags and environment variable fallbacks:

| Flag | Short | Description | Environment Variable |
| --- | --- | --- | --- |
| `--preset <name>` | `-P` | Use a built-in OpenAPI spec preset (`cloudflare`, `github`, `stripe`, `kubernetes`) | - |
| `--spec <url-or-file>` | `-s` | Remote OpenAPI v3 / Swagger 2.0 JSON/YAML URL or local file path | `OPENAPI_SPEC_PATH` |
| `--base-url <url>` | `-b` | API base URL (overrides preset or spec server default) | `API_BASE_URL` |
| `--token <api-token>` | `-t` | Bearer token passed in the `Authorization` header for requests | `API_TOKEN` |
| `--policies <file>` | `-p` | Path to custom security policy JSON configuration file | `POLICIES_PATH` |
| `--timeout-ms <ms>` | - | Sandbox CPU & async wall-clock timeout in milliseconds | `TIMEOUT_MS` |
| `--transport <mode>` | - | MCP transport protocol: `stdio` (default), `http`, or `sse` | `MCP_TRANSPORT` |
| `--port <port>` | - | Port for HTTP/SSE server (`POST /mcp`, `GET /sse`, `GET /health`) | `PORT` |
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
