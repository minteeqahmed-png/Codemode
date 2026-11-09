#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

interface BacklogCandidate {
  key: string;
  title: string;
  body: string;
  isImplemented: (files: Record<string, string>) => boolean;
}

/**
 * Comprehensive codebase audit & roadmap checks.
 * Inspects every source file in `src/` and opens `jules`-labeled issues for all findings.
 */
const CODEBASE_CHECKS: BacklogCandidate[] = [
  {
    key: "preset-cli-flag",
    title: "feat: add --preset CLI flag for popular OpenAPI specs (cloudflare, github, stripe)",
    body: `## Summary
Add a \`--preset <name>\` (\`-P\`) CLI flag in \`src/server.ts\` so users can launch Codemode for popular APIs without manually pasting a long OpenAPI spec URL.

## Acceptance Criteria
1. Support \`--preset\` (\`cloudflare\`, \`github\`, \`stripe\`, \`kubernetes\`) in \`parseCliArgs\` (\`src/server.ts\`), mapping each preset to its official OpenAPI JSON URL and default base URL.
2. Export the preset map (\`API_PRESETS\`) so it can be tested in \`src/demo.ts\`.
3. Add a verification step in \`src/demo.ts\` and ensure \`npm run demo\` and \`node src/server.ts --help\` pass.`,
    isImplemented: (files) =>
      (files["src/server.ts"] ?? "").includes("--preset") &&
      (files["src/server.ts"] ?? "").includes("API_PRESETS"),
  },
  {
    key: "yaml-openapi-support",
    title: "feat: support YAML (.yaml/.yml) OpenAPI v3 specifications in loadOpenApiSpec",
    body: `## Summary
Currently \`loadOpenApiSpec\` in \`src/server.ts\` only parses JSON OpenAPI specs. Many OpenAPI v3 specs (including Kubernetes and Stripe variants) are published as \`.yaml\` or \`.yml\`.

## Acceptance Criteria
1. Update \`loadOpenApiSpec\` in \`src/server.ts\` to detect and parse YAML OpenAPI specs alongside JSON.
2. Keep dependencies minimal and ensure \`npm run demo\` and \`node src/server.ts --help\` pass with a new YAML test case in \`src/demo.ts\`.`,
    isImplemented: (files) =>
      (files["src/server.ts"] ?? "").toLowerCase().includes(".yaml") ||
      (files["src/server.ts"] ?? "").toLowerCase().includes(".yml"),
  },
  {
    key: "response-truncation-guardrail",
    title: "feat: add maxResponseBytes truncation guardrail in executeCodeMode",
    body: `## Summary
To protect the LLM context window from huge raw API responses returned inside \`execute\`, add a configurable \`maxResponseBytes\` guardrail in \`src/index.ts\` and \`policies.json\`.

## Acceptance Criteria
1. Add \`maxResponseBytes\` (default \`32768\`) to \`PolicyConfigFile\` in \`src/index.ts\` and \`policies.json\`.
2. Truncate or summarize oversized sandbox outputs in \`executeCodeMode\` with a clear \`truncated: true\` metadata flag.
3. Add a test case in \`src/demo.ts\` verifying oversized payload truncation.`,
    isImplemented: (files) => (files["src/index.ts"] ?? "").includes("maxResponseBytes"),
  },
  {
    key: "configurable-sandbox-timeout",
    title: "feat: add configurable --timeout-ms CLI flag and policy setting for VM sandbox",
    body: `## Summary
Allow configuring the \`vm.runInContext\` execution timeout (currently hardcoded to \`5000\` ms in \`src/index.ts\`) via \`policies.json\` (\`timeoutMs\`) and CLI flag \`--timeout-ms\`.

## Acceptance Criteria
1. Add \`timeoutMs\` to \`PolicyConfigFile\` in \`src/index.ts\` and \`policies.json\`.
2. Add \`--timeout-ms\` to \`parseCliArgs\` in \`src/server.ts\`.
3. Verify timeout enforcement in \`src/demo.ts\`.`,
    isImplemented: (files) =>
      (files["src/index.ts"] ?? "").includes("timeoutMs") &&
      (files["src/server.ts"] ?? "").includes("--timeout-ms"),
  },
  {
    key: "strict-typescript-no-any",
    title: "refactor: replace explicit 'any' types in src/index.ts and src/server.ts with strict types",
    body: `## Summary
Codebase scan detected explicit \`any\` usages (\`Record<string, any>\`, \`err: any\`) in \`src/index.ts\` and \`src/server.ts\`. Replace these with strict TypeScript interfaces (\`OpenApiSpec\`, \`JsonRpcMessage\`, \`unknown\` error narrowing).

## Acceptance Criteria
1. Define a typed \`OpenApiSpec\` interface in \`src/index.ts\` instead of \`Record<string, any>\`.
2. Narrow caught errors using \`err instanceof Error ? err.message : String(err)\` in \`src/server.ts\`.
3. Ensure \`npm run demo\` and \`node src/server.ts --help\` pass with zero warnings.`,
    isImplemented: (files) =>
      !(files["src/index.ts"] ?? "").includes("Record<string, any>") &&
      !(files["src/server.ts"] ?? "").includes("err: any"),
  },
  {
    key: "swagger-v2-compatibility",
    title: "feat: support Swagger 2.0 (host + basePath) specs in indexOpenApiSpec and CodeModeMcpServer",
    body: `## Summary
While OpenAPI 3.x uses \`spec.servers[0].url\`, many legacy enterprise APIs use Swagger 2.0 (\`spec.swagger === "2.0"\` with \`spec.host\`, \`spec.basePath\`, and \`spec.schemes\`).

## Acceptance Criteria
1. Update \`CodeModeMcpServer\` in \`src/server.ts\` to derive \`baseUrl\` from Swagger 2.0 \`schemes\` + \`host\` + \`basePath\` when \`servers\` is not present.
2. Add a test case in \`src/demo.ts\` verifying Swagger 2.0 spec indexing and base URL resolution.`,
    isImplemented: (files) => (files["src/server.ts"] ?? "").includes("basePath"),
  },
];

