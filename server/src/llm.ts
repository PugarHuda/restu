// Claude does two small jobs: draft a follow-up, and turn a spoken correction into a patch.
// Both have deterministic fallbacks so the app works without an API key.
import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-opus-5-5'

export function createLlm(apiKey: string | undefined) {
  const client = apiKey ? new Anthropic({ apiKey }) : null

  async function text(system: string, user: string, maxTokens = 400): Promise<string | null> {
    if (!client) return null
    try {
      const res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system,
        messages: [{ role: 'user', content: user }],
      } as any) as Anthropic.Beta.BetaMessage
      if (res.stop_reason === 'refusal') return null
      const out = res.content.filter(b => b.type === 'text').map(b => (b as Anthropic.Beta.BetaTextBlock).text).join('').trim()
      return out || null
    } catch (e) {
      if (e instanceof Anthropic.APIError) console.error(`[llm] ${e.status} ${e.message}`)
      else console.error('[llm]', (e as Error).message)
      return null
    }
  }

  return {
    enabled: Boolean(client),

    async draftFollowup(input: { meeting: string; person: string; facts: string[] }): Promise<string> {
      const draft = await text(
        'You write short Telegram follow-ups after business meetings. Plain text, at most 2 sentences, no greeting line, no emoji, no links, no placeholders. Use only the facts given.',
        `Meeting: ${input.meeting}\nTo: ${input.person}\nFacts:\n${input.facts.map(f => `- ${f}`).join('\n') || '- (none)'}\nWrite the message.`,
        200,
      )
      return draft ?? `Thanks for today, ${input.person}. ${input.facts[0] ? `Confirming ${input.facts[0]}. ` : ''}I'll send the updated contract tonight.`
    },

    // "make it 20" → {amount: 20}; "add: contract tonight" → {appendText: "contract tonight"}
    async parseCorrection(spoken: string, kind: string): Promise<{ amount?: number; text?: string; appendText?: string; change?: string } | null> {
      const raw = await text(
        'Convert a spoken correction to a pending action into JSON with optional keys: "amount" (number, for payments), "text" (full replacement message), "appendText" (text to append to a message), "change" (new description of a calendar change). Use only keys that fit the action kind. Reply with JSON only.',
        `Action kind: ${kind}\nCorrection: ${spoken}`,
        150,
      )
      if (raw) {
        try { return JSON.parse(raw.replace(/^```(json)?|```$/g, '').trim()) } catch { /* fall through */ }
      }
      if (kind === 'calendar_change') return { change: spoken }
      const n = spoken.match(/(\d+(?:[.,]\d+)?)/)
      if (kind === 'ton_transfer' && n) return { amount: Number(n[1].replace(',', '.')) }
      const add = spoken.match(/^(?:add|tambah(?:kan)?)[:\s]+(.+)/i)
      if (add) return { appendText: add[1] }
      return kind === 'telegram_message' ? { text: spoken } : null
    },
  }
}
