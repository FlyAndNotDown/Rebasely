import { t, useTranslation } from "@/i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArchiveIcon, CircleDotIcon, FolderTreeIcon, HistoryIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/lazy-dialogs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { normalizeSidebarOrder, SIDEBAR_VIEWS } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useGitPick, type View } from "@/state/git-context";
import { useP4, type P4View } from "@/state/p4-context";

const itemMeta: Record<View, { label: string; icon: typeof CircleDotIcon }> = {
  changes: { get label() { return t("desktop.appSidebar.changes"); }, icon: CircleDotIcon },
  history: { get label() { return t("desktop.appSidebar.history"); }, icon: HistoryIcon },
  stash: { get label() { return t("desktop.appSidebar.stash"); }, icon: ArchiveIcon },
  files: { get label() { return t("desktop.appSidebar.files"); }, icon: FolderTreeIcon },
};

const perforceItems: { id: P4View; label: string; icon: typeof CircleDotIcon }[] = [
  { id: "pending", get label() { return t("desktop.appSidebar.pending"); }, icon: CircleDotIcon },
  { id: "submitted", get label() { return t("desktop.appSidebar.history"); }, icon: HistoryIcon },
  { id: "workspace", get label() { return t("desktop.appSidebar.workspace"); }, icon: FolderTreeIcon },
];

export function AppSidebar() {
  useTranslation();
  const { view, setView, activeTab, prefs, updatePrefs, openPanel, setOpenPanel } = useGitPick([
    "view",
    "setView",
    "activeTab",
    "prefs",
    "updatePrefs",
    "openPanel",
    "setOpenPanel",
  ]);
  const settingsOpen = openPanel === "settings";
  const setSettingsOpen = (open: boolean) => setOpenPanel(open ? "settings" : null);
  const p4 = useP4();
  const perforce = activeTab.kind === "repo" && activeTab.vcs === "perforce";
  const [order, setOrder] = useState<View[]>(() => asViews(prefs.sidebarOrder));
  const [savedOrder, setSavedOrder] = useState(prefs.sidebarOrder);
  const [dragging, setDragging] = useState<View | null>(null);
  const dragRef = useRef<{ view: View; startY: number; active: boolean } | null>(null);
  const orderRef = useRef(order);
  const listRef = useRef<HTMLDivElement>(null);
  const repoOpen = activeTab.kind === "repo";
  if (savedOrder !== prefs.sidebarOrder) {
    setSavedOrder(prefs.sidebarOrder);
    setOrder(asViews(prefs.sidebarOrder));
  }
  useLayoutEffect(() => {
    orderRef.current = order;
  });

  useEffect(() => {
    function dropTargetAt(clientY: number): { view: View; place: "before" | "after" } | null {
      const nodes = listRef.current
        ? Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-sidebar-view]"))
        : [];
      if (nodes.length === 0) return null;
      for (const node of nodes) {
        const id = node.dataset.sidebarView as View | undefined;
        if (!id) continue;
        const rect = node.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          return { view: id, place: "before" };
        }
      }
      const last = nodes[nodes.length - 1]?.dataset.sidebarView as View | undefined;
      return last ? { view: last, place: "after" } : null;
    }

    function moveItem(from: View, to: View, place: "before" | "after") {
      const current = orderRef.current;
      const fromIndex = current.indexOf(from);
      if (fromIndex < 0) return current;
      const next = current.filter((item) => item !== from);
      let insert = next.indexOf(to);
      if (insert < 0) return current;
      if (place === "after") insert += 1;
      next.splice(insert, 0, from);
      if (next.every((item, index) => item === current[index])) return current;
      setOrder(next);
      return next;
    }

    function onPointerMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active && Math.abs(event.clientY - drag.startY) < 6) return;
      if (!drag.active) {
        drag.active = true;
        setDragging(drag.view);
      }
      const target = dropTargetAt(event.clientY);
      if (target && target.view !== drag.view) {
        moveItem(drag.view, target.view, target.place);
      }
    }

    function endDrag() {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(null);
      if (!drag?.active) return;
      const next = orderRef.current;
      if (next.join() === prefs.sidebarOrder.join()) return;
      void updatePrefs({ ...prefs, sidebarOrder: next });
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [prefs, updatePrefs]);

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2">
      <div ref={listRef} className={cn("flex flex-col items-center gap-1", dragging && "select-none")}>
        {perforce
          ? perforceItems.map((item) => {
              const Icon = item.icon;
              const active = p4.view === item.id;
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={item.label}
                      aria-current={active ? "page" : undefined}
                      className={cn(active && "bg-muted text-foreground")}
                      onClick={() => p4.setView(item.id)}
                    >
                      <Icon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              );
            })
          : order.map((id) => {
          const item = itemMeta[id];
          const Icon = item.icon;
          const active = repoOpen && view === id;
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-sidebar-view={id}
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "cursor-grab",
                    active && "bg-muted text-foreground",
                    !repoOpen && "opacity-50",
                    dragging === id && "cursor-grabbing opacity-60",
                  )}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    dragRef.current = { view: id, startY: event.clientY, active: false };
                    if (repoOpen) setView(id);
                  }}
                  onClick={(event) => {
                    // Pointer presses switch on pointerdown; detail 0 is Enter or Space.
                    if (event.detail === 0 && repoOpen) setView(id);
                  }}
                >
                  <Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="mt-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("common.settings")}
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("common.settings")}</TooltipContent>
        </Tooltip>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </nav>
  );
}

function asViews(order: string[]): View[] {
  return normalizeSidebarOrder(order).filter((item): item is View =>
    (SIDEBAR_VIEWS as readonly string[]).includes(item),
  );
}
