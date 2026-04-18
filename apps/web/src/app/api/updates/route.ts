import "@/lib/env";
import { getRequiredUser } from "@/lib/session";
import { getRedisClient } from "@/lib/redis";
import { createLogger } from "@agent-platform/logger";
import { RECENT_COMMITS, type CommitInfo } from "@/lib/build-info.generated";

const log = createLogger("web");

type Commit = CommitInfo;

const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL!;
const BANNER_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — way beyond the 3-day banner window

const SUMMARY_SYSTEM_PROMPT = `你是产品更新说明撰写助手,面向普通用户。给定若干 git commit 标题,生成简短的中文更新摘要。

要求:
- 合并相关 commit,总共 1-3 条要点
- 用日常中文,不要 "重构 / 迁移 / refactor / migrate / 修复 bug" 这类开发术语。关注用户能感知到的变化。
- 每条以 "· " 开头,每行一条
- 不要引言、不要结语、不要"以下是..."
- 整个摘要不超过 100 字`;

export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const commits: Commit[] = RECENT_COMMITS;

  if (commits.length === 0) {
    log.info({ userId: user.id }, "updates.no-baked-commits");
    return Response.json({ commits: [], summary: "" });
  }

  // Auto-hide if newest commit is older than 3 days (client also enforces this)
  const newestMs = new Date(commits[0].date).getTime();
  if (!Number.isFinite(newestMs) || Date.now() - newestMs > BANNER_MAX_AGE_MS) {
    return Response.json({ commits, summary: "", expired: true });
  }

  const cacheKey = `update-banner:${commits.map((c) => c.sha).join("-")}`;
  const redis = getRedisClient();

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      log.info({ userId: user.id, cacheKey }, "updates.cache-hit");
      return Response.json({ commits, summary: cached, fromCache: true });
    }
  } catch (err) {
    log.warn({ err }, "updates.cache-read-failed");
  }

  log.info(
    { userId: user.id, cacheKey, commitCount: commits.length },
    "updates.cache-miss"
  );

  const userPrompt = commits
    .map((c, i) => `${i + 1}. ${c.subject}`)
    .join("\n");

  try {
    const res = await fetch(`${AGENT_RUNTIME_URL}/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system: SUMMARY_SYSTEM_PROMPT,
        user: userPrompt,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "updates.summarize-failed");
      return Response.json({ commits, summary: "" });
    }
    const { text } = await res.json();
    const summary = String(text || "").trim();
    if (summary) {
      try {
        await redis.set(cacheKey, summary, "EX", CACHE_TTL_SECONDS);
        log.info({ cacheKey, length: summary.length }, "updates.cached");
      } catch (err) {
        log.warn({ err }, "updates.cache-write-failed");
      }
    }
    return Response.json({ commits, summary });
  } catch (err) {
    log.error({ err }, "updates.fetch-failed");
    return Response.json({ commits, summary: "" });
  }
}
