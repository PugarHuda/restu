// node:sqlite (built into Node 22.13+): no native build step, one file on disk.
import { DatabaseSync } from 'node:sqlite'
import type { ApprovalRequest, Contact, Rules } from './types.ts'
import { DEFAULT_RULES } from './types.ts'

export type Db = ReturnType<typeof openDb>
export const PAIR_CODE_TTL_MS = 10 * 60_000

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists requests (id text primary key, data text not null, status text not null, created_at integer not null);
    create table if not exists audit (id integer primary key autoincrement, at integer not null, request_id text, agent_id text, event text not null, detail text);
    create table if not exists contacts (username text primary key, data text not null);
    create table if not exists payments (id integer primary key autoincrement, username text, address text not null, amount real not null, at integer not null);
    create table if not exists kv (k text primary key, v text not null);
    create table if not exists devices (token text primary key, code text, chat_id integer, created_at integer not null);
    create unique index if not exists devices_code on devices (code) where code is not null;
  `)

  const q = {
    putReq: db.prepare('insert into requests (id, data, status, created_at) values (?, ?, ?, ?) on conflict(id) do update set data = excluded.data, status = excluded.status'),
    getReq: db.prepare('select data from requests where id = ?'),
    byStatus: db.prepare('select data from requests where status = ? order by created_at'),
    recent: db.prepare('select data from requests where created_at >= ? order by created_at desc'),
    audit: db.prepare('insert into audit (at, request_id, agent_id, event, detail) values (?, ?, ?, ?, ?)'),
    auditList: db.prepare('select at, request_id as requestId, agent_id as agentId, event, detail from audit order by id desc limit ?'),
    putContact: db.prepare('insert into contacts (username, data) values (?, ?) on conflict(username) do update set data = excluded.data'),
    getContact: db.prepare('select data from contacts where username = ?'),
    contacts: db.prepare('select data from contacts'),
    pay: db.prepare('insert into payments (username, address, amount, at) values (?, ?, ?, ?)'),
    paidTo: db.prepare('select address, amount from payments where username = ?'),
    spentSince: db.prepare('select coalesce(sum(amount), 0) as s from payments where at >= ?'),
    getKv: db.prepare('select v from kv where k = ?'),
    putKv: db.prepare('insert into kv (k, v) values (?, ?) on conflict(k) do update set v = excluded.v'),
    putDevice: db.prepare('insert into devices (token, code, chat_id, created_at) values (?, ?, ?, ?) on conflict(token) do update set code = excluded.code, chat_id = excluded.chat_id'),
    deviceByToken: db.prepare('select token, code, chat_id as chatId from devices where token = ?'),
    deviceByCode: db.prepare('select token, code, chat_id as chatId from devices where code = ? and chat_id is null and created_at >= ?'),
    unpairedSince: db.prepare('select count(*) as n from devices where chat_id is null and created_at >= ?'),
    dropStale: db.prepare('delete from devices where chat_id is null and created_at < ?'),
  }

  const parse = <T>(row: unknown): T | null => (row ? JSON.parse((row as { data: string }).data) as T : null)

  return {
    raw: db,
    saveRequest(r: ApprovalRequest) { q.putReq.run(r.id, JSON.stringify(r), r.status, r.createdAt) },
    getRequest(id: string) { return parse<ApprovalRequest>(q.getReq.get(id)) },
    requestsByStatus(status: string) { return q.byStatus.all(status).map(r => parse<ApprovalRequest>(r)!) },
    requestsSince(ts: number) { return q.recent.all(ts).map(r => parse<ApprovalRequest>(r)!) },

    audit(event: string, requestId: string | null, agentId: string | null, detail = '') {
      q.audit.run(Date.now(), requestId, agentId, event, detail)
    },
    auditList(limit = 20) {
      return q.auditList.all(limit) as { at: number; requestId: string | null; agentId: string | null; event: string; detail: string }[]
    },

    saveContact(c: Contact) { q.putContact.run(c.username.toLowerCase(), JSON.stringify(c)) },
    getContact(username: string) { return parse<Contact>(q.getContact.get(username.replace(/^@/, '').toLowerCase())) },
    contacts() { return q.contacts.all().map(r => parse<Contact>(r)!) },

    recordPayment(username: string, address: string, amount: number) { q.pay.run(username.toLowerCase(), address, amount, Date.now()) },
    paidTo(username: string) { return q.paidTo.all(username.replace(/^@/, '').toLowerCase()) as { address: string; amount: number }[] },
    spentSince(ts: number) { return (q.spentSince.get(ts) as { s: number }).s },

    get(k: string) { return (q.getKv.get(k) as { v: string } | undefined)?.v ?? null },
    set(k: string, v: string) { q.putKv.run(k, v) },
    rules(): Rules { const v = this.get('rules'); return v ? { ...DEFAULT_RULES, ...JSON.parse(v) } : DEFAULT_RULES },

    saveDevice(token: string, code: string | null, chatId: number | null) { q.putDevice.run(token, code, chatId, Date.now()) },
    deviceByToken(token: string) { return q.deviceByToken.get(token) as { token: string; code: string | null; chatId: number | null } | undefined },
    deviceByCode(code: string) {
      return q.deviceByCode.get(code, Date.now() - PAIR_CODE_TTL_MS) as { token: string; code: string | null; chatId: number | null } | undefined
    },
    // Creates an unpaired device with a fresh, unique 6-digit code. Caps how many can wait at once.
    newDevice(token: string, code: () => string, autoPaired: boolean): string | null {
      q.dropStale.run(Date.now() - PAIR_CODE_TTL_MS)
      if (!autoPaired && (q.unpairedSince.get(Date.now() - PAIR_CODE_TTL_MS) as { n: number }).n >= 20) return null
      for (let i = 0; i < 10; i++) {
        const c = code()
        try { q.putDevice.run(token, autoPaired ? null : c, autoPaired ? 0 : null, Date.now()); return c } catch { /* code collision, retry */ }
      }
      return null
    },
  }
}
