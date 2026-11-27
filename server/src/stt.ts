// Speech-to-text for the G2 mic (16 kHz, 16-bit, mono PCM). The SDK has no STT,
// so the server forwards audio to any OpenAI-compatible /audio/transcriptions
// endpoint (Groq, OpenAI, a local whisper server). The key never reaches the glasses.

export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

export function createStt(cfg: { url?: string; key?: string; model?: string }) {
  return {
    enabled: Boolean(cfg.url && cfg.key),
    async transcribe(pcm: Buffer): Promise<string> {
      if (!cfg.url || !cfg.key) throw new Error('speech-to-text not configured (STT_URL, STT_API_KEY)')
      if (pcm.length < 3200) throw new Error('too short, hold a little longer')
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'speech.wav')
      form.append('model', cfg.model ?? 'whisper-large-v3-turbo')
      form.append('response_format', 'json')
      const res = await fetch(cfg.url, { method: 'POST', headers: { authorization: `Bearer ${cfg.key}` }, body: form })
      if (!res.ok) throw new Error(`stt ${res.status}: ${(await res.text()).slice(0, 100)}`)
      return ((await res.json()) as { text?: string }).text?.trim() ?? ''
    },
  }
}
