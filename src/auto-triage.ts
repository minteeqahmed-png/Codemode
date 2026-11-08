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
 * Built-in architectural roadmap checks.
 * The scanner reads the live source files to see which capabilities are still missing
 * and automatically opens `jules`-labeled GitHub issues for unimplemented items.
 */
const ROADMAP_CHECKS: BacklogCandidate[] = [
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
];

/**
 * Also scans all `src/*.ts` files for inline `// JULES: <task description>` comments
 * so the maintainer can drop a comment in code and have an issue opened automatically.
 */
function extractInlineJulesTasks(files: Record<string, string>): Array<{ title: string; body: string }> {
  const tasks: Array<{ title: string; body: string }> = [];
  const regex = /\/\/\s*JULES:\s*(.+)$/gim;

  for (const [filePath, content] of Object.entries(files)) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const taskText = match[1].trim();
      tasks.push({
        title: `feat: ${taskText}`,
        body: `## Automated Code Scan Task\nFound inline directive in \`${filePath}\`:\n\n> \`// JULES: ${taskText}\`\n\nPlease implement this change, remove the \`// JULES:\` comment once complete, and verify that \`npm run demo\` passes.`,
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const maxNewIssues = Number(process.env.MAX_NEW_ISSUES ?? "2");
  const repo = process.env.GITHUB_REPOSITORY ?? "minteeqahmed-png/Codemode";
  const token = process.env.GITHUB_TOKEN;

  const files = await readProjectFiles();
  const pendingRoadmap = ROADMAP_CHECKS.filter((item) => !item.isImplemented(files));
  const inlineTasks = extractInlineJulesTasks(files);

  const candidates = [
    ...inlineTasks,
    ...pendingRoadmap.map((r) => ({ title: r.title, body: r.body })),
  ];

  console.log(`[Codemode Auto-Triage] Scanned ${Object.keys(files).length} files.`);
  console.log(`[Codemode Auto-Triage] Found ${candidates.length} unimplemented backlog/inline tasks.`);

  if (dryRun || !token) {
    for (const c of candidates) {
      console.log(`  -> Candidate Issue: ${c.title}`);
    }
    if (!token && !dryRun) {
      console.log("[Codemode Auto-Triage] No GITHUB_TOKEN set; skipping remote issue creation.");
    }
    return;
  }

  // Fetch existing issues (open + closed) so we never duplicate an issue
  const existingRes = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Codemode-Auto-Triage",
    },
  });

  if (!existingRes.ok) {
    throw new Error(`Failed to list existing issues: ${existingRes.status} ${existingRes.statusText}`);
  }

  const existingIssues = (await existingRes.json()) as Array<{ title: string; number: number }>;
  const existingTitles = new Set(existingIssues.map((i) => i.title.trim().toLowerCase()));

  let createdCount = 0;
  for (const candidate of candidates) {
    if (createdCount >= maxNewIssues) break;
    if (existingTitles.has(candidate.title.trim().toLowerCase())) {
      console.log(`  [Skip] Already exists: "${candidate.title}"`);
      continue;
    }

    const createRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "Codemode-Auto-Triage",
      },
      body: JSON.stringify({
        title: candidate.title,
        body: candidate.body,
        labels: ["enhancement", "jules"],
      }),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create issue "${candidate.title}": ${createRes.status}`);
    }

    const created = (await createRes.json()) as { number: number; html_url: string };
    console.log(`  [Created] #${created.number}: ${created.html_url}`);
    createdCount++;
  }

  console.log(`[Codemode Auto-Triage] Done. Created ${createdCount} new issue(s) for Jules.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
