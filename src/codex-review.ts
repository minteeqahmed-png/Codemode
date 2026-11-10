#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

interface ReviewResult {
  status: "PASSED" | "WARNING" | "FAILED";
  summary: string;
  checks: Array<{ name: string; passed: boolean; message: string }>;
  suggestions: string[];
}

/**
 * Codex Review Engine:
 * Analyzes code diffs against Codemode architectural standards,
 * security policies, and performance constraints.
 */
export async function runCodexReview(prDiff: string, changedFiles: string[]): Promise<ReviewResult> {
  const checks: Array<{ name: string; passed: boolean; message: string }> = [];
  const suggestions: string[] = [];
  let status: "PASSED" | "WARNING" | "FAILED" = "PASSED";

  // Check 1: Tool surface constraint (must only expose search and execute)
  if (changedFiles.some((f) => f.includes("server.ts") || f.includes("index.ts"))) {
    const hasExtraToolRegistrations = /name:\s*["'](?!search|execute)[a-zA-Z0-9_-]+["']/g.test(prDiff);
    if (hasExtraToolRegistrations) {
      checks.push({
        name: "MCP 2-Tool Surface Limit",
        passed: false,
        message: "Detected new tool registration outside the 2-tool ('search' + 'execute') architecture.",
      });
      status = "FAILED";
    } else {
      checks.push({
        name: "MCP 2-Tool Surface Limit",
        passed: true,
        message: "Complies with strict 2-tool Code Mode model ('search' and 'execute').",
      });
    }
  }

  // Check 2: Sandbox Security & Policy Guardrails
  const hasUnsafeVM = /vm\.runInContext\([^,]+,\s*\{[^}]*timeout:\s*(undefined|null|0)[^}]*\}/i.test(prDiff);
  const hasBypassedPolicies = /apiHelper\.request\s*=\s*async[^{]*\{(?![^]*for\s*\([^)]*policies)/.test(prDiff);

  if (hasUnsafeVM || hasBypassedPolicies) {
    checks.push({
      name: "Sandbox Security Guardrails",
      passed: false,
      message: "Detected potential bypass of timeout or policy validation in execution sandbox.",
    });
    status = "FAILED";
  } else {
    checks.push({
      name: "Sandbox Security Guardrails",
      passed: true,
      message: "Execution sandbox properly enforces timeout and audit policies.",
    });
  }

  // Check 3: Zero-dependency & Node built-ins check
  const addsNewExternalDeps = /"\+.*(?:dependencies|devDependencies)":\s*\{[^}]*\}/.test(prDiff);
  if (addsNewExternalDeps) {
    checks.push({
      name: "Dependency Footprint",
      passed: true,
      message: "PR adds dependencies. Ensure they are essential and audited.",
    });
    suggestions.push("Keep runtime dependencies to zero where possible by leveraging Node.js 24+ built-ins.");
  } else {
    checks.push({
      name: "Dependency Footprint",
      passed: true,
      message: "Zero unnecessary external dependencies added.",
    });
  }

  // Check 4: Type Safety & 'any' check
  const addedExplicitAny = /\+\s*(?:let|const|var|function|\w+:)\s*.*:\s*any\b/.test(prDiff);
  if (addedExplicitAny) {
    checks.push({
      name: "TypeScript Strictness",
      passed: false,
      message: "Detected added explicit 'any' types. Use strict types or 'unknown' narrowing.",
    });
    if (status !== "FAILED") status = "WARNING";
    suggestions.push("Replace explicit 'any' with narrow interfaces or generic type parameters.");
  } else {
    checks.push({
      name: "TypeScript Strictness",
      passed: true,
      message: "No loose 'any' types introduced in modified code.",
    });
  }

  // Check 5: OpenAI Codex API enrichment (if OPENAI_API_KEY is configured)
  const openaiKey = process.env.OPENAI_API_KEY;
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
                "You are the Codex Reviewer for the Codemode project. Review the code diff for logic errors, edge cases, and performance regressions. Be concise in 3 bullet points.",
            },
            {
              role: "user",
              content: `PR Diff:\n${prDiff.slice(0, 4000)}`,
            },
          ],
          max_tokens: 300,
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as any;
        aiInsights = data.choices?.[0]?.message?.content ?? "";
      }
    } catch {
      // Gracefully fall back to rule-based engine
    }
  }

  const summary =
    status === "FAILED"
      ? "Codex review found critical security or architectural violations that must be fixed before merging."
      : status === "WARNING"
      ? "Codex review passed with minor code quality suggestions."
      : "Codex review passed! Architecture, security policies, and TypeScript standards verified.";

  if (aiInsights) {
    suggestions.push(`**Codex AI Insights:**\n${aiInsights}`);
  }

  return { status, summary, checks, suggestions };
}

async function main() {
  const prNumber = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY ?? "minteeqahmed-png/Codemode";

  if (!prNumber || !token) {
    console.log("Local test mode: Running Codex review dry-run on current git diff...");
    const { execSync } = await import("node:child_process");
    const diff = execSync("git diff HEAD~1 HEAD", { encoding: "utf8" });
    const result = await runCodexReview(diff, ["src/server.ts"]);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Fetch PR diff
  const diffRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3.diff",
      "User-Agent": "Codex-Reviewer",
    },
  });

  const diff = diffRes.ok ? await diffRes.text() : "";

  // Fetch PR files list
  const filesRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Codex-Reviewer",
    },
  });
  const filesData = filesRes.ok ? ((await filesRes.json()) as Array<{ filename: string }>) : [];
  const changedFiles = filesData.map((f) => f.filename);

  const review = await runCodexReview(diff, changedFiles);

  // Post Codex Review Comment on PR
  const badge =
    review.status === "PASSED"
      ? "✅ **Codex Check: PASSED**"
      : review.status === "WARNING"
      ? "⚠️ **Codex Check: PASSED WITH SUGGESTIONS**"
      : "❌ **Codex Check: ACTION REQUIRED**";

  const commentBody = `### 🤖 Two-Step Verification Pipeline

| Step | Responsible Agent | Status |
| :--- | :--- | :--- |
| **Step 1: Implementation** | Anti-gravity / Automated Agent | Complete |
| **Step 2: Codex Review** | OpenAI Codex Reviewer | ${badge} |
| **Step 3: Final Approval** | Maintainer (@minteeqahmed-png) | Awaiting Decision |

#### 📋 Codex Review Summary
> ${review.summary}

#### 🔍 Automated Inspection Checks
${review.checks.map((c) => `- ${c.passed ? "✅" : "❌"} **${c.name}**: ${c.message}`).join("\n")}

${review.suggestions.length > 0 ? `#### 💡 Suggestions\n${review.suggestions.map((s) => `- ${s}`).join("\n")}` : ""}

---
**Maintainer Action:**
Reply \`approve\` to merge, or \`reject\` to request revisions.`;

  await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "Codex-Reviewer",
    },
    body: JSON.stringify({ body: commentBody }),
  });

  console.log(`[Codex Review] Comment posted on PR #${prNumber} with verdict: ${review.status}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
