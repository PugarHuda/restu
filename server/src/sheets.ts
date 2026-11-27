// ASK: "Your numbers, mid-meeting."
// Deterministic lookup over live Google Sheets (or a local CSV): the answer is a
// real cell with its address. No matching cell means no answer; nothing is generated.

export interface Grid { tab: string; rows: string[][]; source?: string }
export interface Answer { value: string; label: string; ref: string; source: string; fetchedAt: number }

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'what', 'whats', 'is', 'our', 'my', 'in', 'on', 'to', 'how', 'much', 'many', 'and', 'berapa', 'yang', 'di'])
const SYNONYMS: Record<string, string[]> = {
  rev: ['revenue'], revenue: ['rev', 'sales'], arr: ['annual', 'recurring'], mrr: ['monthly', 'recurring'],
  renewal: ['renew', 'contract'], value: ['amount', 'deal'], churn: ['churned'], cac: ['acquisition'],
  q1: ['q1'], q2: ['q2'], q3: ['q3'], q4: ['q4'], users: ['customers', 'accounts'], customers: ['users', 'accounts'],
}

export function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').split(' ').filter(w => w && !STOP.has(w))
}

function expand(ws: string[]): Set<string> {
  const out = new Set(ws)
  for (const w of ws) for (const s of SYNONYMS[w] ?? []) out.add(s)
  return out
}

const overlap = (q: Set<string>, text: string) => words(text).filter(w => q.has(w)).length

export function colLetter(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

// Tables are read as: row 0 = column headers, column A = row labels.
// Works for matrices ("Deals" by company × field) and key/value sheets ("Metric | Value").
export function lookup(grids: Grid[], query: string, context: string[] = []): Omit<Answer, 'source' | 'fetchedAt'> | null {
  const q = expand(words(query))
  const ctx = new Set(context.flatMap(words))
  type Hit = { score: number; value: string; label: string; ref: string }
  let best = null as Hit | null

  const asked = words(query)
  for (const g of grids) {
    const [header = [], ...body] = g.rows
    const tabHit = overlap(q, g.tab)
    const keyValue = header.length === 2
    body.forEach((row, ri) => {
      const rowHit = overlap(q, row[0] ?? '')
      const ctxHit = overlap(ctx, row[0] ?? '')
      for (let c = 1; c < row.length; c++) {
        const value = (row[c] ?? '').trim()
        if (!value) continue
        // In a key/value sheet the "Value" header says nothing; the row label must carry the question.
        const colText = keyValue ? '' : header[c] ?? ''
        const colHit = overlap(q, colText)
        // Every word asked must be explained by this cell's row label, column header or tab,
        // so "renewal value" never lands on "Average deal size".
        const where = new Set(words(`${row[0] ?? ''} ${colText} ${g.tab}`))
        const covered = asked.every(w => where.has(w) || [...(SYNONYMS[w] ?? [])].some(s => where.has(s)))
        // The row must be identified: by the question, by the current meeting, or by being the only row.
        const rowKnown = rowHit > 0 || ctxHit > 0 || body.length === 1
        const matched = covered && rowKnown && (keyValue ? rowHit > 0 : colHit > 0)
        if (!matched) continue
        const score = colHit * 3 + rowHit * 3 + ctxHit * 2 + tabHit
        if (!best || score > best.score) {
          best = {
            score, value,
            label: [row[0], keyValue ? '' : header[c]].filter(Boolean).join(' · '),
            ref: `${g.tab}!${colLetter(c)}${ri + 2}`,
          }
        }
      }
    })
  }
  const b = best as Hit | null
  return b && { value: b.value, label: b.label, ref: b.ref }
}

export function parseCsv(text: string): string[][] {
  // ponytail: no quoted-newline support; good enough for metric tables
  return text.trim().split(/\r?\n/).map(line => {
    const out: string[] = []
    let cur = '', quoted = false
    for (const ch of line) {
      if (ch === '"') quoted = !quoted
      else if (ch === ',' && !quoted) { out.push(cur); cur = '' }
      else cur += ch
    }
    out.push(cur)
    return out.map(s => s.trim())
  })
}

export interface SheetsConfig {
  sheetId?: string
  apiKey?: string                         // for sheets shared "anyone with the link"
  oauth?: { clientId: string; clientSecret: string; refreshToken: string }
  localFiles?: { tab: string; path: string }[]
  // Link-shared Google Sheets read without any key (CSV export), one tab each.
  publicSheets?: { tab: string; id: string }[]
}

export function createSheets(cfg: SheetsConfig, readFile: (p: string) => Promise<string>) {
  let cache: { at: number; grids: Grid[]; source: string } | null = null
  let token: { value: string; exp: number } | null = null

  async function accessToken(): Promise<string | null> {
    if (!cfg.oauth) return null
    if (token && token.exp > Date.now() + 60_000) return token.value
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: cfg.oauth.clientId, client_secret: cfg.oauth.clientSecret,
        refresh_token: cfg.oauth.refreshToken, grant_type: 'refresh_token',
      }),
    })
    const j = await res.json() as { access_token?: string; expires_in?: number; error?: string }
    if (!j.access_token) throw new Error(`google oauth: ${j.error}`)
    token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 }
    return token.value
  }

  async function google(path: string) {
    const bearer = await accessToken()
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}${path}`)
    if (!bearer && cfg.apiKey) url.searchParams.set('key', cfg.apiKey)
    const res = await fetch(url, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} })
    if (!res.ok) throw new Error(`sheets ${res.status}: ${(await res.text()).slice(0, 120)}`)
    return res.json() as Promise<any>
  }

  async function load(): Promise<{ grids: Grid[]; source: string; at: number }> {
    if (cache && Date.now() - cache.at < 60_000) return cache
    if (cfg.sheetId && (cfg.apiKey || cfg.oauth)) {
      const meta = await google('?fields=properties.title,sheets.properties.title')
      const tabs: string[] = meta.sheets.map((s: any) => s.properties.title)
      const ranges = tabs.map(t => `ranges=${encodeURIComponent(`'${t}'`)}`).join('&')
      const data = await google(`/values:batchGet?${ranges}`)
      const grids = data.valueRanges.map((v: any, i: number) => ({ tab: tabs[i], rows: (v.values ?? []) as string[][] }))
      cache = { at: Date.now(), grids, source: `Google Sheet "${meta.properties.title}"` }
      return cache
    }
    const grids: Grid[] = []
    for (const sheet of cfg.publicSheets ?? []) {
      try {
        const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheet.id}/export?format=csv`, { redirect: 'follow' })
        const text = await res.text()
        if (!res.ok || text.trimStart().startsWith('<')) throw new Error(`HTTP ${res.status}`)
        grids.push({ tab: sheet.tab, rows: parseCsv(text), source: 'Google Sheet (live)' })
      } catch (e) {
        console.warn(`[sheets] ${sheet.tab}: live sheet unavailable (${(e as Error).message}), using sample CSV`)
      }
    }
    for (const f of cfg.localFiles ?? []) {
      if (grids.some(g => g.tab === f.tab)) continue
      grids.push({ tab: f.tab, rows: parseCsv(await readFile(f.path)), source: 'sample CSV' })
    }
    cache = { at: Date.now(), grids, source: 'sample CSV' }
    return cache
  }

  return {
    async ask(query: string, context: string[] = []): Promise<Answer | null> {
      const { grids, source, at } = await load()
      const hit = lookup(grids, query, context)
      if (!hit) return null
      const tab = hit.ref.split('!')[0]
      return { ...hit, source: grids.find(g => g.tab === tab)?.source ?? source, fetchedAt: at }
    },
  }
}
