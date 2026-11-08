#!/usr/bin/env node
import fs from "node:fs/promises";
import readline from "node:readline";
import {
  indexOpenApiSpec,
  searchSpec,
  executeCodeMode,
  defaultAuditPolicies,
  loadPolicyConfig,
  type OpenApiEndpoint,
  type PolicyRule,
} from "./index.ts";

/**
 * Lightweight, zero-bloat MCP Stdio Server implementing Cloudflare's Code Mode pattern
 * (`search` + `execute`) for any OpenAPI v3 specification.
 */
export class CodeModeMcpServer {
  private endpoints: OpenApiEndpoint[] = [];
  private baseUrl: string;
  private headers: Record<string, string>;
  private policies: PolicyRule[];
  private dryRun: boolean;

  constructor(options: {
    spec: Record<string, any>;
    baseUrl?: string;
    headers?: Record<string, string>;
    policies?: PolicyRule[];
    dryRun?: boolean;
  }) {
    this.endpoints = indexOpenApiSpec(options.spec);
    this.baseUrl =
      options.baseUrl ??
      options.spec.servers?.[0]?.url ??
      "https://api.cloudflare.com/client/v4";
    this.headers = options.headers ?? {};
    this.policies = options.policies ?? defaultAuditPolicies;
    this.dryRun = options.dryRun ?? false;
  }

  /**
   * Returns the 2-tool Code Mode definition (~218 tokens total instead of 500k+ tokens).
   */
  public getTools() {
    return [
      {
        name: "search",
        description:
          "Search the OpenAPI specification by keyword, resource tag, or HTTP method to discover endpoints and schemas on demand.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Keywords to match against path, summary, tags, or operationId (e.g. 'dns records', 'firewall')",
            },
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
              description: "Optional HTTP method filter",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "execute",
        description:
          "Execute JavaScript inside an isolated sandbox with access to `await api.request(method, path, body)`. Enforces audit policies automatically.",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description:
                "Async JavaScript snippet using `await api.request(method, path, body)` and returning the final filtered result.",
            },
          },
          required: ["code"],
        },
      },
    ];
  }

  public async handleToolCall(name: string, args: Record<string, any>) {
    if (name === "search") {
      const matches = searchSpec(this.endpoints, String(args.query ?? ""), args.method);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                totalIndexedEndpoints: this.endpoints.length,
                matchCount: matches.length,
                endpoints: matches,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "execute") {
      try {
        const outcome = await executeCodeMode(String(args.code ?? ""), {
          baseUrl: this.baseUrl,
          headers: this.headers,
          policies: this.policies,
          dryRun: this.dryRun,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(outcome, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: err?.message ?? String(err) }, null, 2),
            },
          ],
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  public startStdio() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
        if (msg.method === "initialize") {
          this.sendResponse(msg.id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "codemode", version: "0.1.0" },
          });
        } else if (msg.method === "tools/list") {
          this.sendResponse(msg.id, { tools: this.getTools() });
        } else if (msg.method === "tools/call") {
          const res = await this.handleToolCall(msg.params?.name, msg.params?.arguments ?? {});
          this.sendResponse(msg.id, res);
        } else if (msg.id !== undefined) {
          this.sendResponse(msg.id, {});
        }
      } catch (err: any) {
        if (msg?.id !== undefined) {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: err?.message ?? "Internal error" },
            }) + "\n"
          );
        }
      }
    });
  }

  private sendResponse(id: string | number, result: unknown) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
}

/**
 * Loads an OpenAPI v3 JSON specification from either a remote HTTPS URL or a local file path.
 */
export async function loadOpenApiSpec(specSource: string): Promise<Record<string, any>> {
  if (specSource.startsWith("http://") || specSource.startsWith("https://")) {
    const res = await fetch(specSource);
    if (!res.ok) {
      throw new Error(`Failed to fetch OpenAPI spec from ${specSource}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as Record<string, any>;
  }
  const raw = await fs.readFile(specSource, "utf8");
  return JSON.parse(raw);
}

function parseCliArgs(argv: string[]) {
  const args: {
    spec?: string;
    baseUrl?: string;
    token?: string;
    policies?: string;
    dryRun?: boolean;
    help?: boolean;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--spec" || arg === "-s") args.spec = argv[++i];
    else if (arg === "--base-url" || arg === "-b") args.baseUrl = argv[++i];
    else if (arg === "--token" || arg === "-t") args.token = argv[++i];
    else if (arg === "--policies" || arg === "-p") args.policies = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(
      `Usage: codemode --spec <url-or-file> [--policies <policies.json>] [--base-url <url>] [--token <api-token>] [--dry-run]`
    );
    return;
  }

  const specSource = cli.spec ?? process.env.OPENAPI_SPEC_PATH;
  if (!specSource) {
    return;
  }

  const spec = await loadOpenApiSpec(specSource);
  const policies = await loadPolicyConfig(cli.policies ?? process.env.POLICIES_PATH);
  const token = cli.token ?? process.env.API_TOKEN;
  const server = new CodeModeMcpServer({
    spec,
    baseUrl: cli.baseUrl ?? process.env.API_BASE_URL,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    policies,
    dryRun: cli.dryRun ?? process.env.DRY_RUN === "true",
  });
  server.startStdio();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
