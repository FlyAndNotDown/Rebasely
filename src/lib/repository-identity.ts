import { gitApi } from "@/lib/git";
import type { GitIdentity } from "@/types/git";

/** Keep identity reads and writes attached to the dialog's original repository. */
export function createRepositoryIdentitySession(repoPath: string) {
  let active = true;
  return {
    dispose() {
      active = false;
    },
    async load() {
      if (!active) return null;
      try {
        const [global, local] = await Promise.all([gitApi.getGitIdentity(), gitApi.getLocalGitIdentity(repoPath)]);
        return active ? {
          global,
          value: {
            name: local.name.trim() ? local.name : global.name,
            email: local.email.trim() ? local.email : global.email,
          },
        } : null;
      } catch (error) {
        if (active) throw error;
        return null;
      }
    },
    async save(value: GitIdentity, global: GitIdentity) {
      if (!active) return false;
      try {
        const name = value.name.trim();
        const email = value.email.trim();
        await gitApi.setLocalGitIdentity(repoPath, {
          name: name === global.name.trim() ? "" : name,
          email: email === global.email.trim() ? "" : email,
        });
        return active;
      } catch (error) {
        if (active) throw error;
        return false;
      }
    },
  };
}
