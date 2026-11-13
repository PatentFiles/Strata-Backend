import { execFileSync } from "node:child_process";

// Captured at build time, never inferred from the checkout after startup.
export function buildReleaseIdentity(cwd) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return {
      revision: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      dirty: git("status", "--porcelain", "--untracked-files=normal") !== "",
      provenance: "git-at-build",
    };
  } catch {
    return { revision: "unavailable", tree: "unavailable", dirty: true, provenance: "unavailable" };
  }
}
