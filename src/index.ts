import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenApiServer {
  url: string;
  description?: string;
  variables?: Record<
    string,
    { default?: string; enum?: string[]; description?: string; [key: string]: unknown }
  >;
  [key: string]: unknown;
}

export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  host?: string;
  basePath?: string;
  schemes?: string[];
  info?: {
    title: string;
    version: string;
    description?: string;
    [key: string]: unknown;
  };
  servers?: OpenApiServer[];
  paths?: Record<string, Record<string, OpenApiOperation | unknown>>;
  [key: string]: unknown;
}

export interface OpenApiTypeHints {
  parameters?: string;
  requestBody?: string;
  response?: string;
}

export interface OpenApiEndpoint {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responseSchema?: unknown;
  typeHints?: OpenApiTypeHints;
}

export interface AuditLogEntry {
  method: string;
  path: string;
  status: string;
  reason?: string;
  durationMs?: number;
}

export interface DryRunSummary {
  totalCalls: number;
  allowedCalls: number;
  blockedCalls: number;
  targets: Array<{ method: string; path: string; status: string }>;
}

export interface BatchRequestItem {
  method: string;
  path: string;
  body?: unknown;
}

export interface BatchExecutionResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    index: number;
    method: string;
    path: string;
    ok: boolean;
    data?: unknown;
    error?: string;
  }>;
}

export interface SimulationResult {
  allowed: boolean;
  totalChecked: number;
  allowedCount: number;
  blockedCount: number;
  verdicts: Array<{
    method: string;
    path: string;
    allowed: boolean;
    reason?: string;
  }>;
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
  maxResponseBytes?: number;
}

/**
 * Safely URL-decodes and normalizes an API request path (collapsing `/./` and `/../` dot segments)
 * so encoded or traversal paths cannot bypass `protect-sensitive-account-paths`.
 */
