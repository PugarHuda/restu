// Executor for ton_transfer: the agent's own TESTNET wallet, spending under Restu's policy.
// Testnet only by construction (fixed endpoint); the hackathon forbids real funds.
import { TonClient, WalletContractV4, internal, toNano, Address } from '@ton/ton'
import { mnemonicToPrivateKey } from '@ton/crypto'
import type { ApprovalRequest, TonTransferPayload } from './types.ts'

const TESTNET = 'https://testnet.toncenter.com/api/v2/jsonRPC'
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

// Toncenter allows ~1 request/second without an API key and answers 429 above that.
// ponytail: plain exponential backoff; set TONCENTER_API_KEY for higher limits.
export async function retry429<T>(fn: () => Promise<T>, tries = 7, baseMs = 1200): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      if (i >= tries - 1 || !/429|rate limit|too many/i.test(msg)) throw e
      await sleep(baseMs * 2 ** i)
    }
  }
}

export async function createTonSender(mnemonic: string, apiKey?: string) {
  const key = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/))
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey })
  const client = new TonClient({ endpoint: TESTNET, apiKey })
  const contract = client.open(wallet)
  const self = wallet.address.toString({ testOnly: true, bounceable: false })
  let chain: Promise<unknown> = Promise.resolve() // one transfer at a time: seqno is sequential

  async function transfer(r: ApprovalRequest): Promise<string> {
    const p = r.payload as TonTransferPayload
    const to = Address.parse(p.address)
    const seqno = await retry429(() => contract.getSeqno())
    await retry429(() => contract.sendTransfer({
      seqno,
      secretKey: key.secretKey,
      messages: [internal({ to, value: toNano(String(p.amount)), bounce: false, body: p.memo ?? `Restu ${r.id}` })],
    }))
    // wait for the wallet seqno to move so we only report what the chain accepted
    for (let i = 0; i < 25; i++) {
      await sleep(2000)
      if ((await retry429(() => contract.getSeqno()).catch(() => seqno)) > seqno) {
        return `${p.amount} GRAM sent on TON testnet · https://testnet.tonviewer.com/${self}`
      }
    }
    throw new Error('transfer not confirmed within 50s (check the testnet explorer)')
  }

  return {
    address: self,
    async balance() { return Number(await retry429(() => contract.getBalance())) / 1e9 },
    send(r: ApprovalRequest): Promise<string> {
      const run = chain.then(() => transfer(r))
      chain = run.catch(() => {})
      return run
    },
  }
}
