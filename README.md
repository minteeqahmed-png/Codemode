# Codemode

[![CI & Policy Benchmark](https://github.com/minteeqahmed-png/Codemode/actions/workflows/ci.yml/badge.svg)](https://github.com/minteeqahmed-png/Codemode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Turn **any** large OpenAPI v3 specification (Cloudflare, GitHub, Stripe, Kubernetes, Jira) into a 2-tool **Code Mode MCP Server** (`search` + `execute`) with 99.7% fewer tokens and built-in policy auditing.

## Why Code Mode?
Traditional MCP servers register 1 tool per REST endpoint. For large APIs (500–2,500+ endpoints), tool schemas alone consume **75k–1.1M+ tokens** before the conversation even starts.

Following Cloudflare's **Code Mode** pattern, this project exposes only two MCP tools (~218 tokens total):
1. **`search`**: Queries the OpenAPI spec on demand by keyword, tag, or HTTP method.
2. **`execute`**: Runs a lightweight JavaScript snippet in an isolated sandbox using `await api.request(method, path, body)` or `await api.paginate(method, path, options)` while enforcing real-time security and audit policies.

## Quick Start

### 1. Run the Live Proof-of-Concept & Benchmark
```bash
npm run demo
```

### 2. Connect Any OpenAPI URL or Local File via CLI
```bash
# Using a popular API preset (cloudflare, github, stripe, kubernetes)
node src/server.ts --preset github --dry-run

# Or specifying a custom OpenAPI spec URL or file
node src/server.ts --spec https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json --base-url https://api.github.com --dry-run
```

## CLI Reference & Flags

`src/server.ts` supports the following command-line flags and environment variable fallbacks:

| Flag | Short | Description | Environment Variable |
| --- | --- | --- | --- |
| `--preset <name>` | `-P` | Use a built-in OpenAPI spec preset (`cloudflare`, `github`, `stripe`, `kubernetes`) | - |
| `--spec <url-or-file>` | `-s` | Remote OpenAPI v3 JSON spec URL or local JSON file path | `OPENAPI_SPEC_PATH` |
| `--base-url <url>` | `-b` | API base URL (overrides preset or spec server default) | `API_BASE_URL` |
| `--token <api-token>` | `-t` | Bearer token passed in the `Authorization` header for requests | `API_TOKEN` |
| `--policies <file>` | `-p` | Path to custom security policy JSON configuration file | `POLICIES_PATH` |
| `--dry-run` | - | Simulate API calls inside `execute` sandbox without sending live network requests | `DRY_RUN` (`"true"`) |
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