/**
 * Scans all `src/*.ts` files for inline `// JULES:`, `// TODO:`, or `// FIXME:` comments.
 */
function extractInlineCodeIssues(files: Record<string, string>): Array<{ title: string; body: string }> {
  const tasks: Array<{ title: string; body: string }> = [];
  const regex = /\/\/\s*(?:JULES|TODO|FIXME):\s*(.+)$/gim;

  for (const [filePath, content] of Object.entries(files)) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const taskText = match[1].trim();
      tasks.push({
        title: `fix: ${taskText}`,
        body: `## Automated Codebase Scan Finding\nFound inline directive in \`${filePath}\`:\n\n> \`${match[0].trim()}\`\n\nPlease implement this fix, remove the comment once complete, and verify that \`npm run demo\` passes.`,
      });
    }
  }
  return tasks;
}

async function readProjectFiles(): Promise<Record<string, string>> {
  const targets = ["src/index.ts", "src/server.ts", "src/demo.ts", "policies.json", "package.json"];
  const result: Record<string, string> = {};
  for (const rel of targets) {
    try {
      result[rel] = await fs.readFile(path.resolve(process.cwd(), rel), "utf8");
    } catch {
      result[rel] = "";
    }
  }
  return result;
}

async function githubRequest(url: string, token: string, init?: RequestInit) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "Codemode-Auto-Triage",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Automatically creates Pull Requests for any branch pushed by Jules that doesn't have a PR yet.
 */
