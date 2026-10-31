import { useTranslation } from "react-i18next";
import { useState, useSyncExternalStore } from "react";
import { FolderTreeIcon, GitBranchIcon, MenuIcon, MinusIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { desktopPlatform } from "@/lib/desktop-platform";
import { GitDemo } from "./demo-git";
import { PerforceDemo } from "./demo-perforce";

const subscribePlatform = () => () => {};
const serverPlatform = () => "macos" as const;

export function WorkspacePreview() {
  const { t } = useTranslation();
  const platform = useSyncExternalStore(subscribePlatform, desktopPlatform, serverPlatform);
  const [repository, setRepository] = useState("git");
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState(t("demo.gitIntro"));

  return (
    <>
      <Tabs value={repository} onValueChange={(value) => { setRepository(value); setNotice(value === "git" ? t("demo.gitIntro") : t("demo.p4Intro")); }} className="workspace-preview" data-platform={platform}>
        {platform === "linux" ? <div className="demo-system-frame" aria-hidden="true">Rebasely</div> : null}
        <div className="demo-titlebar">
          {platform === "macos" ? <span className="demo-traffic-lights" aria-hidden="true"><i /><i /><i /></span> : null}
          <span className="demo-options" aria-hidden="true"><MenuIcon /></span>
          <TabsList aria-label={t("demo.repositories")} className="demo-repository-tabs">
            <TabsTrigger value="git"><GitBranchIcon /><span>atlas</span><span className="demo-vcs-label">Git</span></TabsTrigger>
            <TabsTrigger value="perforce"><FolderTreeIcon /><span>studio</span><span className="demo-vcs-label">Perforce</span></TabsTrigger>
          </TabsList>
          {platform === "windows" ? <span className="demo-window-controls" aria-hidden="true"><MinusIcon /><SquareIcon /><XIcon /></span> : null}
        </div>
        <TabsContent forceMount hidden={repository !== "git"} value="git" className="demo-repository-panel"><GitDemo key={`git-${generation}`} onNotice={setNotice} /></TabsContent>
        <TabsContent forceMount hidden={repository !== "perforce"} value="perforce" className="demo-repository-panel"><PerforceDemo key={`p4-${generation}`} onNotice={setNotice} /></TabsContent>
      </Tabs>
      <div className="site-demo-help"><p role="status" aria-live="polite">{notice}</p><Button size="sm" variant="ghost" onClick={() => { setGeneration((current) => current + 1); setNotice(t("demo.resetNotice")); }}><RotateCcwIcon />{t("demo.reset")}</Button></div>
    </>
  );
}
