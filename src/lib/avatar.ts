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
