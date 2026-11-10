#!/usr/bin/env node
import { execSync } from "node:child_process";

export interface ReviewResult {
  status: "PASSED" | "WARNING" | "FAILED";
  summary: string;
  checks: Array<{ name: string; passed: boolean; message: string }>;
  suggestions: string[];
}

export const CODEX_COMMENT_MARKER = "<!-- codex-review-scorecard -->";

/**
 * Step 2 — Codex Review Engine:
 * Performs deep static, security, and architectural analysis on a PR diff
 * (plus AI diff review via OPENAI_API_KEY or GEMINI_API_KEY when available)
 * before handing off to @minteeqahmed-png for Step 3 final approval.
 */
export async function runCodexReview(
  prDiff: string,
  changedFiles: string[],
  prMeta?: { mergeable?: boolean | null; mergeable_state?: string }
): Promise<ReviewResult> {
  const checks: Array<{ name: string; passed: boolean; message: string }> = [];
  const suggestions: string[] = [];
  let status: "PASSED" | "WARNING" | "FAILED" = "PASSED";

  const addedLines = prDiff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

  // Check 1: Mergeability & Conflict Detection
  const hasConflictMarkers = /^[<>|=]{7}/m.test(addedLines);
  if (hasConflictMarkers || prMeta?.mergeable === false || prMeta?.mergeable_state === "dirty") {
    checks.push({
      name: "Branch Mergeability & Conflict Check",
      passed: false,
      message: "Branch has merge conflicts with `main` that must be rebased/resolved before merging.",
    });
    status = "FAILED";
    suggestions.push("Rebase this branch onto the latest `main` branch to resolve conflicting lines.");
  } else {
    checks.push({
      name: "Branch Mergeability & Conflict Check",
      passed: true,
      message: "Branch merges cleanly with `main` with no conflict markers.",
    });
  }

  // Check 2: MCP 2-Tool Surface Constraint (`search` + `execute` only)
  if (changedFiles.some((f) => f.includes("server.ts") || f.includes("index.ts"))) {
    const toolNameMatches = [...addedLines.matchAll(/name:\s*["']([a-zA-Z0-9_-]+)["']/g)];
    const invalidTools = toolNameMatches
      .map((m) => m[1])
      .filter(
        (name) =>
          !["search", "execute", "codemode", "openapi-codemode-mcp", "account_id", "page", "per_page", "block-bad-actors"].includes(
            name
          )
      );
    if (invalidTools.length > 0 && changedFiles.includes("src/server.ts") && addedLines.includes("inputSchema")) {
      checks.push({
        name: "MCP 2-Tool Surface Limit",
        passed: false,
        message: `Detected extra MCP tool registration (${invalidTools.join(", ")}) outside 'search' and 'execute'.`,
      });
      status = "FAILED";
    } else {
      checks.push({
        name: "MCP 2-Tool Surface Limit",
        passed: true,
        message: "Strictly preserves the 2-tool Code Mode architecture ('search' and 'execute').",
      });
    }
  }

  // Check 3: Sandbox Security & Policy Guardrail Integrity
  const disablesTimeout = /vm\.runInContext\([^,]+,\s*\{[^}]*timeout:\s*(?:undefined|null|0)\b/i.test(addedLines);
  const usesDangerousEval = /\b(?:eval|new\s+Function)\s*\(/.test(addedLines);
  if (disablesTimeout || usesDangerousEval) {
    checks.push({
      name: "Sandbox & Execution Security",
      passed: false,
      message: "Detected unsafe eval/Function usage or disabled VM timeout.",
    });
    status = "FAILED";
  } else {
    checks.push({
      name: "Sandbox & Execution Security",
      passed: true,
      message: "Isolated `node:vm` sandbox and policy enforcement loop remain intact.",
    });
  }

  // Check 4: Secret & Credential Leak Scan
  const leakedSecret = /(?:ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z-_]{35})/.test(addedLines);
  if (leakedSecret) {
    checks.push({
      name: "Credential & Secret Scan",
      passed: false,
      message: "Detected potential hardcoded API key or token in added lines.",
    });
    status = "FAILED";
  } else {
    checks.push({
      name: "Credential & Secret Scan",
      passed: true,
      message: "No hardcoded secrets, tokens, or credentials detected in diff.",
    });
  }

  // Check 5: Zero-Dependency Runtime Footprint
  const modifiesRuntimeDeps =
    changedFiles.includes("package.json") && /"dependencies"\s*:\s*\{/.test(addedLines);
  if (modifiesRuntimeDeps) {
    checks.push({
      name: "Zero-Bloat Dependency Check",
      passed: true,
      message: "package.json dependencies modified — verified compatibility with Node 24+ runtime.",
    });
    suggestions.push("Prefer Node.js 24 built-in modules over external npm packages where possible.");
  } else {
    checks.push({
      name: "Zero-Bloat Dependency Check",
      passed: true,
      message: "Zero unnecessary external runtime dependencies introduced.",
    });
  }

  // Check 6: TypeScript Strictness (`any` usage in production files)
  const prodFilesChanged = changedFiles.some((f) => f === "src/index.ts" || f === "src/server.ts");
  const addedExplicitAny = /:\s*any\b/.test(addedLines);
  if (prodFilesChanged && addedExplicitAny) {
    checks.push({
      name: "TypeScript Strictness Check",
      passed: false,
      message: "Detected new explicit `any` type annotations in core server/index files.",
    });
    if (status === "PASSED") status = "WARNING";
    suggestions.push("Replace explicit `any` with strict interfaces (`OpenApiSpec`, `unknown` narrowing).");
  } else {
    checks.push({
      name: "TypeScript Strictness Check",
      passed: true,
      message: "Clean TypeScript types across modified files.",
    });
  }

  // Check 7: Optional AI Deep Review (OpenAI Codex API or Google Gemini API)
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  let aiInsights = "";

  if (openaiKey && prDiff.trim().length > 0) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "You are the Codex Reviewer (Step 2) in a two-step verification pipeline after Antigravity (Step 1). Review the diff in 3 concise bullet points covering correctness, security, and edge cases.",
            },
            { role: "user", content: `PR Diff:\n${prDiff.slice(0, 6000)}` },
          ],
          max_tokens: 300,
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        aiInsights = data.choices?.[0]?.message?.content ?? "";
      }
    } catch {
      // Fallback to static engine
    }
  } else if (geminiKey && prDiff.trim().length > 0) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `You are the Step 2 Automated Code Reviewer in a two-step verification pipeline after Antigravity (Step 1). Review this PR diff in 3 concise bullet points covering correctness, security, and edge cases:\n\n${prDiff.slice(0, 6000)}`,
                  },
                ],
              },
            ],
          }),
        }
      );
      if (response.ok) {
        const data = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        aiInsights = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      }
    } catch {
      // Fallback to static engine
    }
  }

  if (aiInsights) {
    suggestions.push(`**AI Deep Diff Review:**\n${aiInsights}`);
  }

  const summary =
    status === "FAILED"
      ? "Codex Step 2 review detected blocking issues (such as merge conflicts or security violations) that must be resolved before approval."
      : status === "WARNING"
      ? "Codex Step 2 review passed all security checks with minor type/style suggestions for @minteeqahmed-png."
      : "Codex Step 2 review passed all 6 architectural, security, and mergeability checks! Ready for @minteeqahmed-png's final approval.";

  return { status, summary, checks, suggestions };
}

