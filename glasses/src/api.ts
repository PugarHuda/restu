// Restu server client. The base URL must be listed in app.json network.whitelist.
export const API_BASE: string = (import.meta as any).env?.VITE_RESTU_API ?? 'http://localhost:8787'

export interface GlassView {
  screen: 'pair' | 'home' | 'card'
  header: string
  body: string
  footer: string
  card?: { id: string; intent: string; hold: boolean; fixable: boolean }
  undo?: { id: string; secondsLeft: number }
  toast?: string
}

let token = ''

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-device': token, ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok && res.status !== 409) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body as T
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  setToken(t: string) { token = t },
  pairStart: () => post<{ token: string; code: string }>('/v1/pair/start', {}),
  state: () => call<GlassView>('/v1/glass/state'),
  action: (action: string, id: string, intent?: string) => post<{ ok: boolean; reason?: string }>('/v1/glass/action', { action, id, intent }),
  ask: (text: string) => post<{ ok: boolean; text: string }>('/v1/glass/ask', { text }),
  correct: (id: string, text: string) => post<{ ok: boolean; reason?: string }>('/v1/glass/correct', { id, text }),
  demo: () => post<{ text: string }>('/v1/demo/acme', {}),
  voice: (pcm: Uint8Array, mode: 'ask' | 'correct', id?: string) =>
    call<{ text: string; heard?: string; ok?: boolean }>(`/v1/glass/voice?mode=${mode}${id ? `&id=${id}` : ''}`, {
      method: 'POST', body: pcm as BodyInit, headers: { 'content-type': 'application/octet-stream' },
    }),
}
