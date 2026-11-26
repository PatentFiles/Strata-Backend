import { execFileSync } from "node:child_process";

// Captured at build time, never inferred from the checkout after startup.
export function buildReleaseIdentity(cwd, env = process.env) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return {
      revision: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      dirty: git("status", "--porcelain", "--untracked-files=normal") !== "",
      provenance: "git-at-build",
    };
  } catch {
    const revision = env.RAILWAY_GIT_COMMIT_SHA || env.GITHUB_SHA;
    if (typeof revision === 'string' && /^[a-f0-9]{40}$/i.test(revision)) {
      // Archive builds have no .git metadata. Unknown dirtiness stays conservative.
      return { revision: revision.toLowerCase(), tree: 'unavailable', dirty: true,
        provenance: 'provider-commit-at-build' };
    }
    return { revision: "unavailable", tree: "unavailable", dirty: true, provenance: "unavailable" };
  }
}
