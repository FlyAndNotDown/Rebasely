import type { AvatarProvider } from "@/types/git";

export const AVATAR_PROVIDERS: { id: AvatarProvider; label: string }[] = [
  { id: "initials", label: "Initials (offline)" },
  { id: "dicebear-online", label: "DiceBear (sends author names online)" },
];

// Older builds always stored "dicebear" without asking, so it maps to the default.
export function normalizeAvatarProvider(value: unknown): AvatarProvider {
  return AVATAR_PROVIDERS.some((item) => item.id === value) ? (value as AvatarProvider) : "initials";
}

export function avatarSeed(name: string, email: string): string {
  return name.trim() || email.trim() || "user";
}

export function dicebearUrl(seed: string): string {
  return `https://api.dicebear.com/10.x/glyphs/svg?seed=${encodeURIComponent(seed)}`;
}

export function avatarInitial(seed: string): string {
  const letter = seed.match(/\p{L}|\p{N}/u)?.[0] ?? "?";
  return letter.toUpperCase();
}

export function avatarHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}
