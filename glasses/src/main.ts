// Restu on Even G2: a thin renderer. The server decides what each line says;
// this file draws three text boxes and turns gestures into actions.
import {
  waitForEvenAppBridge, TextContainerProperty, CreateStartUpPageContainer, TextContainerUpgrade,
  OsEventTypeList, AudioInputSource,
} from '@evenrealities/even_hub_sdk'
import { api, type GlassView } from './api'
import { mountCompanion } from './companion'

const bridge = await waitForEvenAppBridge()

// ---- device token (pairing) -------------------------------------------------
async function deviceToken(): Promise<string> {
  const saved = await bridge.getLocalStorage('restu_token').catch(() => '')
  if (saved) return saved
  const { token } = await api.pairStart()
  await bridge.setLocalStorage('restu_token', token)
  return token
}
api.setToken(await deviceToken())

// ---- layout: 576 x 288, three boxes ------------------------------------------
const BOX = {
  header: { id: 1, name: 'header', y: 0, h: 36, color: 3 },
  body: { id: 2, name: 'body', y: 36, h: 216, color: 4 },
  footer: { id: 3, name: 'footer', y: 252, h: 36, color: 2 },
} as const
type BoxName = keyof typeof BOX

const shown: Record<BoxName, string> = { header: '', body: '', footer: '' }

await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 3,
  textObject: (Object.keys(BOX) as BoxName[]).map(k => new TextContainerProperty({
    xPosition: 0, yPosition: BOX[k].y, width: 576, height: BOX[k].h,
    borderWidth: k === 'body' ? 1 : 0, borderColor: 6, borderRadius: 6, paddingLength: 6,
    containerID: BOX[k].id, containerName: BOX[k].name, textColor: BOX[k].color,
    content: k === 'body' ? 'Restu is starting...' : ' ',
    isEventCapture: k === 'body' ? 1 : 0,
  })),
}))

function draw(k: BoxName, text: string) {
  const content = text || ' '
  if (shown[k] === content) return
  shown[k] = content
  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: BOX[k].id, containerName: BOX[k].name, content }))
}

// ---- state ---------------------------------------------------------------------
let view: GlassView | null = null
let toast: { text: string; until: number } | null = null
let recording: Uint8Array[] | null = null

function render() {
  if (!view) return
  draw('header', view.header)
  if (recording) draw('body', '● Listening...\n\nRelease to send')
  else if (toast && toast.until > Date.now()) draw('body', toast.text)
  else if (view.toast) draw('body', view.toast)
  else draw('body', view.body)
  draw('footer', view.footer)
}

function say(text: string, ms = 6000) { toast = { text, until: Date.now() + ms }; render() }

async function refresh() {
  try { view = await api.state() } catch (e) {
    // The server forgot this device (reset or expired code): get a fresh pairing code.
    if ((e as Error).message.startsWith('unknown device')) {
      await bridge.setLocalStorage('restu_token', '')
      api.setToken(await deviceToken())
      return refresh()
    }
    view = { screen: 'home', header: 'RESTU  offline', body: `Cannot reach the Restu server.\n${(e as Error).message}`, footer: 'Retrying...' }
  }
  render()
}
setInterval(refresh, 1500)
refresh()

// ---- gestures --------------------------------------------------------------------
async function act(action: 'approve' | 'deny' | 'later' | 'fix' | 'undo', id: string, intent?: string) {
  const res = await api.action(action, id, intent).catch(e => ({ ok: false, reason: (e as Error).message }))
  const done: Record<string, string> = {
    approve: 'Approved. Swipe ▲ within the timer to undo.',
    fix: 'Paying their verified wallet card instead.\nSwipe ▲ within the timer to undo.',
    deny: 'Denied.', later: 'Moved to the back.', undo: 'Undone. Nothing was sent.',
  }
  say(res.ok ? done[action] : `Not done: ${res.reason}`, 2500)
  await refresh()
}

function onTap() {
  const c = view?.card
  if (!c) return
  if (c.hold) return c.fixable ? act('fix', c.id, c.intent) : say('Held for review.\nOpen Telegram to look closer.', 3000)
  act('approve', c.id, c.intent)
}
function onSwipeDown() { if (view?.card) act('deny', view.card.id) }
function onSwipeUp() {
  if (view?.undo) return act('undo', view.undo.id)
  if (view?.card) act('later', view.card.id)
}

// Long press: talk. On a normal card it edits the request; anywhere else it asks a number.
async function startListening() {
  if (recording) return
  recording = []
  render()
  await bridge.audioControl(true, AudioInputSource.Glasses)
}
async function stopListening() {
  if (!recording) return
  const chunks = recording
  recording = null
  await bridge.audioControl(false)
  const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) { pcm.set(c, o); o += c.length }
  const c = view?.card
  const mode = c && !c.hold ? 'correct' : 'ask'
  say('...', 15000)
  const res = await api.voice(pcm, mode, c?.id).catch(e => ({ text: (e as Error).message, heard: '' }))
  say(res.heard ? `"${res.heard}"\n\n${res.text}` : res.text, 9000)
  refresh()
}

// CLICK_EVENT is 0 and protobuf drops zero values, so a tap arrives with no
// eventType. Resolve the default only inside an envelope that exists.
function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent(event => {
  if (event.audioEvent && recording) { recording.push(event.audioEvent.audioPcm); return }
  const sys = typeOf(event.sysEvent)
  const text = typeOf(event.textEvent)
  const is = (t: OsEventTypeList) => sys === t || text === t

  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) { bridge.shutDownPageContainer(1); return } // Even Hub rule: double-tap exits
  if (is(OsEventTypeList.LONG_PRESS_EVENT)) { startListening(); return }
  if (is(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) { stopListening(); return }
  if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) { onSwipeDown(); return }
  if (is(OsEventTypeList.SCROLL_TOP_EVENT)) { onSwipeUp(); return }
  if (is(OsEventTypeList.CLICK_EVENT)) { onTap(); return }
})

// The phone screen: typed fallback for ask/edit (handy in the simulator) and demo controls.
mountCompanion(document.getElementById('app')!, {
  view: () => view,
  ask: async text => { const r = await api.ask(text); await refresh(); return r.text },
  correct: async text => {
    const c = view?.card
    if (!c) return 'No card to edit'
    const r = await api.correct(c.id, text)
    await refresh()
    return r.ok ? 'Updated' : r.reason ?? 'Not updated'
  },
  demo: async () => { const r = await api.demo(); await refresh(); return r.text },
  tap: onTap, swipeUp: onSwipeUp, swipeDown: onSwipeDown,
})