export function normalizeApiPath(rawPath: string): string {
  let pathname = rawPath.trim();
  if (pathname.startsWith("http://") || pathname.startsWith("https://")) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      pathname = pathname.split("?")[0] ?? pathname;
    }
  } else {
    pathname = pathname.split("?")[0] ?? pathname;
  }
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const ensuredLeadingSlash = decoded.startsWith("/") ? decoded : `/${decoded}`;
  return path.posix.normalize(ensuredLeadingSlash);
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
      check: (method, requestPath) => {
        if (method.toUpperCase() !== "GET") {
          const rawNormalized = requestPath.toLowerCase();
          const canonicalPath = normalizeApiPath(requestPath).toLowerCase();
          for (const prefix of protectedPrefixes) {
            const lowerPrefix = prefix.toLowerCase();
            if (rawNormalized.includes(lowerPrefix) || canonicalPath.includes(lowerPrefix)) {
              return {
                allowed: false,
                reason: `Blocked write operation on protected path '${prefix}' (${requestPath}) by policy 'protect-sensitive-account-paths'.`,
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
      check: (method, requestPath, body) => {
        if (blockHttp) {
          const trimmedLower = requestPath.trim().toLowerCase();
          if (
            trimmedLower.startsWith("http://") &&
            !trimmedLower.startsWith("http://localhost") &&
            !trimmedLower.startsWith("http://127.0.0.1")
          ) {
            return {
              allowed: false,
              reason: "Blocked unencrypted 'http://' origin/webhook target by policy 'block-insecure-http-origins'.",
            };
          }
        }
        if (blockHttp && method.toUpperCase() !== "GET" && body) {
          const serialized = JSON.stringify(body);
          // Match every http:// URL independently so localhost in one field cannot mask an insecure target in another.
          const httpUrls = serialized.match(/http:\/\/[^\s"'`,\]}]+/gi) ?? [];
          const hasInsecureTarget = httpUrls.some((url) => {
            const lower = url.toLowerCase();
            return (
              !lower.startsWith("http://localhost") &&
              !lower.startsWith("http://127.0.0.1")
            );
          });
          if (hasInsecureTarget) {
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
 * Resolves an internal OpenAPI JSON Pointer reference (e.g. "#/components/schemas/Zone").
 */
export function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const seg of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Follows top-level `$ref` pointers without prematurely inlining nested schema children,
 * preserving `$ref` identity for cycle-aware schema resolution and TypeScript type hints.
 */
function unwrapRef(spec: OpenApiSpec, node: unknown, seen: Set<string> = new Set()): unknown {
  let current = node;
  while (current && typeof current === "object" && !Array.isArray(current)) {
    const ref = (current as Record<string, unknown>).$ref;
    if (typeof ref !== "string" || seen.has(ref)) break;
    const resolved = resolveJsonPointer(spec, ref);
    if (!resolved || typeof resolved !== "object") break;
    seen.add(ref);
    current = resolved;
  }
  return current;
}

/**
 * Recursively resolves internal `$ref` schemas with cycle detection and bounded depth.
 */
export function resolveSchemaNode(
  spec: OpenApiSpec,
  node: unknown,
  seen: Set<string> = new Set(),
  depth = 0
): unknown {
  if (!node || typeof node !== "object" || depth > 12) return node;
  if (Array.isArray(node)) {
    return node.map((item) => resolveSchemaNode(spec, item, seen, depth + 1));
  }

  const record = node as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    const ref = record.$ref;
    if (seen.has(ref)) return { circularRef: ref };
    const resolved = resolveJsonPointer(spec, ref);
    if (!resolved || typeof resolved !== "object") return record;
    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    return resolveSchemaNode(spec, resolved, nextSeen, depth + 1);
  }

  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    copy[k] = resolveSchemaNode(spec, v, seen, depth + 1);
  }
  return copy;
}

/**
 * Renders an OpenAPI JSON schema as a compact inline TypeScript type preview for LLM code generation.
 */
export function schemaToTsType(
  schema: unknown,
  spec?: OpenApiSpec,
  seen: Set<string> = new Set(),
  depth = 0
): string {
  if (!schema || typeof schema !== "object") return "unknown";

  const resolved = spec ? resolveSchemaNode(spec, schema, seen, depth) : schema;
  if (!resolved || typeof resolved !== "object") return "unknown";
  const obj = resolved as Record<string, unknown>;

  if (typeof obj.circularRef === "string") {
    return obj.circularRef.split("/").pop() ?? "unknown";
  }
  if (Array.isArray(obj.enum) && obj.enum.length > 0) {
    return obj.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  const schemaType = obj.type;
  if (schemaType === "integer" || schemaType === "number") return "number";
  if (schemaType === "boolean") return "boolean";
  if (schemaType === "string") return "string";

  if (depth > 4) {
    return schemaType === "array" ? "unknown[]" : "Record<string, unknown>";
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length > 0) {
      return (obj[key] as unknown[])
        .slice(0, 4)
        .map((sub) => schemaToTsType(sub, spec, seen, depth + 1))
        .join(" | ");
    }
  }
  if (Array.isArray(obj.allOf) && obj.allOf.length > 0) {
    return obj.allOf
      .slice(0, 4)
      .map((sub) => schemaToTsType(sub, spec, seen, depth + 1))
      .join(" & ");
  }

  if (schemaType === "array") {
    const itemTs = schemaToTsType(obj.items, spec, seen, depth + 1);
    return itemTs.includes("|") || itemTs.includes("&") ? `Array<${itemTs}>` : `${itemTs}[]`;
  }

  if (schemaType === "object" || (obj.properties && typeof obj.properties === "object")) {
    const props = (obj.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(obj.required) ? obj.required.map(String) : []);
    const entries = Object.entries(props).slice(0, 8);
    if (entries.length === 0) return "Record<string, unknown>";
    const formatted = entries.map(([propName, propSchema]) => {
      const opt = required.has(propName) ? "" : "?";
      return `${propName}${opt}: ${schemaToTsType(propSchema, spec, seen, depth + 1)}`;
    });
    if (Object.keys(props).length > entries.length) {
      formatted.push("...");
    }
    return `{ ${formatted.join("; ")} }`;
  }

  return "unknown";
}

function extractRequestBodySchema(spec: OpenApiSpec, op: OpenApiOperation): unknown {
  const reqBody = unwrapRef(spec, op.requestBody);
  if (!reqBody || typeof reqBody !== "object") return undefined;
  const content = (reqBody as Record<string, unknown>).content;
  if (content && typeof content === "object") {
    const jsonEntry = (content as Record<string, unknown>)["application/json"];
    if (jsonEntry && typeof jsonEntry === "object") {
      return resolveSchemaNode(spec, (jsonEntry as Record<string, unknown>).schema);
    }
  }
  return resolveSchemaNode(spec, reqBody);
}

function extractSuccessResponseSchema(spec: OpenApiSpec, op: OpenApiOperation): unknown {
  if (!op.responses || typeof op.responses !== "object") return undefined;
  const successKey = ["200", "201", "202", "default"].find((code) => code in op.responses!);
  if (!successKey) return undefined;
  const rawResponse = unwrapRef(spec, op.responses[successKey]);
  if (!rawResponse || typeof rawResponse !== "object") return undefined;
  const respObj = rawResponse as Record<string, unknown>;

  // OpenAPI v3 response structure
  if (respObj.content && typeof respObj.content === "object") {
    const jsonMedia = (respObj.content as Record<string, unknown>)["application/json"];
    if (jsonMedia && typeof jsonMedia === "object") {
      return resolveSchemaNode(spec, (jsonMedia as Record<string, unknown>).schema);
    }
  }
  // Swagger 2.0 response schema directly under response object
  if (respObj.schema) {
    return resolveSchemaNode(spec, respObj.schema);
  }
  return undefined;
}

function buildEndpointTypeHints(
  spec: OpenApiSpec,
  parameters: unknown[] | undefined,
  reqSchema: unknown,
  resSchema: unknown
): OpenApiTypeHints | undefined {
  const hints: OpenApiTypeHints = {};
  if (Array.isArray(parameters) && parameters.length > 0) {
    const paramParts = parameters.slice(0, 8).map((raw) => {
      const p = (resolveSchemaNode(spec, raw) ?? {}) as Record<string, unknown>;
      const name = String(p.name ?? "param");
      const opt = p.required === true ? "" : "?";
      const paramType = schemaToTsType(p.schema ?? p, spec);
      return `${name}${opt}: ${paramType}`;
    });
    hints.parameters = `{ ${paramParts.join("; ")} }`;
  }
  if (reqSchema) {
    hints.requestBody = schemaToTsType(reqSchema, spec);
  }
  if (resSchema) {
    hints.response = schemaToTsType(resSchema, spec);
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

/**
 * Parses an OpenAPI v3 or Swagger 2.0 document into a compact searchable index
 * with resolved `$ref` schemas and TypeScript type hints.
 */
export function indexOpenApiSpec(spec: OpenApiSpec): OpenApiEndpoint[] {
  const endpoints: OpenApiEndpoint[] = [];
  const paths = spec.paths ?? {};

  for (const [pathKey, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    const rawPathParams = Array.isArray((methods as Record<string, unknown>).parameters)
      ? ((methods as Record<string, unknown>).parameters as unknown[])
      : [];
    for (const [httpMethod, details] of Object.entries(methods)) {
      if (["get", "post", "put", "patch", "delete"].includes(httpMethod.toLowerCase())) {
        const op = (details && typeof details === "object" ? details : {}) as OpenApiOperation;
        const rawOpParams = Array.isArray(op.parameters) ? op.parameters : [];
        const mergedParamList: unknown[] = [];
        const paramIndexByKey = new Map<string, number>();
        for (const rawParam of [...rawPathParams, ...rawOpParams]) {
          const resolvedParam = resolveSchemaNode(spec, rawParam);
          if (resolvedParam && typeof resolvedParam === "object") {
            const pObj = resolvedParam as Record<string, unknown>;
            const key = `${String(pObj.name ?? "")}:${String(pObj.in ?? "")}`;
            if (key !== ":" && paramIndexByKey.has(key)) {
              mergedParamList[paramIndexByKey.get(key)!] = resolvedParam;
              continue;
            }
            if (key !== ":") {
              paramIndexByKey.set(key, mergedParamList.length);
            }
          }
          mergedParamList.push(resolvedParam);
        }
        const resolvedParams = mergedParamList.length > 0 ? mergedParamList : undefined;
        const resolvedReqBody = extractRequestBodySchema(spec, op);
        const resolvedResponse = extractSuccessResponseSchema(spec, op);
        const typeHints = buildEndpointTypeHints(
          spec,
          resolvedParams,
          resolvedReqBody,
          resolvedResponse
        );

        endpoints.push({
          method: httpMethod.toUpperCase(),
          path: pathKey,
          operationId: op.operationId,
          summary: op.summary,
          description: op.description,
          tags: op.tags,
          parameters: resolvedParams,
          requestBody: resolvedReqBody ?? op.requestBody,
          responseSchema: resolvedResponse,
          typeHints,
        });
      }
    }
  }
  return endpoints;
}

function scoreEndpointRelevance(ep: OpenApiEndpoint, terms: string[]): number {
  if (terms.length === 0) return 1;
  const opId = (ep.operationId ?? "").toLowerCase();
  const epPath = ep.path.toLowerCase();
  const tags = (ep.tags ?? []).join(" ").toLowerCase();
  const text = `${ep.summary ?? ""} ${ep.description ?? ""}`.toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (opId === term) score += 50;
    else if (opId.includes(term)) score += 25;
    if (epPath.includes(term)) score += 20;
    if (tags.includes(term)) score += 15;
    if (text.includes(term)) score += 5;
  }
  return score;
}

/**
 * Tool 1: `search`
 * Lets the AI agent search thousands of OpenAPI endpoints on demand with relevance ranking.
 */
export function searchSpec(
  endpoints: OpenApiEndpoint[],
  query: string,
  methodFilter?: string,
  options?: { includeTypes?: boolean; tag?: string; limit?: number }
): OpenApiEndpoint[] {
  const rawQuery = query.trim().toLowerCase();
  const terms = rawQuery === "*" ? [] : rawQuery.split(/\s+/).filter(Boolean);
  const includeTypes = options?.includeTypes ?? true;
  const tagFilter = options?.tag?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(options?.limit ?? 15, 50));

  const ranked = endpoints
    .filter((ep) => {
      if (methodFilter && ep.method !== methodFilter.toUpperCase()) return false;
      if (tagFilter) {
        const epTags = (ep.tags ?? []).map((t) => t.toLowerCase());
        if (!epTags.some((t) => t.includes(tagFilter))) return false;
      }
      if (terms.length === 0) return true;
      const haystack =
        `${ep.method} ${ep.path} ${ep.operationId ?? ""} ${ep.summary ?? ""} ${ep.description ?? ""} ${(ep.tags ?? []).join(" ")}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    })
    .map((ep) => ({ ep, score: scoreEndpointRelevance(ep, terms) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ ep }) => {
      if (includeTypes) return ep;
      return {
        method: ep.method,
        path: ep.path,
        operationId: ep.operationId,
        summary: ep.summary,
        tags: ep.tags,
      };
    });

  return ranked;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Execution aborted due to timeout"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Execution aborted due to timeout"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const rawText = await response.text();
  if (rawText.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return { text: rawText };
  }
}

/**
 * Tool 2: `execute`
 * Runs agent-generated JavaScript inside an isolated Node VM context with audited helpers
 * and wall-clock async timeout enforcement.
 */
export async function executeCodeMode(
  code: string,
  options: {
    baseUrl: string;
    headers?: Record<string, string>;
    policies?: PolicyRule[];
    dryRun?: boolean;
    timeoutMs?: number;
    maxResponseBytes?: number;
    allowCrossOrigin?: boolean;
  }
) {
  const startedAt = Date.now();
  const auditLog: AuditLogEntry[] = [];
  const policies = options.policies ?? defaultAuditPolicies;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxResponseBytes = options.maxResponseBytes ?? 32768;
  const abortController = new AbortController();
  let requestCount = 0;

  const apiHelper = {
    request: async (
      method: string,
      requestPath: string,
      body?: unknown,
      reqOptions?: { retries?: number; retryDelayMs?: number }
    ) => {
      const reqStart = Date.now();
      requestCount++;
      for (const policy of policies) {
        const verdict = policy.check(method, requestPath, body, { requestCount });
        if (!verdict.allowed) {
          auditLog.push({
            method,
            path: requestPath,
            status: "BLOCKED",
            reason: verdict.reason,
            durationMs: Date.now() - reqStart,
          });
          throw new Error(verdict.reason);
        }
      }

      const baseOrigin = new URL(options.baseUrl).origin;
      let isCrossOrigin = false;
      if (requestPath.startsWith("http://") || requestPath.startsWith("https://")) {
        let targetUrl: URL;
        try {
          targetUrl = new URL(requestPath);
        } catch {
          throw new Error(`Invalid request URL: ${requestPath}`);
        }
        if (targetUrl.origin !== baseOrigin) {
          isCrossOrigin = true;
          if (!options.allowCrossOrigin) {
            const reason = `Blocked cross-origin request to '${targetUrl.origin}' (expected base origin '${baseOrigin}').`;
            auditLog.push({
              method,
              path: requestPath,
              status: "BLOCKED",
              reason,
              durationMs: Date.now() - reqStart,
            });
            throw new Error(reason);
          }
        }
      }

      if (options.dryRun) {
        auditLog.push({
          method,
          path: requestPath,
          status: "DRY_RUN_OK",
          durationMs: Date.now() - reqStart,
        });
        return { dryRun: true, method, path: requestPath, body };
      }

      let url: string;
      if (requestPath.startsWith("http://") || requestPath.startsWith("https://")) {
        url = new URL(requestPath).toString();
      } else {
        const base = new URL(options.baseUrl);
        const basePath = base.pathname.replace(/\/+$/, "");
        const [pathname, search] = requestPath.split("?");
        const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
        base.pathname = `${basePath}${cleanPath}`;
        if (search !== undefined) {
          base.search = search ? `?${search}` : "";
        }
        url = base.toString();
      }

      const maxRetries = reqOptions?.retries ?? 2;
      const initialDelay = reqOptions?.retryDelayMs ?? 200;
      let attempt = 0;

      while (true) {
        attempt++;
        try {
          const upperMethod = method.toUpperCase();
          const hasPayload = body !== undefined && upperMethod !== "GET" && upperMethod !== "HEAD";
          const response = await fetch(url, {
            method: upperMethod,
            headers: {
              "Content-Type": "application/json",
              ...(isCrossOrigin ? {} : (options.headers ?? {})),
            },
            body: hasPayload ? JSON.stringify(body) : undefined,
            signal: abortController.signal,
          });

          if ((response.status === 429 || response.status >= 500) && attempt <= maxRetries) {
            await response.body?.cancel().catch(() => {});
            const retryAfterHeader = response.headers.get("retry-after");
            const delayMs =
              retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
                ? Number(retryAfterHeader) * 1000
                : initialDelay * Math.pow(2, attempt - 1);
            await abortableSleep(delayMs, abortController.signal);
            continue;
          }

          auditLog.push({
            method,
            path: requestPath,
            status: `${response.status}`,
            durationMs: Date.now() - reqStart,
          });
          const parsedBody = await parseResponseBody(response);
          if (!response.ok) {
            return {
              ok: false,
              status: response.status,
              statusText: response.statusText,
              data: parsedBody,
            };
          }
          return parsedBody;
        } catch (fetchErr) {
          if (abortController.signal.aborted) {
            throw new Error(`Script execution timed out after ${timeoutMs}ms`);
          }
          if (attempt <= maxRetries) {
            const delayMs = initialDelay * Math.pow(2, attempt - 1);
            await abortableSleep(delayMs, abortController.signal);
            continue;
          }
          throw fetchErr;
        }
      }
    },

    paginate: async (
      method: string,
      path: string,
      paginateOptions?: {
        maxPages?: number;
        limit?: number;
        pageParam?: string;
        limitParam?: string;
        cursorParam?: string;
        body?: unknown;
      }
    ) => {
      const maxPages = paginateOptions?.maxPages ?? 5;
      const limit = paginateOptions?.limit ?? 25;
      const pageParam = paginateOptions?.pageParam ?? "page";
      const limitParam = paginateOptions?.limitParam ?? "per_page";
      const cursorParam = paginateOptions?.cursorParam ?? "cursor";

      const allItems: unknown[] = [];
      let currentPage = 1;
      let pagesFetched = 0;
      let nextCursor: string | undefined = undefined;

      while (currentPage <= maxPages) {
        const separator = path.includes("?") ? "&" : "?";
        let pagedPath = `${path}${separator}${pageParam}=${currentPage}&${limitParam}=${limit}`;
        if (nextCursor) {
          pagedPath += `&${cursorParam}=${encodeURIComponent(nextCursor)}`;
        }

        const data = await apiHelper.request(method, pagedPath, paginateOptions?.body);
        pagesFetched++;

        if (
          options.dryRun ||
          (data && typeof data === "object" && (data as Record<string, unknown>).dryRun)
        ) {
          allItems.push({
            page: currentPage,
            items: [`item_${currentPage}_1`, `item_${currentPage}_2`],
          });
          currentPage++;
          continue;
        }

        let pageItems: unknown[] = [];
        if (Array.isArray(data)) {
          pageItems = data;
        } else if (data && typeof data === "object") {
          const obj = data as Record<string, unknown>;
          const candidate = obj.result ?? obj.items ?? obj.data ?? obj.records;
          if (Array.isArray(candidate)) {
            pageItems = candidate;
          } else {
            pageItems = [data];
          }

          const info = (obj.result_info ?? obj.pagination ?? obj.meta ?? {}) as Record<
            string,
            unknown
          >;
          const rawCursor = info.next_cursor ?? info.nextCursor ?? info.starting_after;
          nextCursor = typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : undefined;
          if (typeof info.total_pages === "number" && currentPage >= info.total_pages) {
            allItems.push(...pageItems);
            break;
          }
        }

        allItems.push(...pageItems);
        if (pageItems.length === 0 || (pageItems.length < limit && !nextCursor)) {
          break;
        }

        currentPage++;
      }

      return {
        items: allItems,
        totalItems: allItems.length,
        pagesFetched,
      };
    },

    batch: async (
      requests: BatchRequestItem[],
      batchOptions?: { concurrency?: number; continueOnError?: boolean }
    ): Promise<BatchExecutionResult> => {
      if (!Array.isArray(requests) || requests.length === 0) {
        return { total: 0, succeeded: 0, failed: 0, results: [] };
      }
      const concurrency = Math.max(1, Math.min(batchOptions?.concurrency ?? 5, 10));
      const continueOnError = batchOptions?.continueOnError ?? false;
      const results: BatchExecutionResult["results"] = new Array(requests.length);
      let nextIdx = 0;

      const worker = async () => {
        while (nextIdx < requests.length) {
          const idx = nextIdx++;
          const item = requests[idx];
          try {
            const data = await apiHelper.request(item.method, item.path, item.body);
            results[idx] = {
              index: idx,
              method: item.method,
              path: item.path,
              ok: true,
              data,
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            if (!continueOnError) {
              throw err;
            }
            results[idx] = {
              index: idx,
              method: item.method,
              path: item.path,
              ok: false,
              error: errorMsg,
            };
          }
        }
      };

      const workers = Array.from(
        { length: Math.min(concurrency, requests.length) },
        () => worker()
      );
      await Promise.all(workers);

      const succeeded = results.filter((r) => r?.ok).length;
      return {
        total: requests.length,
        succeeded,
        failed: requests.length - succeeded,
        results,
      };
    },

    simulate: (requests: BatchRequestItem[]): SimulationResult => {
      const items = Array.isArray(requests) ? requests : [];
      const baseOrigin = new URL(options.baseUrl).origin;
      const verdicts: SimulationResult["verdicts"] = [];
      let simulatedCount = requestCount;

      for (const item of items) {
        simulatedCount++;
        let blockedReason: string | undefined;
        for (const policy of policies) {
          const v = policy.check(item.method, item.path, item.body, {
            requestCount: simulatedCount,
          });
          if (!v.allowed) {
            blockedReason = v.reason;
            break;
          }
        }
        if (!blockedReason && (item.path.startsWith("http://") || item.path.startsWith("https://"))) {
          try {
            const targetOrigin = new URL(item.path).origin;
            if (targetOrigin !== baseOrigin && !options.allowCrossOrigin) {
              blockedReason = `Blocked cross-origin request to '${targetOrigin}' (expected base origin '${baseOrigin}').`;
            }
          } catch {
            blockedReason = `Invalid request URL: ${item.path}`;
          }
        }
        verdicts.push({
          method: item.method,
          path: item.path,
          allowed: !blockedReason,
          ...(blockedReason ? { reason: blockedReason } : {}),
        });
      }

      const allowedCount = verdicts.filter((v) => v.allowed).length;
      const blockedCount = verdicts.length - allowedCount;
      return {
        allowed: blockedCount === 0,
        totalChecked: verdicts.length,
        allowedCount,
        blockedCount,
        verdicts,
      };
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
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const executionPromise = Promise.resolve().then(async () => {
    return (await vm.runInContext(wrappedScript, sandbox, { timeout: timeoutMs })) as unknown;
  });
  // Prevent late async rejections after a timeout deadline triggers from leaking as unhandled rejections.
  executionPromise.catch(() => {});

  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let result: unknown;
  try {
    result = await Promise.race([executionPromise, deadlinePromise]);
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }

  const durationMs = Date.now() - startedAt;
  const apiEntries = auditLog.filter((e) => e.method !== "LOG");
  const dryRunSummary: DryRunSummary | undefined = options.dryRun
    ? {
        totalCalls: apiEntries.length,
        allowedCalls: apiEntries.filter((e) => e.status === "DRY_RUN_OK").length,
        blockedCalls: apiEntries.filter((e) => e.status === "BLOCKED").length,
        targets: apiEntries.map((e) => ({ method: e.method, path: e.path, status: e.status })),
      }
    : undefined;

  const serialized = typeof result === "string" ? result : JSON.stringify(result);
  const totalBytes = serialized !== undefined ? Buffer.byteLength(serialized, "utf8") : 0;

  if (totalBytes > maxResponseBytes) {
    const truncatedText = Buffer.from(serialized, "utf8")
      .subarray(0, maxResponseBytes)
      .toString("utf8");

    return {
      result: truncatedText,
      truncated: true,
      originalBytes: totalBytes,
      maxResponseBytes,
      durationMs,
      dryRunSummary,
      auditLog,
    };
  }

  return {
    result,
    truncated: false,
    durationMs,
    dryRunSummary,
    auditLog,
  };
}
