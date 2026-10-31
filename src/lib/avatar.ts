export function avatarSeed(name: string, email: string): string {
  return name.trim() || email.trim() || "user";
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

// A short set of muted tones, so neighboring authors don't land on clashing hues.
const AVATAR_COLORS = [
  "#3e4e66",
  "#3c5f59",
  "#6a4b38",
  "#53466a",
  "#455a3c",
  "#3b5570",
  "#6a424c",
  "#514c39",
];

export function avatarColor(seed: string): string {
  return AVATAR_COLORS[avatarHue(seed) % AVATAR_COLORS.length];
}
