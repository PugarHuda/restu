// Shared shapes. Plain types only (Node strips them at runtime).

export type ActionKind = 'telegram_message' | 'ton_transfer' | 'calendar_change' | 'generic'

export type Verdict = 'auto' | 'ask' | 'hold' | 'deny'
export type Risk = 'low' | 'medium' | 'high'

export type Status =
  | 'pending'    // waiting for the wearer (verdict ask/hold)
  | 'scheduled'  // approved or auto; sits in the undo window
  | 'done'
  | 'failed'
  | 'denied'
  | 'undone'
  | 'expired'

export interface TelegramMessagePayload {
  to: string          // @username or numeric chat id
  text: string
}

export interface TonTransferPayload {
  to: string          // recipient @username (the person)
  address: string     // TON address the agent wants to pay
  amount: number      // in GRAM (TON testnet)
  memo?: string
}

export interface CalendarChangePayload {
  eventTitle: string
  change: string      // human readable: "move to Fri 10:00", "cancel"
  attendees: number
}

export type Payload = TelegramMessagePayload | TonTransferPayload | CalendarChangePayload | Record<string, unknown>

export interface Finding {
  code: string        // CARD_MISMATCH, LOOKALIKE, FIRST_TIME, ...
  severity: Risk
  message: string     // short, fits one glasses line
}

export interface ApprovalRequest {
  id: string
  agentId: string
  kind: ActionKind
  title: string
  payload: Payload
  version: number     // bumps when the payload is corrected; old intents die
  status: Status
  verdict: Verdict
  risk: Risk
  reasons: string[]
  findings: Finding[]
  createdAt: number
  executeAt: number | null
  result: string | null
  scheduledAt?: number // when it entered the undo window (undo targets the latest)
  laterAt?: number    // wearer swiped "later": sort to the back of the queue
  wasHeld?: boolean   // a scam check held it at some point (counts as "blocked")
}

export interface Contact {
  username: string           // without @
  userId: number | null
  chatId: number | null
  cardAddress: string | null // ton_wallet_card.address from getChat (Bot API 10.4)
  knownAddresses: string[]   // addresses this user verified some other way
}

export interface Rules {
  autoTransferMax: number      // GRAM; at or below → may auto-approve
  dailyTransferCap: number     // GRAM per day across all agents
  autoTelegramToKnown: boolean // replies to known contacts go without asking
  calendarAskAttendees: number // ask when a change touches this many people
  undoSeconds: { telegram_message: number; ton_transfer: number; calendar_change: number; generic: number }
  trustedAgents: string[]      // unknown agents are denied outright
}

export const DEFAULT_RULES: Rules = {
  autoTransferMax: 10,
  dailyTransferCap: 100,
  autoTelegramToKnown: true,
  calendarAskAttendees: 3,
  undoSeconds: { telegram_message: 10, ton_transfer: 30, calendar_change: 10, generic: 10 },
  trustedAgents: ['followup-agent', 'invoice-agent', 'calendar-agent'],
}
