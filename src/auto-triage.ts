#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { postOrUpdateCodexPrComment } from "./codex-review.ts";

const OWNER_LOGIN = "minteeqahmed-png";
const AUTO_MERGE_HOURS = 24;

interface BacklogCandidate {
  key: string;
  title: string;
  body: string;
  isImplemented: (files: Record<string, string>) => boolean;
}

/**
 * Comprehensive codebase audit, feature roadmap & continuous maintenance checks.
 * Inspects every source file in `src/` and `README.md` and opens `jules`-labeled issues.
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
  {
    key: "readme-cli-flags-sync",
    title: "docs: keep README.md CLI documentation synchronized with all flags in src/server.ts",
    body: `## Summary
Continuous documentation maintenance check detected CLI flags in \`src/server.ts\` that are not yet documented in \`README.md\`.

## Acceptance Criteria
1. Document all supported CLI flags (\`--spec\`, \`--preset\`, \`--policies\`, \`--base-url\`, \`--token\`, \`--dry-run\`) in \`README.md\`.
2. Ensure \`npm run demo\` passes.`,
    isImplemented: (files) => {
      const serverCode = files["src/server.ts"] ?? "";
      const readme = files["README.md"] ?? "";
      const flags = ["--spec", "--policies", "--base-url", "--dry-run"];
      return flags.every((f) => !serverCode.includes(f) || readme.includes(f));
    },
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
  const targets = [
    "src/index.ts",
    "src/server.ts",
    "src/demo.ts",
    "policies.json",
    "package.json",
    "README.md",
  ];
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
      "User-Agent": "Codemode-Autonomous-Maintainer",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Finds the Issue linked to a Pull Request by `#number` reference or title similarity.
 */
