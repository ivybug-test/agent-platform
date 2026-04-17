import type { NextConfig } from "next";
import { execSync } from "child_process";

function git(format: string): string {
  try {
    return execSync(`git log -1 --format=${format}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const NEXT_PUBLIC_GIT_COMMIT = git("%h");
const NEXT_PUBLIC_GIT_SUBJECT = git("%s");
const NEXT_PUBLIC_GIT_DATE = git("%ci");

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["postgres"],
  // Bake the current git commit metadata into the client bundle so
  // UpdateBanner can detect new deployments without a runtime endpoint.
  env: {
    NEXT_PUBLIC_GIT_COMMIT,
    NEXT_PUBLIC_GIT_SUBJECT,
    NEXT_PUBLIC_GIT_DATE,
  },
};

export default nextConfig;
