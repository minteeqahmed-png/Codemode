# AGENTS.md — Codemode Repository Guide

> **Standing Autonomous Agent Prompt:**
> *"Monitor the repository, create issues for detected bugs or tech debt, draft pull requests for fixes, and maintain code quality standards automatically."*

## Two-Step Verification Pipeline
This repository enforces a structured **Two-Step Verification Workflow** before merging:
1. **Step 1 (Anti-gravity / Implementer):** An automated agent (Anti-gravity / Google AI Studio / contributor) creates the solution, tests it, and opens a Pull Request.
2. **Step 2 (Codex Reviewer):** An automated OpenAI Codex engine (`src/codex-review.ts` and `.github/workflows/two-step-verification.yml`) reviews the PR diff for:
   - Strict 2-tool MCP limit (`search` + `execute`).
   - Sandbox security & policy enforcement (no unvalidated execution or timeouts).
   - Zero-dependency footprint.
   - Strict TypeScript types (no unchecked `any`).
3. **Step 3 (Owner Approval):** The maintainer (@minteeqahmed-png) inspects the Codex review scorecard and gives the final approval (`approve` / `reject`).

This file provides context, commands, and architectural rules for AI coding agents (including Antigravity and Google **Jules**) working on **Codemode**.

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
