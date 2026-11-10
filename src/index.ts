import vm from "node:vm";
import fs from "node:fs/promises";

export interface OpenApiEndpoint {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
}

export interface PolicyRule {
  id: string;
  description: string;
  check: (
    method: string,
    path: string,
    body?: unknown,
    context?: { requestCount: number }
  ) => { allowed: boolean; reason?: string };
}

export interface PolicyConfigFile {
  allowDelete?: boolean;
  maxRequestsPerExecution?: number;
  blockedCidrs?: string[];
  protectedPathPrefixes?: string[];
  blockInsecureHttpUrls?: boolean;
  timeoutMs?: number;
}

/**
 * Builds the full suite of security & infrastructure audit policies,
 * optionally merging user overrides from a JSON policy config.
 */
export function buildAuditPolicies(config?: PolicyConfigFile): PolicyRule[] {
  const allowDelete = config?.allowDelete ?? false;
  const maxRequests = config?.maxRequestsPerExecution ?? 25;
  const blockedCidrs = config?.blockedCidrs ?? ["0.0.0.0/0", "::/0"];
  const protectedPrefixes = config?.protectedPathPrefixes ?? ["/billing", "/members", "/iam"];
  const blockHttp = config?.blockInsecureHttpUrls ?? true;

  return [
    {
      id: "rate-limit-per-execution",
      description: `Prevent runaway loops by capping sandbox execution at ${maxRequests} API calls`,
      check: (_method, _path, _body, ctx) => {
        if ((ctx?.requestCount ?? 0) > maxRequests) {
          return {
            allowed: false,
            reason: `Exceeded max API calls per execution (${maxRequests}) by policy 'rate-limit-per-execution'.`,
          };
        }
        return { allowed: true };
      },
    },
    {
      id: "block-destructive-delete",
      description: "Prevent unapproved DELETE operations in read/audit mode",
      check: (method, path) => {
        if (!allowDelete && method.toUpperCase() === "DELETE") {
          return {
            allowed: false,
            reason: `Blocked destructive DELETE on ${path} by policy 'block-destructive-delete'.`,
          };
        }
        return { allowed: true };
      },
    },
    {
      id: "block-wildcard-dns-or-firewall",
      description: `Prevent overly permissive CIDR rules (${blockedCidrs.join(", ")})`,
      check: (_method, _path, body) => {
        const serialized = JSON.stringify(body ?? "");
        for (const cidr of blockedCidrs) {
          if (serialized.includes(cidr)) {
            return {
              allowed: false,
              reason: `Blocked open CIDR rule (${cidr}) by policy 'block-wildcard-dns-or-firewall'.`,
            };
          }
        }
        return { allowed: true };
      },
    },
    {
      id: "protect-sensitive-account-paths",
      description: `Prevent modifications to sensitive paths (${protectedPrefixes.join(", ")})`,
      check: (method, path) => {
        if (method.toUpperCase() !== "GET") {
          for (const prefix of protectedPrefixes) {
            if (path.includes(prefix)) {
              return {
                allowed: false,
                reason: `Blocked write operation on protected path '${prefix}' (${path}) by policy 'protect-sensitive-account-paths'.`,
              };
            }
          }
        }
        return { allowed: true };
      },
    },
    {
      id: "block-insecure-http-origins",
      description: "Prevent configuring unencrypted http:// webhooks or origin servers",
      check: (method, _path, body) => {
        if (blockHttp && method.toUpperCase() !== "GET" && body) {
          const serialized = JSON.stringify(body);
          if (serialized.includes("http://") && !serialized.includes("http://localhost")) {
            return {
              allowed: false,
              reason: "Blocked unencrypted 'http://' origin/webhook target by policy 'block-insecure-http-origins'.",
            };
          }
        }
        return { allowed: true };
      },
    },
  ];
}

export const defaultAuditPolicies: PolicyRule[] = buildAuditPolicies();

/**
 * Reads a policy JSON configuration file if provided.
 */
export async function readPolicyConfigFile(policyPath?: string): Promise<PolicyConfigFile | undefined> {
  if (!policyPath) return undefined;
  const raw = await fs.readFile(policyPath, "utf8");
  return JSON.parse(raw) as PolicyConfigFile;
}

