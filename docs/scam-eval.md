# Restu anti-scam evaluation

200 labelled payment scenarios (125 scams, 75 legitimate), run through the real `checkTransfer` + policy (default rules). Look-alike addresses are ground for real (same visible prefix and suffix).

| Scenario | n | held | asked | auto-sent |
|---|---:|---:|---:|---:|
| legit: pay their wallet card | 25 | 0 | 10 | 15 |
| legit: repeat payee | 25 | 0 | 10 | 15 |
| legit: owner-verified address (no card) | 25 | 0 | 10 | 15 |
| scam: poisoned look-alike of the card | 25 | 25 | 0 | 0 |
| scam: swapped address (invoice tampering) | 25 | 25 | 0 | 0 |
| scam: impersonator (unknown recipient) | 25 | 25 | 0 | 0 |
| scam: reported address | 25 | 25 | 0 | 0 |
| scam: poisoned twin of a past payee (no card) | 25 | 25 | 0 | 0 |

- **Scams held (cannot be approved by tap): 125/125 = 100.0%**
- Scams that would auto-send: 0/125
- **Legit payments wrongly held: 0/75 = 0.0%**
- Legit payments that ran on their own or asked once: 75/75

**Limits (read before quoting the numbers):** the scenarios are synthetic and cover the attack families Restu's checks were written for. They do not cover a compromised Telegram account (the wallet card itself is attacker-controlled), a contact who is the scammer, or social engineering that convinces the owner to verify a bad address. "Asked" legit payments are the policy working as designed (above the auto limit or the agent's daily budget), not false alarms.

Generated 2026-11-27T08:41:12.062Z by `server/eval/scam-eval.ts`.
