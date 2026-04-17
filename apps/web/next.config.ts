import type { NextConfig } from "next";
import { execSync } from "child_process";

interface CommitInfo {
  sha: string;
  subject: string;
  date: string;
}

function gitRecent(n: number): CommitInfo[] {
  try {
    // \x1f = unit separator (between fields); \x1e = record separator (between commits)
    const out = execSync(
      `git log -${n} --format=%h%x1f%s%x1f%ci%x1e`,
      { stdio: ["ignore", "pipe", "ignore"] }
    ).toString();
    return out
      .split("\x1e")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, date] = line.split("\x1f");
        return { sha, subject, date };
      });
  } catch {
    return [];
  }
}

const NEXT_PUBLIC_RECENT_COMMITS = JSON.stringify(gitRecent(3));

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["postgres"],
  // Bake the last few commits into the client bundle so UpdateBanner can
  // display "what's new" without a runtime endpoint. Each deploy freezes a
  // new snapshot.
  env: {
    NEXT_PUBLIC_RECENT_COMMITS,
  },
};

export default nextConfig;
