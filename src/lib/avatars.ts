import { invoke } from "@tauri-apps/api/core";
import { createAvatarLoader } from "@/lib/avatar";

export const authorAvatars = createAvatarLoader((provider, email) =>
  invoke<string | null>("get_author_avatar", { email, provider }),
);
