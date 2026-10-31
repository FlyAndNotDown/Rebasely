import { gitApi } from "@/lib/git";
import { p4Api } from "@/lib/p4";

function fulfilled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

/** A missing executable must not prevent users from choosing its replacement. */
export async function loadSettingsData() {
  const results = await Promise.allSettled([
    gitApi.getGitIdentity(),
    gitApi.getPrefs(),
    gitApi.listTerminals(),
    gitApi.listEditors(),
    gitApi.getToolConfig(),
    gitApi.listGuiTools(),
    gitApi.gitExecutables(),
    p4Api.executables(),
  ] as const);
  return {
    identity: fulfilled(results[0]),
    prefs: fulfilled(results[1]),
    terminals: fulfilled(results[2]),
    editors: fulfilled(results[3]),
    tools: fulfilled(results[4]),
    guiTools: fulfilled(results[5]),
    gitExecutables: fulfilled(results[6]),
    p4Executables: fulfilled(results[7]),
    incomplete: results.some((result) => result.status === "rejected"),
  };
}
