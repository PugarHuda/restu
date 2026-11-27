// Meeting context from a calendar's secret iCal (ICS) URL: no OAuth needed.
// The current meeting scopes ASK ("renewal" during the Acme call means Acme's row).

export interface Meeting { title: string; start: number; end: number; attendees: string[] }

function icsDate(v: string): number {
  // 20261128T093000Z | 20261128T093000 | 20261128
  const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/)
  if (!m) return NaN
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m
  const args = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const
  return z ? Date.UTC(...args) : new Date(...args).getTime()
}

export function parseIcs(text: string): Meeting[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const out: Meeting[] = []
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0]
    const field = (name: string) => body.match(new RegExp(`^${name}[^:\\n]*:(.*)$`, 'm'))?.[1]?.trim() ?? ''
    const attendees = [...body.matchAll(/^ATTENDEE([^:\n]*):(.*)$/gm)].map(([, params, value]) => {
      const cn = params.match(/CN="?([^";]+)"?/)?.[1]
      const email = value.replace(/^mailto:/i, '')
      return cn ? `${cn} <${email}>` : email
    })
    // ponytail: RRULE not expanded; recurring meetings only show their first instance
    out.push({ title: field('SUMMARY').replace(/\\,/g, ','), start: icsDate(field('DTSTART')), end: icsDate(field('DTEND')), attendees })
  }
  return out.filter(m => !Number.isNaN(m.start))
}

// Current meeting, else the next one starting within 30 minutes.
export function relevantMeeting(meetings: Meeting[], now: number): Meeting | null {
  const current = meetings.find(m => m.start <= now && now < m.end)
  if (current) return current
  const soon = meetings.filter(m => m.start > now && m.start - now < 30 * 60_000).sort((a, b) => a.start - b.start)
  return soon[0] ?? null
}

// Words that identify who the meeting is with: title words + company from email domains.
export function contextTerms(m: Meeting | null): string[] {
  if (!m) return []
  const domains = m.attendees.map(a => a.match(/@([a-z0-9-]+)\./i)?.[1] ?? '').filter(d => d && !/gmail|outlook|yahoo|icloud|hotmail/i.test(d))
  return [m.title, ...domains]
}

export function createCalendar(icsUrl: string | undefined, demo: boolean) {
  let cache: { at: number; meetings: Meeting[] } | null = null
  return {
    async current(now = Date.now()): Promise<Meeting | null> {
      if (icsUrl) {
        if (!cache || now - cache.at > 5 * 60_000) {
          const res = await fetch(icsUrl)
          cache = { at: now, meetings: res.ok ? parseIcs(await res.text()) : [] }
        }
        return relevantMeeting(cache.meetings, now)
      }
      if (!demo) return null
      // Demo meeting so the simulator flow works without a calendar.
      const start = now - 5 * 60_000
      return { title: 'Acme renewal', start, end: start + 30 * 60_000, attendees: ['Omar <omar@acme.com>'] }
    },
  }
}
