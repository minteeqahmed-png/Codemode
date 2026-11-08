# AGENTS.md — Codemode Repository Guide

This file provides context, commands, and architectural rules for AI coding agents (including Google **Jules**) working on **Codemode**.

## Project Overview
**Codemode** (`codemode`) turns massive OpenAPI v3 specifications (Cloudflare, GitHub, Stripe, Kubernetes, Jira) into a 2-tool **Code Mode MCP Server** (`search` + `execute`) with 99.7% fewer prompt tokens and sandboxed security guardrails.

- **Sole Owner & Maintainer**: Minteeq Ahmed (`@minteeqahmed-png`)
- **Runtime**: Node.js 24+ (supports native TypeScript execution via `node src/server.ts`)

## Key Files
- `src/index.ts`: Core OpenAPI v3 indexer (`indexOpenApiSpec`), keyword/tag search (`searchSpec`), isolated `node:vm` sandbox executor (`executeCodeMode`), and configurable policy engine (`buildAuditPolicies`, `loadPolicyConfig`).
- `src/server.ts`: JSON-RPC 2.0 stdio MCP server (`CodeModeMcpServer`), remote/local spec loader (`loadOpenApiSpec`), and CLI argument parser.
- `src/demo.ts`: End-to-end 500-endpoint benchmark and 5-policy verification suite.
- `policies.json`: Default security and CIDR guardrail configuration.

## Verification Commands
Always run both commands before opening or updating a Pull Request:

```bash
# 1. Verify CLI entrypoint
node src/server.ts --help

# 2. Run the 500-endpoint benchmark and enterprise policy test suite
npm run demo
```

## Coding & Architecture Guardrails
1. **Keep the MCP Tool Surface to 2 Tools**: Never register individual OpenAPI endpoints as separate MCP tools. All endpoint discovery must happen through `search` and all execution through `execute`.
2. **Preserve Sandbox & Policy Enforcement**: Every network call inside `executeCodeMode` must pass through the `policies` check loop before `fetch()` is invoked.
3. **Zero Unnecessary Dependencies**: Prefer Node.js built-in modules (`node:vm`, `node:fs/promises`, `node:readline`, global `fetch`) whenever possible.
