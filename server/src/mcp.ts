// Restu as an MCP server (stdio): any MCP-capable agent (Claude Code, Claude Desktop,
// your own) can ask the wearer for permission before it acts.
//
//   claude mcp add restu -e RESTU_URL=http://localhost:8787 -e RESTU_AGENT_KEY=... \
//     -- node --experimental-strip-types --no-warnings /path/to/restu/server/src/mcp.ts
//
// Hand-rolled JSON-RPC (newline-delimited) to keep zero extra dependencies.
import { createInterface } from 'node:readline'

const URL_BASE = process.env.RESTU_URL ?? 'http://localhost:8787'
const KEY = process.env.RESTU_AGENT_KEY ?? ''

const TOOLS = [
  {
    name: 'request_approval',
    description:
      'Ask the human (on their smart glasses) to approve an action before you do it. Small, low-risk actions may be auto-approved by their policy. ' +
      'Waits up to wait_seconds for a decision and returns status: done | scheduled | pending | denied | undone | failed. Only proceed if the status is done or scheduled.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'payload'],
      properties: {
        kind: { type: 'string', enum: ['telegram_message', 'ton_transfer', 'calendar_change', 'generic'] },
        title: { type: 'string', description: 'Short title shown on the glasses, e.g. "Pay Acme invoice #41"' },
        payload: {
          type: 'object',
          description: 'telegram_message: {to, text}; ton_transfer: {to, address, amount, memo?}; calendar_change: {eventTitle, change, attendees}',
        },
        wait_seconds: { type: 'number', description: 'How long to wait for the human (default 60, max 300)' },
      },
    },
  },
  {
    name: 'check_request',
    description: 'Get the current status and result of a request you filed earlier.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
  },
]

async function restu(path: string, init: RequestInit = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  })
  const body = await res.json() as Record<string, any>
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

async function callTool(name: string, args: Record<string, any>) {
  if (name === 'check_request') return restu(`/v1/requests/${encodeURIComponent(args.id)}`)
  if (name !== 'request_approval') throw new Error(`unknown tool ${name}`)
  const created = await restu('/v1/requests', { method: 'POST', body: JSON.stringify({ kind: args.kind, title: args.title, payload: args.payload }) })
  const deadline = Date.now() + Math.min(Number(args.wait_seconds ?? 60), 300) * 1000
  let last = created
  while (Date.now() < deadline && ['pending'].includes(String(last.status))) {
    await new Promise(r => setTimeout(r, 2000))
    last = await restu(`/v1/requests/${created.id}`)
  }
  return { ...last, reasons: created.reasons, note: last.status === 'pending' ? 'Still waiting for the human. Call check_request later.' : undefined }
}

const out = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`)

createInterface({ input: process.stdin }).on('line', async line => {
  if (!line.trim()) return
  let msg: any
  try { msg = JSON.parse(line) } catch { return }
  const reply = (result: unknown) => out({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (message: string) => out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message } })
  try {
    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'restu', version: '0.1.0' } })
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call': {
        try {
          const result = await callTool(msg.params.name, msg.params.arguments ?? {})
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] })
        } catch (e) {
          return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true })
        }
      }
      case 'ping':
        return reply({})
      default:
        if (msg.id !== undefined) fail(`method not found: ${msg.method}`) // notifications have no id
    }
  } catch (e) {
    fail((e as Error).message)
  }
})
