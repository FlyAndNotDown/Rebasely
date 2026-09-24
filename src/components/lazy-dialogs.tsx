import { lazy, Suspense, useState, type ComponentType } from "react";

/**
 * Loads a rarely used dialog the first time it opens. It stays mounted after
 * that so its close animation still plays.
 */
function lazyDialog<P extends object>(
  load: () => Promise<ComponentType<P>>,
  isOpen: (props: P) => boolean,
) {
  const Dialog = lazy(async () => ({ default: await load() }));
  return function LazyDialog(props: P) {
    const open = isOpen(props);
    const [opened, setOpened] = useState(open);
    if (open && !opened) setOpened(true);
    if (!opened) return null;
    return (
      <Suspense fallback={null}>
        <Dialog {...props} />
      </Suspense>
    );
  };
}

export const SettingsDialog = lazyDialog(
  () => import("@/components/settings-dialog").then((module) => module.SettingsDialog),
  (props) => props.open,
);

export const CloneRepositoryDialog = lazyDialog(
  () => import("@/components/clone-repository-dialog").then((module) => module.CloneRepositoryDialog),
  (props) => props.open,
);

export const RepoSettingsDialog = lazyDialog(
  () => import("@/components/repo-settings-dialog").then((module) => module.RepoSettingsDialog),
  (props) => props.open,
);

export const AddRemoteDialog = lazyDialog(
  () => import("@/components/add-remote-dialog").then((module) => module.AddRemoteDialog),
  (props) => props.open,
);

export const InteractiveRebaseDialog = lazyDialog(
  () => import("@/components/interactive-rebase-dialog").then((module) => module.InteractiveRebaseDialog),
  (props) => props.onto !== null,
);
