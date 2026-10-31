import { useLayoutEffect, useRef } from "react";
import { useGroupRef, type Layout } from "react-resizable-panels";
import { useGitPick, useGitSelect } from "@/state/git-context";
import type { PanelLayoutId } from "@/types/git";

/** Restores a panel group's saved sizes and saves them again when the user drags. */
export function usePanelGroupLayout(id: PanelLayoutId) {
  const { updatePanelLayout } = useGitPick(["updatePanelLayout"]);
  const layout = useGitSelect((state) => state.prefs.panelLayouts[id]);
  const groupRef = useGroupRef();
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  });

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      groupRef.current?.setLayout(layoutRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [groupRef]);

  return {
    groupRef,
    defaultLayout: layout,
    onLayoutChanged: (next: Layout, meta: { isUserInteraction: boolean }) => {
      if (meta.isUserInteraction) updatePanelLayout(id, next);
    },
  };
}
