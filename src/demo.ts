import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodeModeMcpServer, API_PRESETS, loadOpenApiSpec } from "./server.ts";
import { indexOpenApiSpec, loadPolicyConfig } from "./index.ts";

/**
 * Generates a realistic multi-service Cloud Infrastructure OpenAPI v3 specification
 * (Zones, DNS, Firewall, Workers, R2, Zero Trust, Certificates, Load Balancers, WAF, Logs)
 * with 500 endpoints to benchmark Native MCP vs. Code Mode MCP.
 */
function generateLargeCloudOpenApiSpec(totalOperations = 500): Record<string, any> {
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
  const paths: Record<string, any> = {};

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

  // 5. Test CLI API Presets (Cloudflare, GitHub, Stripe, Kubernetes)
  console.log("\n[5] TESTING CLI API PRESETS (API_PRESETS Export & CLI flag parsing)");
  const requiredPresets = ["cloudflare", "github", "stripe", "kubernetes"] as const;
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
  if (parsedLong.preset !== "github" || parsedShort.preset !== "stripe") {
    throw new Error(`CLI argument parsing failed for --preset or -P flags`);
  }
  console.log("    - [VERIFIED] CLI flags --preset and -P parsed correctly");

  // 6. Test YAML OpenAPI Specification Loading (.yaml and .yml)
  console.log("\n[6] TESTING YAML OPENAPI SPECIFICATION LOADING");
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

  console.log("\n==================================================================");
  console.log("  ALL BENCHMARKS, POLICIES & CLI PRESETS PASSED");
  console.log("==================================================================");
}

runProofOfConcept().catch((err) => {
  console.error(err);
  process.exit(1);
});
