import type { AvatarProvider } from "@/types/git";

export function dicebearUrl(seed: string): string {
  return `https://api.dicebear.com/10.x/glyphs/svg?seed=${encodeURIComponent(seed || "user")}`;
}

export function avatarUrl(_provider: AvatarProvider, name: string, email: string): string {
  return dicebearUrl(name.trim() || email.trim() || "user");
}
