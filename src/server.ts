#!/usr/bin/env node
import fs from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  indexOpenApiSpec,
  searchSpec,
  executeCodeMode,
  defaultAuditPolicies,
  loadPolicyConfig,
  readPolicyConfigFile,
  type OpenApiEndpoint,
  type PolicyRule,
  type PolicyConfigFile,
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
  private timeoutMs?: number;

  constructor(options: {
    spec: Record<string, any>;
    baseUrl?: string;
    headers?: Record<string, string>;
    policies?: PolicyRule[];
    dryRun?: boolean;
    timeoutMs?: number;
  }) {
    this.endpoints = indexOpenApiSpec(options.spec);
    this.baseUrl =
      options.baseUrl ??
      options.spec.servers?.[0]?.url ??
      "https://api.cloudflare.com/client/v4";
    this.headers = options.headers ?? {};
    this.policies = options.policies ?? defaultAuditPolicies;
    this.dryRun = options.dryRun ?? false;
    this.timeoutMs = options.timeoutMs;
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
          timeoutMs: this.timeoutMs,
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
 * Built-in presets for popular OpenAPI specifications.
 */
export interface ApiPreset {
  spec: string;
  baseUrl: string;
  name: string;
  description?: string;
}

export const API_PRESETS: Record<"cloudflare" | "github" | "stripe" | "kubernetes", ApiPreset> = {
  cloudflare: {
    name: "Cloudflare",
    spec: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
    baseUrl: "https://api.cloudflare.com/client/v4",
    description: "Cloudflare Client API v4",
  },
  github: {
    name: "GitHub",
    spec: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    baseUrl: "https://api.github.com",
    description: "GitHub REST API v3",
  },
  stripe: {
    name: "Stripe",
    spec: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    baseUrl: "https://api.stripe.com",
    description: "Stripe REST API",
  },
  kubernetes: {
    name: "Kubernetes",
    spec: "https://raw.githubusercontent.com/kubernetes/kubernetes/master/api/openapi-spec/swagger.json",
    baseUrl: "https://kubernetes.default.svc",
    description: "Kubernetes Cluster API",
  },
};

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

export function parseCliArgs(argv: string[]) {
  const args: {
    preset?: string;
    spec?: string;
    baseUrl?: string;
    token?: string;
    policies?: string;
    timeoutMs?: number;
    dryRun?: boolean;
    help?: boolean;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--preset" || arg === "-P") args.preset = argv[++i];
    else if (arg === "--spec" || arg === "-s") args.spec = argv[++i];
    else if (arg === "--base-url" || arg === "-b") args.baseUrl = argv[++i];
    else if (arg === "--token" || arg === "-t") args.token = argv[++i];
    else if (arg === "--policies" || arg === "-p") args.policies = argv[++i];
    else if (arg === "--timeout-ms") {
      const val = argv[++i];
      args.timeoutMs = val !== undefined ? Number(val) : undefined;
    }
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(
      `Usage: codemode [--preset <name> | --spec <url-or-file>] [--policies <policies.json>] [--timeout-ms <ms>] [--base-url <url>] [--token <api-token>] [--dry-run]`
    );
    console.log(`\nOptions:`);
    console.log(`  -P, --preset <name>       Preset OpenAPI spec (${Object.keys(API_PRESETS).join(", ")})`);
    console.log(`  -s, --spec <url-or-file>  OpenAPI v3 JSON specification URL or local file path`);
    console.log(`  -b, --base-url <url>      API base URL (overrides preset or spec default)`);
    console.log(`  -t, --token <api-token>   Bearer token for API authorization`);
    console.log(`  -p, --policies <file>     Custom policies JSON configuration path`);
    console.log(`      --timeout-ms <ms>     Sandbox VM execution timeout in milliseconds`);
    console.log(`      --dry-run             Simulate API execution without firing live HTTP calls`);
    console.log(`  -h, --help                Show this help message`);
    return;
  }

  const presetKey = cli.preset ? (cli.preset.toLowerCase() as keyof typeof API_PRESETS) : undefined;
  const preset = presetKey ? API_PRESETS[presetKey] : undefined;
  if (cli.preset && !preset) {
    console.error(
      `Unknown preset "${cli.preset}". Supported presets are: ${Object.keys(API_PRESETS).join(", ")}`
    );
    process.exit(1);
  }

  const specSource = cli.spec ?? preset?.spec ?? process.env.OPENAPI_SPEC_PATH;
  if (!specSource) {
    console.error("Error: Please provide --preset <name> or --spec <url-or-file>.");
    process.exit(1);
  }

  const spec = await loadOpenApiSpec(specSource);
  const policyPath = cli.policies ?? process.env.POLICIES_PATH;
  const policyConfig = await readPolicyConfigFile(policyPath);
  const policies = await loadPolicyConfig(policyPath);
  const token = cli.token ?? process.env.API_TOKEN;
  const baseUrl = cli.baseUrl ?? preset?.baseUrl ?? process.env.API_BASE_URL;
  const timeoutMs =
    cli.timeoutMs ??
    policyConfig?.timeoutMs ??
    (process.env.TIMEOUT_MS ? Number(process.env.TIMEOUT_MS) : undefined);
  const server = new CodeModeMcpServer({
    spec,
    baseUrl,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    policies,
    dryRun: cli.dryRun ?? process.env.DRY_RUN === "true",
    timeoutMs,
  });
  server.startStdio();
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
