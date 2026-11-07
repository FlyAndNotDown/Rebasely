import { normalizeHttpProxy, type HttpProxy } from "@/lib/network";

export interface ProxyDraft {
  value: HttpProxy;
  saved: HttpProxy;
  observed: HttpProxy;
}

function sameProxy(left: HttpProxy, right: HttpProxy): boolean {
  const a = normalizeHttpProxy(left);
  const b = normalizeHttpProxy(right);
  return a.mode === b.mode && a.url.trim() === b.url.trim();
}

export function createProxyDraft(value: HttpProxy): ProxyDraft {
  const initial = normalizeHttpProxy(value);
  return { value: initial, saved: initial, observed: initial };
}

export function proxyDraftChanged(state: ProxyDraft): boolean {
  return !sameProxy(state.value, state.saved);
}

/** Follow persisted values only while the user has no unsaved local edits. */
export function reconcileProxyDraft(state: ProxyDraft, value: HttpProxy): ProxyDraft {
  if (sameProxy(state.observed, value)) return state;
  const incoming = normalizeHttpProxy(value);
  return {
    value: proxyDraftChanged(state) ? state.value : incoming,
    saved: incoming,
    observed: incoming,
  };
}

export function editProxyDraft(state: ProxyDraft, patch: Partial<HttpProxy>): ProxyDraft {
  return { ...state, value: { ...state.value, ...patch } };
}

/** Keep the observed snapshot until the parent catches up with this save. */
export function acceptProxyDraft(state: ProxyDraft, submitted: HttpProxy): ProxyDraft {
  const saved = normalizeHttpProxy(submitted);
  return { ...state, value: saved, saved };
}
