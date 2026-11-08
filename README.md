# Codemode

[![CI & Policy Benchmark](https://github.com/minteeqahmed-png/Codemode/actions/workflows/ci.yml/badge.svg)](https://github.com/minteeqahmed-png/Codemode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Turn **any** large OpenAPI v3 specification (Cloudflare, GitHub, Stripe, Kubernetes, Jira) into a 2-tool **Code Mode MCP Server** (`search` + `execute`) with 99.7% fewer tokens and built-in policy auditing.

## Why Code Mode?
Traditional MCP servers register 1 tool per REST endpoint. For large APIs (500–2,500+ endpoints), tool schemas alone consume **75k–1.1M+ tokens** before the conversation even starts.

Following Cloudflare's **Code Mode** pattern, this project exposes only two MCP tools (~218 tokens total):
1. **`search`**: Queries the OpenAPI spec on demand by keyword, tag, or HTTP method.
2. **`execute`**: Runs a lightweight JavaScript snippet in an isolated sandbox using `await api.request(method, path, body)` while enforcing real-time security and audit policies.

## Quick Start

### 1. Run the Live Proof-of-Concept & Benchmark
```bash
npm run demo
```

### 2. Connect Any OpenAPI URL or Local File via CLI
```bash
node src/server.ts --spec https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json --base-url https://api.github.com --dry-run
```

### 3. Add to Your MCP Client (`mcp_config.json`)
```json
{
  "mcpServers": {
    "github-codemode": {
      "command": "node",
      "args": [
        "path/to/Codemode/src/server.ts",
        "--spec",
        "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json"
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