/**
 * Loads custom policy overrides from a JSON file if provided.
 */
export async function loadPolicyConfig(policyPath?: string): Promise<PolicyRule[]> {
  if (!policyPath) return defaultAuditPolicies;
  const parsed = await readPolicyConfigFile(policyPath);
  return buildAuditPolicies(parsed);
}

/**
 * Parses an OpenAPI v3 document into a compact searchable index.
 */
export function indexOpenApiSpec(spec: Record<string, any>): OpenApiEndpoint[] {
  const endpoints: OpenApiEndpoint[] = [];
  const paths = spec.paths ?? {};

  for (const [pathKey, methods] of Object.entries<Record<string, any>>(paths)) {
    for (const [httpMethod, details] of Object.entries<Record<string, any>>(methods)) {
      if (["get", "post", "put", "patch", "delete"].includes(httpMethod.toLowerCase())) {
        endpoints.push({
          method: httpMethod.toUpperCase(),
          path: pathKey,
          operationId: details.operationId,
          summary: details.summary,
          description: details.description,
          tags: details.tags,
          parameters: details.parameters,
          requestBody: details.requestBody,
        });
      }
    }
  }
  return endpoints;
}

/**
 * Tool 1: `search`
 * Lets the AI agent search thousands of OpenAPI endpoints on demand without bloating context.
 */
export function searchSpec(
  endpoints: OpenApiEndpoint[],
  query: string,
  methodFilter?: string
): OpenApiEndpoint[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return endpoints
    .filter((ep) => {
      if (methodFilter && ep.method !== methodFilter.toUpperCase()) return false;
      const haystack =
        `${ep.method} ${ep.path} ${ep.operationId ?? ""} ${ep.summary ?? ""} ${ep.description ?? ""} ${(ep.tags ?? []).join(" ")}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    })
    .slice(0, 15);
}

/**
 * Tool 2: `execute`
 * Runs agent-generated JavaScript inside an isolated Node VM context with an audited `api.request()` helper.
 */
export async function executeCodeMode(
  code: string,
  options: {
    baseUrl: string;
    headers?: Record<string, string>;
    policies?: PolicyRule[];
    dryRun?: boolean;
    timeoutMs?: number;
  }
) {
  const auditLog: Array<{ method: string; path: string; status: string; reason?: string }> = [];
  const policies = options.policies ?? defaultAuditPolicies;
  const timeoutMs = options.timeoutMs ?? 5000;
  let requestCount = 0;

  const apiHelper = {
    request: async (method: string, path: string, body?: unknown) => {
      requestCount++;
      for (const policy of policies) {
        const verdict = policy.check(method, path, body, { requestCount });
        if (!verdict.allowed) {
          auditLog.push({ method, path, status: "BLOCKED", reason: verdict.reason });
          throw new Error(verdict.reason);
        }
      }

      if (options.dryRun) {
        auditLog.push({ method, path, status: "DRY_RUN_OK" });
        return { dryRun: true, method, path, body };
      }

      let url: string;
      if (path.startsWith("http://") || path.startsWith("https://")) {
        url = new URL(path).toString();
      } else {
        const base = new URL(options.baseUrl);
        const basePath = base.pathname.replace(/\/+$/, "");
        const [pathname, search] = path.split("?");
        const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
        base.pathname = `${basePath}${cleanPath}`;
        if (search !== undefined) {
          base.search = search ? `?${search}` : "";
        }
        url = base.toString();
      }

      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      auditLog.push({ method, path, status: `${response.status}` });
      return response.json();
    },
  };

  const sandbox = vm.createContext({
    api: apiHelper,
    console: {
      log: (...args: unknown[]) =>
        auditLog.push({ method: "LOG", path: "-", status: args.map(String).join(" ") }),
    },
  });

  const wrappedScript = `(async () => { ${code} })()`;
  const result = await vm.runInContext(wrappedScript, sandbox, { timeout: timeoutMs });

  return {
    result,
    auditLog,
  };
}
