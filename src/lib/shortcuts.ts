export interface KeyCombo {
  key: string;
  /** Ctrl, or Cmd on macOS. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export const SHORTCUTS = {
  palette: [{ key: "k", mod: true }, { key: "F1" }],
  openRepository: [{ key: "o", mod: true }],
  closeRepository: [{ key: "w", mod: true }],
  nextTab: [{ key: "Tab", mod: true }, { key: "PageDown", mod: true }],
  previousTab: [{ key: "Tab", mod: true, shift: true }, { key: "PageUp", mod: true }],
  viewChanges: [{ key: "1", mod: true }],
  viewHistory: [{ key: "2", mod: true }],
  viewStash: [{ key: "3", mod: true }],
  viewFiles: [{ key: "4", mod: true }],
  fetch: [{ key: "f", mod: true, shift: true }],
  pull: [{ key: "l", mod: true, shift: true }],
  push: [{ key: "u", mod: true, shift: true }],
  newBranch: [{ key: "n", mod: true, shift: true }],
  stashAll: [{ key: "s", mod: true, shift: true }],
  reflog: [{ key: "r", mod: true, shift: true }],
  openInEditor: [{ key: "e", mod: true }],
  openTerminal: [{ key: "`", mod: true }],
  settings: [{ key: ",", mod: true }],
} satisfies Record<string, KeyCombo[]>;

export type ShortcutId = keyof typeof SHORTCUTS;

export function matchesCombo(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">, combo: KeyCombo) {
  const mod = event.ctrlKey || event.metaKey;
  return (
    event.key.toLowerCase() === combo.key.toLowerCase() &&
    Boolean(combo.mod) === mod &&
    Boolean(combo.shift) === event.shiftKey &&
    Boolean(combo.alt) === event.altKey
  );
}

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

export function formatCombo(combo: KeyCombo, mac = isMac): string {
  const key = combo.key.length === 1 ? combo.key.toUpperCase() : combo.key;
  if (mac) return `${combo.mod ? "⌘" : ""}${combo.alt ? "⌥" : ""}${combo.shift ? "⇧" : ""}${key}`;
  return [combo.mod && "Ctrl", combo.alt && "Alt", combo.shift && "Shift", key].filter(Boolean).join("+");
}

/** Whether keystrokes are going into a text field, where single-letter shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
