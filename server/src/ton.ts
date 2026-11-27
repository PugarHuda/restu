// Executor for ton_transfer: the agent's own TESTNET wallet, spending under Restu's policy.
// Testnet only by construction (fixed endpoint); the hackathon forbids real funds.
import { TonClient, WalletContractV4, internal, toNano, Address } from '@ton/ton'
import { mnemonicToPrivateKey } from '@ton/crypto'
import type { ApprovalRequest, TonTransferPayload } from './types.ts'

const TESTNET = 'https://testnet.toncenter.com/api/v2/jsonRPC'

export async function createTonSender(mnemonic: string, apiKey?: string) {
  const key = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/))
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey })
  const client = new TonClient({ endpoint: TESTNET, apiKey })
  const contract = client.open(wallet)
  const self = wallet.address.toString({ testOnly: true, bounceable: false })

  return {
    address: self,
    async balance() { return Number(await contract.getBalance()) / 1e9 },

    async send(r: ApprovalRequest): Promise<string> {
      const p = r.payload as TonTransferPayload
      const to = Address.parse(p.address)
      const seqno = await contract.getSeqno()
      await contract.sendTransfer({
        seqno,
        secretKey: key.secretKey,
        messages: [internal({ to, value: toNano(String(p.amount)), bounce: false, body: p.memo ?? `Restu ${r.id}` })],
      })
      // wait for the wallet seqno to move so we only report what the chain accepted
      for (let i = 0; i < 20; i++) {
        await new Promise(res => setTimeout(res, 1500))
        if ((await contract.getSeqno()) > seqno) {
          return `${p.amount} GRAM sent on TON testnet · https://testnet.tonviewer.com/${self}`
        }
      }
      throw new Error('transfer not confirmed within 30s (check the testnet explorer)')
    },
  }
}