async function autoCreatePullRequestsForJulesBranches(repo: string, token: string) {
  const branchesRes = await githubRequest(`https://api.github.com/repos/${repo}/branches`, token);
  if (!branchesRes.ok) return;
  const branches = (await branchesRes.json()) as Array<{ name: string }>;

  const prsRes = await githubRequest(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=100`, token);
  if (!prsRes.ok) return;
  const prs = (await prsRes.json()) as Array<{ head: { ref: string }; state: string }>;
  const openPrBranches = new Set(prs.filter((p) => p.state === "open").map((p) => p.head.ref));

  for (const branch of branches) {
    if (branch.name === "main" || branch.name === "master") continue;
    if (openPrBranches.has(branch.name)) continue;

    // Compare branch with main to ensure it has ahead commits before opening a PR
    const cmpRes = await githubRequest(
      `https://api.github.com/repos/${repo}/compare/main...${encodeURIComponent(branch.name)}`,
      token
    );
    if (!cmpRes.ok) continue;
    const cmp = (await cmpRes.json()) as { ahead_by?: number; commits?: Array<{ commit: { message: string } }> };
    if (!cmp.ahead_by || cmp.ahead_by < 1) continue;

    const firstCommitLines = (cmp.commits?.[0]?.commit?.message ?? branch.name).split("\n");
    const prTitle = firstCommitLines[0];
    const prBody = firstCommitLines.slice(1).join("\n").trim() || `Automated PR for Jules branch \`${branch.name}\`.`;

    const createPr = await githubRequest(`https://api.github.com/repos/${repo}/pulls`, token, {
      method: "POST",
      body: JSON.stringify({
        title: prTitle,
        head: branch.name,
        base: "main",
        body: prBody,
      }),
    });

    if (createPr.ok) {
      const created = (await createPr.json()) as { number: number; html_url: string };
      console.log(`  [Auto-PR] Opened PR #${created.number} for branch ${branch.name}: ${created.html_url}`);
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const maxNewIssues = Number(process.env.MAX_NEW_ISSUES ?? "10");
  const repo = process.env.GITHUB_REPOSITORY ?? "minteeqahmed-png/Codemode";
  const token = process.env.GITHUB_TOKEN;

  const files = await readProjectFiles();
  const pendingChecks = CODEBASE_CHECKS.filter((item) => !item.isImplemented(files));
  const inlineTasks = extractInlineCodeIssues(files);

  const candidates = [
    ...inlineTasks,
    ...pendingChecks.map((r) => ({ title: r.title, body: r.body })),
  ];

  console.log(`[Codemode Auto-Triage] Scanned ${Object.keys(files).length} files.`);
  console.log(`[Codemode Auto-Triage] Found ${candidates.length} codebase issues/tasks.`);

  if (dryRun || !token) {
    for (const c of candidates) {
      console.log(`  -> Candidate Issue: ${c.title}`);
    }
    return;
  }

  // 1. Auto-open PRs for any finished Jules branches
  await autoCreatePullRequestsForJulesBranches(repo, token);

  // 2. Fetch existing issues so we never duplicate an issue
  const existingRes = await githubRequest(
    `https://api.github.com/repos/${repo}/issues?state=all&per_page=100`,
    token
  );
  if (!existingRes.ok) {
    throw new Error(`Failed to list existing issues: ${existingRes.status} ${existingRes.statusText}`);
  }

  const existingIssues = (await existingRes.json()) as Array<{
    title: string;
    number: number;
    state: string;
    pull_request?: unknown;
    labels: Array<{ name: string }>;
  }>;
  const existingTitles = new Set(existingIssues.map((i) => i.title.trim().toLowerCase()));

  // 3. Create missing issues with `jules` label
  let createdCount = 0;
  for (const candidate of candidates) {
    if (createdCount >= maxNewIssues) break;
    if (existingTitles.has(candidate.title.trim().toLowerCase())) {
      console.log(`  [Skip] Already exists: "${candidate.title}"`);
      continue;
    }

    const createRes = await githubRequest(`https://api.github.com/repos/${repo}/issues`, token, {
      method: "POST",
      body: JSON.stringify({
        title: candidate.title,
        body: candidate.body,
        labels: ["enhancement", "jules"],
      }),
    });

    if (createRes.ok) {
      const created = (await createRes.json()) as { number: number; html_url: string };
      console.log(`  [Created] #${created.number}: ${created.html_url}`);
      createdCount++;
    }
  }

  // 4. Ensure EVERY open issue in the repository has the `jules` label and has triggered Jules
  for (const issue of existingIssues) {
    if (issue.pull_request || issue.state !== "open") continue;
    const commentsRes = await githubRequest(
      `https://api.github.com/repos/${repo}/issues/${issue.number}/comments`,
      token
    );
    const comments = commentsRes.ok
      ? ((await commentsRes.json()) as Array<{ user?: { login?: string } }>)
      : [];
    const julesAlreadyActive = comments.some((c) => (c.user?.login ?? "").includes("jules"));

    if (!julesAlreadyActive) {
      await githubRequest(
        `https://api.github.com/repos/${repo}/issues/${issue.number}/labels/jules`,
        token,
        { method: "DELETE" }
      );
      await githubRequest(
        `https://api.github.com/repos/${repo}/issues/${issue.number}/labels`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ labels: ["jules"] }),
        }
      );
      console.log(`  [Triggered Jules] Issue #${issue.number}: ${issue.title}`);
    }
  }

  console.log(`[Codemode Auto-Triage] Complete.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
