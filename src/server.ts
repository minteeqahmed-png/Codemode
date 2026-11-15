#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
function parseSimpleYaml(text: string): OpenApiSpec {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ""))
    .filter((l) => l.trim().length > 0);
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; container: Record<string, unknown> | unknown[] }> = [
    { indent: -1, container: root },
  ];
  const parseScalar = (val: string): unknown => {
    const t = val.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
  };
  for (let i = 0; i < lines.length; i++) {
    const indent = lines[i].search(/\S/);
    const trimmed = lines[i].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].container;
    if (trimmed.startsWith("- ")) {
      if (Array.isArray(parent)) parent.push(parseScalar(trimmed.slice(2)));
      continue;
    }
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx !== -1 && !Array.isArray(parent)) {
      const key = String(parseScalar(trimmed.slice(0, colonIdx)));
      const rest = trimmed.slice(colonIdx + 1).trim();
      if (rest.length > 0) {
        parent[key] = parseScalar(rest);
      } else {
        const nextTrimmed = lines[i + 1] ? lines[i + 1].trim() : "";
        const child: Record<string, unknown> | unknown[] = nextTrimmed.startsWith("- ") ? [] : {};
        parent[key] = child;
        stack.push({ indent, container: child });
      }
    }
  }
  return root as OpenApiSpec;
}
const YAML = { parse: parseSimpleYaml };
import {
  indexOpenApiSpec,
  searchSpec,
  executeCodeMode,
  defaultAuditPolicies,
  loadPolicyConfig,
  readPolicyConfigFile,
  type OpenApiEndpoint,
  type OpenApiSpec,
  type PolicyRule,
  type PolicyConfigFile,
} from "./index.ts";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

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
  private maxResponseBytes: number;

  constructor(options: {
    spec: OpenApiSpec;
    baseUrl?: string;
    headers?: Record<string, string>;
    policies?: PolicyRule[];
    dryRun?: boolean;
    timeoutMs?: number;
    maxResponseBytes?: number;
  }) {
    this.endpoints = indexOpenApiSpec(options.spec);
    this.baseUrl = this.resolveBaseUrl(options.spec, options.baseUrl);
    this.headers = options.headers ?? {};
    this.policies = options.policies ?? defaultAuditPolicies;
    this.dryRun = options.dryRun ?? false;
    this.timeoutMs = options.timeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? 32768;
  }

  /**
   * Resolves the base URL from an explicit override, OpenAPI 3.x `servers`, or Swagger 2.0 host/basePath/schemes.
   */
  private resolveBaseUrl(spec: OpenApiSpec, explicitBaseUrl?: string): string {
    if (explicitBaseUrl) return explicitBaseUrl;
    if (spec?.servers?.[0]?.url) return spec.servers[0].url;

    // Swagger 2.0 resolution: schemes + host + basePath
    if (spec?.host) {
      const scheme = spec.schemes?.[0] ?? "https";
      const rawBasePath = spec.basePath ?? "";
      const cleanBasePath = rawBasePath
        ? rawBasePath.startsWith("/")
          ? rawBasePath
          : `/${rawBasePath}`
        : "";
      return `${scheme}://${spec.host}${cleanBasePath}`.replace(/\/+$/, "");
    }

    return "https://api.cloudflare.com/client/v4";
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
            includeTypes: {
              type: "boolean",
              description:
                "Include compact TypeScript type hints and resolved parameters/schemas (default true)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "execute",
        description:
          "Execute JavaScript inside an isolated sandbox with access to `await api.request(method, path, body)` and `await api.paginate(method, path, options)`. Enforces audit policies automatically.",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description:
                "Async JavaScript snippet using `await api.request(method, path, body)` or `await api.paginate(method, path, options)` and returning the final filtered result.",
            },
          },
          required: ["code"],
        },
      },
    ];
  }

  public async handleToolCall(name: string, args: Record<string, unknown>) {
    if (name === "search") {
      const methodFilter = typeof args.method === "string" ? args.method : undefined;
      const includeTypes = typeof args.includeTypes === "boolean" ? args.includeTypes : true;
      const matches = searchSpec(this.endpoints, String(args.query ?? ""), methodFilter, {
        includeTypes,
      });
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
          maxResponseBytes: this.maxResponseBytes,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(outcome, null, 2),
            },
          ],
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Processes a single JSON-RPC 2.0 request payload shared across stdio and HTTP/SSE transports.
   */
  public async handleJsonRpcMessage(msg: JsonRpcMessage): Promise<Record<string, unknown> | null> {
    if (msg.method === "initialize") {
      if (msg.id === undefined) return null;
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "codemode", version: "0.2.0" },
        },
      };
    }
    if (msg.method === "tools/list") {
      if (msg.id === undefined) return null;
      return { jsonrpc: "2.0", id: msg.id, result: { tools: this.getTools() } };
    }
    if (msg.method === "tools/call") {
      const res = await this.handleToolCall(
        msg.params?.name ?? "",
        msg.params?.arguments ?? {}
      );
      if (msg.id === undefined) return null;
      return { jsonrpc: "2.0", id: msg.id, result: res };
    }
    if (msg.id !== undefined) {
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    }
    return null;
  }

  public startStdio() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg: JsonRpcMessage | undefined;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
        const response = await this.handleJsonRpcMessage(msg);
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      } catch (err) {
        if (msg?.id !== undefined) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: errorMessage },
            }) + "\n"
          );
        }
      }
    });
  }

  /**
   * Starts a zero-dependency Streamable HTTP & Server-Sent Events (SSE) MCP server
   * supporting `/health`, `/mcp` (POST JSON-RPC 2.0), and `/sse` + `/messages`.
   */
  public async startHttp(options?: { port?: number; host?: string }): Promise<{
    server: http.Server;
    port: number;
    url: string;
    close: () => Promise<void>;
  }> {
    const requestedPort = options?.port ?? 3000;
    const host = options?.host ?? "127.0.0.1";
    const sseClients = new Map<string, http.ServerResponse>();

    const readJsonBody = (req: http.IncomingMessage): Promise<JsonRpcMessage> =>
      new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 1024 * 1024) {
            reject(new Error("Request payload exceeded 1MB limit"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            resolve(JSON.parse(raw) as JsonRpcMessage);
          } catch (err) {
            reject(err);
          }
        });
        req.on("error", reject);
      });

    const server = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      const reqUrl = new URL(req.url ?? "/", `http://${host}`);

      if (req.method === "GET" && reqUrl.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            server: "codemode",
            endpointsIndexed: this.endpoints.length,
            tools: ["search", "execute"],
          })
        );
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/sse") {
        const sessionId = crypto.randomUUID();
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
        sseClients.set(sessionId, res);
        req.on("close", () => {
          sseClients.delete(sessionId);
        });
        return;
      }

      if (req.method === "POST" && (reqUrl.pathname === "/mcp" || reqUrl.pathname === "/messages")) {
        let msg: JsonRpcMessage | undefined;
        try {
          msg = await readJsonBody(req);
          const rpcResponse = await this.handleJsonRpcMessage(msg);
          if (reqUrl.pathname === "/messages") {
            const sessionId = reqUrl.searchParams.get("sessionId") ?? "";
            const stream = sseClients.get(sessionId);
            if (!stream) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Unknown or closed SSE sessionId" }));
              return;
            }
            if (rpcResponse) {
              stream.write(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`);
            }
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ accepted: true, sessionId }));
            return;
          }

          res.writeHead(rpcResponse ? 200 : 204, { "Content-Type": "application/json" });
          res.end(rpcResponse ? JSON.stringify(rpcResponse) : undefined);
          return;
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg?.id ?? null,
              error: { code: -32603, message: errorMessage },
            })
          );
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(requestedPort, host, () => resolve());
    });

    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : requestedPort;

    return {
      server,
      port: boundPort,
      url: `http://${host}:${boundPort}`,
      close: async () => {
        for (const stream of sseClients.values()) {
          stream.end();
        }
        sseClients.clear();
        server.closeAllConnections?.();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      },
    };
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
 * Loads an OpenAPI v3 JSON or YAML specification from either a remote HTTPS URL or a local file path.
 */
export async function loadOpenApiSpec(specSource: string): Promise<OpenApiSpec> {
  let raw: string;
  let isYaml = false;

  if (specSource.startsWith("http://") || specSource.startsWith("https://")) {
    const res = await fetch(specSource);
    if (!res.ok) {
      throw new Error(`Failed to fetch OpenAPI spec from ${specSource}: ${res.status} ${res.statusText}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const urlPath = new URL(specSource).pathname.toLowerCase();
    isYaml =
      urlPath.endsWith(".yaml") ||
      urlPath.endsWith(".yml") ||
      contentType.includes("yaml") ||
      contentType.includes("x-yaml");
    raw = await res.text();
  } else {
    const lowerPath = specSource.toLowerCase();
    isYaml = lowerPath.endsWith(".yaml") || lowerPath.endsWith(".yml");
    raw = await fs.readFile(specSource, "utf8");
  }

  if (isYaml) {
    return YAML.parse(raw);
  }

  try {
    return JSON.parse(raw) as OpenApiSpec;
  } catch (err) {
    // If JSON parsing fails, attempt parsing as YAML as fallback
    try {
      const parsed = YAML.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Re-throw original JSON parse error if YAML parse also fails
    }
    throw err;
  }
}

export function parseCliArgs(argv: string[]) {
  const args: {
    preset?: string;
    spec?: string;
    baseUrl?: string;
    token?: string;
    policies?: string;
    timeoutMs?: number;
    transport?: string;
    port?: number;
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
    } else if (arg === "--transport") args.transport = argv[++i];
    else if (arg === "--port") {
      const val = argv[++i];
      args.port = val !== undefined ? Number(val) : undefined;
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
      `Usage: codemode [--preset <name> | --spec <url-or-file>] [--policies <policies.json>] [--timeout-ms <ms>] [--transport <stdio|http|sse>] [--port <port>] [--base-url <url>] [--token <api-token>] [--dry-run]`
    );
    console.log(`\nOptions:`);
    console.log(`  -P, --preset <name>       Preset OpenAPI spec (${Object.keys(API_PRESETS).join(", ")})`);
    console.log(`  -s, --spec <url-or-file>  OpenAPI v3 JSON/YAML specification URL or local file path`);
    console.log(`  -b, --base-url <url>      API base URL (overrides preset or spec default)`);
    console.log(`  -t, --token <api-token>   Bearer token for API authorization`);
    console.log(`  -p, --policies <file>     Custom policies JSON configuration path`);
    console.log(`      --timeout-ms <ms>     Sandbox VM & async execution timeout in milliseconds`);
    console.log(`      --transport <mode>    MCP transport: stdio (default), http, or sse`);
    console.log(`      --port <port>         HTTP/SSE server port (default 3000)`);
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
  const transport = (cli.transport ?? process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  const port = cli.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);

  const server = new CodeModeMcpServer({
    spec,
    baseUrl,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    policies,
    dryRun: cli.dryRun ?? process.env.DRY_RUN === "true",
    timeoutMs,
    maxResponseBytes: policyConfig?.maxResponseBytes,
  });

  if (transport === "http" || transport === "sse") {
    const running = await server.startHttp({ port });
    console.log(`Codemode MCP HTTP/SSE server listening at ${running.url} (POST /mcp, GET /sse, GET /health)`);
  } else {
    server.startStdio();
  }
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
