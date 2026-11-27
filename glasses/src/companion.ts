// The phone-side page inside the Even app WebView. The glasses are the main UI;
// this mirrors them and offers typed input when speaking is not an option.
import type { GlassView } from './api'

interface Hooks {
  view: () => GlassView | null
  ask: (text: string) => Promise<string>
  correct: (text: string) => Promise<string>
  demo: () => Promise<string>
  tap: () => void
  swipeUp: () => void
  swipeDown: () => void
  nod: { get: () => boolean; set: (on: boolean) => Promise<void> }
}

export function mountCompanion(root: HTMLElement, h: Hooks) {
  root.innerHTML = `
    <main>
      <h1><img src="/logo.png" alt="" width="36" height="36" style="vertical-align:-8px;margin-right:8px">Restu</h1>
      <p class="sub">Your agents ask. Your glasses decide.</p>
      <pre id="mirror" aria-live="polite"></pre>
      <div class="row">
        <button id="up">▲ undo / later</button>
        <button id="tap">Tap</button>
        <button id="down">▼ deny</button>
      </div>
      <form id="askForm"><input id="ask" placeholder='Ask a number: "renewal value"' autocomplete="off"><button>Ask</button></form>
      <form id="editForm"><input id="edit" placeholder='Edit the card: "make it 20"' autocomplete="off"><button>Edit</button></form>
      <p id="out" class="sub"></p>
      <label class="toggle"><input type="checkbox" id="nod"> Nod to approve (experimental: a nod approves a normal card; held payments never)</label>
      <button id="demo" class="ghost">Load Acme demo</button>
    </main>`
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  const out = $('out')
  const show = (p: Promise<string>) => p.then(t => (out.textContent = t)).catch(e => (out.textContent = e.message))

  $('tap').onclick = h.tap
  $('up').onclick = h.swipeUp
  $('down').onclick = h.swipeDown
  $('demo').onclick = () => show(h.demo())
  const nodBox = $<HTMLInputElement>('nod')
  nodBox.checked = h.nod.get()
  nodBox.onchange = () => { h.nod.set(nodBox.checked).then(() => (out.textContent = nodBox.checked ? 'Nod to approve: on' : 'Nod to approve: off')) }
  $<HTMLFormElement>('askForm').onsubmit = e => { e.preventDefault(); const i = $<HTMLInputElement>('ask'); show(h.ask(i.value)); i.value = '' }
  $<HTMLFormElement>('editForm').onsubmit = e => { e.preventDefault(); const i = $<HTMLInputElement>('edit'); show(h.correct(i.value)); i.value = '' }

  setInterval(() => {
    const v = h.view()
    $('mirror').textContent = v ? `${v.header}\n─────────────\n${v.body}\n─────────────\n${v.footer}` : 'Connecting...'
  }, 500)
}