function findLinkedIssue(
  pr: { title: string; body?: string },
  pureIssues: Array<{ number: number; title: string; created_at: string; state?: string }>
) {
  const issueRefMatch = `${pr.title} ${pr.body ?? ""}`.match(/#(\d+)/);
  if (issueRefMatch) {
    const byNum = pureIssues.find((i) => i.number === Number(issueRefMatch[1]));
    if (byNum) return byNum;
  }

  const normalizedPrTitle = pr.title
    .replace(/^(feat|fix|refactor|docs|chore):\s*/i, "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .trim()
    .toLowerCase();

  return pureIssues.find((i) => {
    const normalizedIssueTitle = i.title
      .replace(/^(feat|fix|refactor|docs|chore):\s*/i, "")
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .trim()
      .toLowerCase();
    return (
      normalizedIssueTitle.includes(normalizedPrTitle) ||
      normalizedPrTitle.includes(normalizedIssueTitle)
    );
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

/**
 * Autonomous Post-Merge Cleanup & PR Branch Sync:
 * - Closes linked Issues and deletes stale branches once a PR is merged.
 * - Keeps open PR branches updated with `main`, and if a PR has a merge conflict,
 *   automatically dispatches a conflict-resolution issue to Jules.
 */
async function maintainRepoAndPullRequests(
  repo: string,
  token: string,
  allIssues: Array<{ number: number; title: string; created_at: string; state: string; pull_request?: unknown }>
) {
  const pureIssues = allIssues.filter((i) => !i.pull_request);

  // 1. Clean up merged PRs: close linked open issues & delete merged feature branches
  const closedPrsRes = await githubRequest(
    `https://api.github.com/repos/${repo}/pulls?state=closed&per_page=30`,
    token
  );
  if (closedPrsRes.ok) {
    const closedPrs = (await closedPrsRes.json()) as Array<{
      number: number;
      title: string;
      body?: string;
      merged_at: string | null;
      head: { ref: string };
    }>;

    for (const pr of closedPrs) {
      if (!pr.merged_at) continue;
      const linked = findLinkedIssue(pr, pureIssues);
      if (linked && linked.state === "open") {
        await githubRequest(`https://api.github.com/repos/${repo}/issues/${linked.number}`, token, {
          method: "PATCH",
          body: JSON.stringify({ state: "closed" }),
        });
        console.log(`  [Auto-Maintain] Closed resolved Issue #${linked.number} (merged in PR #${pr.number}).`);
      }

      if (pr.head.ref && pr.head.ref !== "main" && pr.head.ref !== "master") {
        const delBranch = await githubRequest(
          `https://api.github.com/repos/${repo}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`,
          token,
          { method: "DELETE" }
        );
        if (delBranch.ok) {
          console.log(`  [Auto-Maintain] Deleted merged branch '${pr.head.ref}'.`);
        }
      }
    }
  }

  // 2. Check open PRs for out-of-date branches or merge conflicts
  const openPrsRes = await githubRequest(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=50`, token);
  if (!openPrsRes.ok) return;
  const openPrs = (await openPrsRes.json()) as Array<{ number: number; title: string; head: { ref: string } }>;

  for (const pr of openPrs) {
    const detailRes = await githubRequest(`https://api.github.com/repos/${repo}/pulls/${pr.number}`, token);
    if (!detailRes.ok) continue;
    const detail = (await detailRes.json()) as {
      mergeable: boolean | null;
      mergeable_state?: string;
    };

    if (detail.mergeable_state === "behind") {
      const updateRes = await githubRequest(
        `https://api.github.com/repos/${repo}/pulls/${pr.number}/update-branch`,
        token,
        { method: "PUT", body: JSON.stringify({}) }
      );
      if (updateRes.ok) {
        console.log(`  [Auto-Maintain] Synced behind PR #${pr.number} branch (${pr.head.ref}) with latest main.`);
      }
    }
  }
}

/**
 * 24-Hour Owner Review & Auto-Merge Rule (measured from when the ISSUE is created):
 * - Asks `@minteeqahmed-png` one final time on each open PR to check and approve/reject.
 * - If `@minteeqahmed-png` responds (on either the Issue or the PR):
 *     - `approve` / `merge` / `lgtm` / `APPROVED` review -> merges the PR immediately.
 *     - `reject` / `close` / `CHANGES_REQUESTED` review -> closes the PR immediately.
 *     - `hold` / `wait` -> keeps the PR open without auto-merging.
 * - Otherwise, if `elapsedHours >= 24` since the linked ISSUE was created and `@minteeqahmed-png`
 *   has not responded -> auto-merges the PR, closes the linked Issue, and deletes the branch!
 */
async function processPullRequestGovernance(
  repo: string,
  token: string,
  allIssues: Array<{ number: number; title: string; created_at: string; state: string; pull_request?: unknown }>
) {
  const prsRes = await githubRequest(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=50`, token);
  if (!prsRes.ok) return;
  const openPrs = (await prsRes.json()) as Array<{
    number: number;
    node_id: string;
    draft?: boolean;
    title: string;
    body?: string;
    created_at: string;
    head: { ref: string };
  }>;

  const promptMarker = "<!-- codemode-final-approval-prompt -->";
  const pureIssues = allIssues.filter((i) => !i.pull_request);

  for (const pr of openPrs) {
    // Automatically convert Draft PRs from Jules into Ready-for-Review PRs so they can be merged
    if (pr.draft && pr.node_id) {
      await githubRequest("https://api.github.com/graphql", token, {
        method: "POST",
        body: JSON.stringify({
          query: `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
          variables: { id: pr.node_id },
        }),
      });
      console.log(`  [Auto-Maintain] Marked Draft PR #${pr.number} as Ready for Review.`);
    }

    // Step 2: Run Codex Reviewer Audit before asking @minteeqahmed-png for Step 3 approval
    const codexVerdict = await postOrUpdateCodexPrComment(repo, pr.number, token);

    const linkedIssue = findLinkedIssue(pr, pureIssues);
    const timerStartIso = linkedIssue ? linkedIssue.created_at : pr.created_at;
    const timerSourceLabel = linkedIssue ? `Issue #${linkedIssue.number}` : `PR #${pr.number}`;

    const commentsRes = await githubRequest(
      `https://api.github.com/repos/${repo}/issues/${pr.number}/comments?per_page=100`,
      token
    );
    const prComments = commentsRes.ok
      ? ((await commentsRes.json()) as Array<{ user?: { login?: string }; body?: string; created_at?: string }>)
      : [];

    let issueComments: Array<{ user?: { login?: string }; body?: string; created_at?: string }> = [];
    if (linkedIssue) {
      const issueCommentsRes = await githubRequest(
        `https://api.github.com/repos/${repo}/issues/${linkedIssue.number}/comments?per_page=100`,
        token
      );
      if (issueCommentsRes.ok) {
        issueComments = (await issueCommentsRes.json()) as Array<{
          user?: { login?: string };
          body?: string;
          created_at?: string;
        }>;
      }
    }

    const reviewsRes = await githubRequest(
      `https://api.github.com/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`,
      token
    );
    const reviews = reviewsRes.ok
      ? ((await reviewsRes.json()) as Array<{ user?: { login?: string }; state?: string; body?: string }>)
      : [];

    // 1. Send final approval prompt to owner if not yet sent
    const hasPrompt = prComments.some((c) => (c.body ?? "").includes(promptMarker));
    if (!hasPrompt) {
      const promptBody = `${promptMarker}
### Final Maintainer Review Request (@${OWNER_LOGIN})

Please check and approve this Pull Request (linked to **${timerSourceLabel}** created at \`${timerStartIso}\`):
- Reply **\`approve\`** (or submit an approving review) to **merge immediately**.
- Reply **\`reject\`** (or **\`close\`**) to **close this PR**.
- Reply **\`hold\`** to **pause auto-merge**.

> **24-Hour Issue Timer Rule**: If @${OWNER_LOGIN} does not respond within **${AUTO_MERGE_HOURS} hours of ${timerSourceLabel} being created**, this Pull Request will be **merged automatically**.`;

      await githubRequest(`https://api.github.com/repos/${repo}/issues/${pr.number}/comments`, token, {
        method: "POST",
        body: JSON.stringify({ body: promptBody }),
      });
      console.log(`  [Governance] Posted final approval prompt for @${OWNER_LOGIN} on PR #${pr.number}`);
    }

    // 2. Check if owner (@minteeqahmed-png) responded via review or comment (on Issue or PR)
    const combinedComments = [...issueComments, ...prComments];
    const ownerComments = combinedComments.filter(
      (c) =>
        (c.user?.login ?? "").toLowerCase() === OWNER_LOGIN.toLowerCase() &&
        !(c.body ?? "").includes(promptMarker)
    );
    const ownerReviews = reviews.filter(
      (r) => (r.user?.login ?? "").toLowerCase() === OWNER_LOGIN.toLowerCase()
    );

    let ownerDecision: "approve" | "reject" | "hold" | null = null;

    for (const rev of ownerReviews) {
      if (rev.state === "APPROVED") ownerDecision = "approve";
      else if (rev.state === "CHANGES_REQUESTED") ownerDecision = "reject";
    }

    for (const c of ownerComments) {
      const text = (c.body ?? "").trim().toLowerCase();
      if (/\b(approve|approved|merge|lgtm|yes)\b/.test(text)) ownerDecision = "approve";
      else if (/\b(reject|rejected|close|no)\b/.test(text)) ownerDecision = "reject";
      else if (/\b(hold|wait|pause)\b/.test(text)) ownerDecision = "hold";
    }

    if (ownerDecision === "approve") {
      const mergeRes = await githubRequest(
        `https://api.github.com/repos/${repo}/pulls/${pr.number}/merge`,
        token,
        {
          method: "PUT",
          body: JSON.stringify({
            commit_title: `${pr.title} (#${pr.number})`,
            merge_method: "squash",
          }),
        }
      );
      console.log(`  [Governance] Owner @${OWNER_LOGIN} APPROVED PR #${pr.number} -> Merge status: ${mergeRes.status}`);
      continue;
    }

    if (ownerDecision === "reject") {
      await githubRequest(`https://api.github.com/repos/${repo}/pulls/${pr.number}`, token, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      console.log(`  [Governance] Owner @${OWNER_LOGIN} REJECTED PR #${pr.number} -> Closed PR.`);
      continue;
    }

    if (ownerDecision === "hold") {
      console.log(`  [Governance] Owner @${OWNER_LOGIN} placed PR #${pr.number} on HOLD.`);
      continue;
    }

    // 3. No owner response yet: check if 24 hours have elapsed since the ISSUE was created
    const createdTime = new Date(timerStartIso).getTime();
    const elapsedHours = (Date.now() - createdTime) / (1000 * 60 * 60);

    if (elapsedHours >= AUTO_MERGE_HOURS) {
      if (codexVerdict.status === "FAILED") {
        console.log(
          `  [Governance] PR #${pr.number} reached 24h timer (${elapsedHours.toFixed(1)}h), but Codex Step 2 check is FAILED -> Holding auto-merge until fixed.`
        );
        continue;
      }
      const mergeRes = await githubRequest(
        `https://api.github.com/repos/${repo}/pulls/${pr.number}/merge`,
        token,
        {
          method: "PUT",
          body: JSON.stringify({
            commit_title: `${pr.title} (#${pr.number}) [24h Issue Timer Auto-Merge]`,
            merge_method: "squash",
          }),
        }
      );
      console.log(
        `  [Governance] ${elapsedHours.toFixed(1)}h elapsed since ${timerSourceLabel} creation (>= ${AUTO_MERGE_HOURS}h) with no owner response -> Auto-merged PR #${pr.number} (${mergeRes.status})`
      );
      if (mergeRes.ok && linkedIssue) {
        await githubRequest(`https://api.github.com/repos/${repo}/issues/${linkedIssue.number}`, token, {
          method: "PATCH",
          body: JSON.stringify({ state: "closed" }),
        });
      }
    } else {
      console.log(
        `  [Governance] PR #${pr.number} awaiting @${OWNER_LOGIN} response (${elapsedHours.toFixed(1)}h / ${AUTO_MERGE_HOURS}h elapsed since ${timerSourceLabel} creation).`
      );
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

  console.log(`[Codemode Auto-Maintainer] Scanned ${Object.keys(files).length} files.`);
  console.log(`[Codemode Auto-Maintainer] Found ${candidates.length} codebase issues/tasks.`);

  if (dryRun || !token) {
    for (const c of candidates) {
      console.log(`  -> Candidate Issue: ${c.title}`);
    }
    return;
  }

  // 1. Auto-open PRs for any finished Jules branches
  await autoCreatePullRequestsForJulesBranches(repo, token);

  // 2. Fetch existing issues (with created_at timestamps)
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
    created_at: string;
    pull_request?: unknown;
    labels: Array<{ name: string }>;
  }>;

  // 3. Run 24-Hour Owner Review & Auto-Merge Governance (measured from when the Issue was created)
  await processPullRequestGovernance(repo, token, existingIssues);

  // 4. Run Post-Merge Cleanup (close resolved issues, delete merged branches, sync behind PRs)
  await maintainRepoAndPullRequests(repo, token, existingIssues);

  const existingTitles = new Set(existingIssues.map((i) => i.title.trim().toLowerCase()));

  // 5. Create missing issues with `jules` label
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

  // 6. Ensure EVERY open issue in the repository has the `jules` label and has triggered Jules
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

  console.log(`[Codemode Auto-Maintainer] Complete.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
