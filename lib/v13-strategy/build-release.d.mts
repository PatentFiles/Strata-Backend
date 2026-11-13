export function buildReleaseIdentity(cwd: string): {
  revision: string;
  tree: string;
  dirty: boolean;
  provenance: string;
};
