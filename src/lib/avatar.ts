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

export type AvatarProvider = "builtin" | "github" | "gitlab";

interface AvatarJob {
  provider: AvatarProvider;
  email: string;
  generation: number;
  promise: Promise<string | null>;
  resolve: (value: string | null) => void;
}

/** Small shared queue: virtual rows with the same author share a single request. */
export function createAvatarLoader(
  fetch: (provider: AvatarProvider, email: string) => Promise<string | null>,
  now: () => number = Date.now,
) {
  const entries = new Map<string, { data: string | null; expires: number }>();
  const pending = new Map<string, AvatarJob>();
  const queue: AvatarJob[] = [];
  let provider: AvatarProvider = "builtin";
  let generation = 0;
  let active = 0;

  function activate(next: AvatarProvider) {
    if (provider === next) return;
    provider = next;
    generation += 1;
    entries.clear();
    pending.clear();
    for (const job of queue.splice(0)) job.resolve(null);
  }

  function remember(email: string, data: string | null) {
    entries.delete(email);
    entries.set(email, { data, expires: now() + (data ? 6 * 60 * 60_000 : 15 * 60_000) });
    let bytes = [...entries.values()].reduce((total, value) => total + (value.data?.length ?? 0), 0);
    while (entries.size > 128 || bytes > 4 * 1_048_576) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      bytes -= entries.get(oldest)?.data?.length ?? 0;
      entries.delete(oldest);
    }
  }

  function pump() {
    while (active < 2 && queue.length > 0) {
      const job = queue.shift()!;
      active += 1;
      void Promise.resolve().then(() => fetch(job.provider, job.email)).catch(() => null).then((data) => {
        const current = job.generation === generation;
        const safe = data && data.length <= 90_000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(data) ? data : null;
        if (current) remember(job.email, safe);
        job.resolve(current ? safe : null);
      }).finally(() => {
        active -= 1;
        if (pending.get(job.email) === job) pending.delete(job.email);
        pump();
      });
    }
  }

  return {
    get(next: AvatarProvider, address: string): Promise<string | null> {
      activate(next);
      const email = address.trim().toLowerCase();
      if (next === "builtin" || email.length > 254 || !/^[a-z0-9._+%-]+@[a-z0-9.-]+$/i.test(email)) return Promise.resolve(null);
      const cached = entries.get(email);
      if (cached && cached.expires > now()) {
        entries.delete(email);
        entries.set(email, cached);
        return Promise.resolve(cached.data);
      }
      const existing = pending.get(email);
      if (existing) return existing.promise;
      if (queue.length >= 64) return Promise.resolve(null);
      let resolve!: AvatarJob["resolve"];
      const promise = new Promise<string | null>((done) => { resolve = done; });
      const job = { provider: next, email, generation, promise, resolve };
      pending.set(email, job);
      queue.push(job);
      pump();
      return promise;
    },
  };
}