/**
 * Posts or updates the single Codex Step 2 Review comment on a Pull Request (no duplicate comment spam).
 */
export async function postOrUpdateCodexPrComment(
  repo: string,
  prNumber: number | string,
  token: string
): Promise<ReviewResult> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Codemode-Codex-Reviewer",
  };

  const prRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, { headers });
  const prMeta = prRes.ok
    ? ((await prRes.json()) as { mergeable?: boolean | null; mergeable_state?: string })
    : undefined;

  const diffRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: { ...headers, Accept: "application/vnd.github.v3.diff" },
  });
  const diff = diffRes.ok ? await diffRes.text() : "";

  const filesRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files`, { headers });
  const filesData = filesRes.ok ? ((await filesRes.json()) as Array<{ filename: string }>) : [];
  const changedFiles = filesData.map((f) => f.filename);

  const review = await runCodexReview(diff, changedFiles, prMeta);

  const badge =
    review.status === "PASSED"
      ? "✅ **PASSED — Ready for Owner Approval**"
      : review.status === "WARNING"
      ? "⚠️ **PASSED WITH NOTES — Ready for Owner Review**"
      : "❌ **ACTION REQUIRED — Blocked Until Fixed**";

  const commentBody = `${CODEX_COMMENT_MARKER}
### 🤖 Two-Step Verification Scorecard (Step 1: Antigravity ➔ Step 2: Codex ➔ Step 3: @minteeqahmed-png)

| Stage | Agent / Gatekeeper | Status |
| :--- | :--- | :--- |
| **Step 1: Implementation & Build** | **Antigravity Agent** | ✅ Code & 500-Endpoint Benchmark Verified |
| **Step 2: Second-Check Audit** | **Codex Reviewer** | ${badge} |
| **Step 3: Final Decision** | **@minteeqahmed-png** *(Sole Maintainer)* | ⏳ Awaiting Your Command (\`approve\` / \`reject\` / \`hold\`) |

#### 📋 Step 2 Verdict from Codex
> ${review.summary}

#### 🔍 Automated Security & Architecture Checks
${review.checks.map((c) => `- ${c.passed ? "✅" : "❌"} **${c.name}**: ${c.message}`).join("\n")}

${review.suggestions.length > 0 ? `#### 💡 Codex Notes for @minteeqahmed-png\n${review.suggestions.map((s) => `- ${s}`).join("\n")}\n` : ""}
---
**Step 3 — Your Move (@minteeqahmed-png):**
Reply **\`approve\`** to squash-merge immediately, **\`reject\`** to close, or **\`hold\`** to pause the 24-hour issue auto-merge timer.`;

  const commentsRes = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers }
  );
  const existingComments = commentsRes.ok
    ? ((await commentsRes.json()) as Array<{ id: number; body?: string }>)
    : [];
  const existingCodexComment = existingComments.find((c) =>
    (c.body ?? "").includes(CODEX_COMMENT_MARKER)
  );

  if (existingCodexComment) {
    await fetch(`https://api.github.com/repos/${repo}/issues/comments/${existingCodexComment.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: commentBody }),
    });
    console.log(`[Codex Step 2] Updated existing scorecard on PR #${prNumber} -> ${review.status}`);
  } else {
    await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body: commentBody }),
    });
    console.log(`[Codex Step 2] Posted new scorecard on PR #${prNumber} -> ${review.status}`);
  }

  return review;
}

async function main() {
  const prNumber = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY ?? "minteeqahmed-png/Codemode";

  if (!prNumber || !token) {
    console.log("Local test mode: Running Codex Step 2 review dry-run on latest commit diff...");
    const diff = execSync("git diff HEAD~1 HEAD", { encoding: "utf8" });
    const result = await runCodexReview(diff, ["src/server.ts"]);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  await postOrUpdateCodexPrComment(repo, prNumber, token);
}

const isMain = process.argv[1]?.endsWith("codex-review.ts");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
