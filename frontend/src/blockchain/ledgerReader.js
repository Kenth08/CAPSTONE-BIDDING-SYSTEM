// Read-only ledger access in the shape packetVerify.js expects. Takes the
// provider, address and ABI as arguments (no Vite env), so the exact same code
// runs in the browser and in a Node script against real Sepolia.
import { Contract } from 'ethers'

const shapeRow = (row) => ({
  entityType: row[0],
  entityRef: row[1],
  stage: row[2],
  dataHash: row[3],
  actor: row[4],
  timestamp: Number(row[5]),      // seconds, as stored by the contract
})

// A contract revert ("ProcurementLedger: unknown anchor") means the id does not
// exist; anything else (timeout, rate limit, bad URL) means "could not ask".
const isRevert = (err) => err?.code === 'CALL_EXCEPTION'

export function makeLedgerReader(provider, address, abi) {
  const ledger = new Contract(address, abi, provider)
  return {
    chainId: () => provider.send('eth_chainId', []),

    async getAnchor(id) {
      try {
        return shapeRow(await ledger.getAnchor(id))
      } catch (err) {
        if (isRevert(err)) return null
        throw err
      }
    },

    async findAnchors(entityRef) {
      const ids = await ledger.getAnchorIds(entityRef)
      return Promise.all(ids.map(async (id) => ({ id: Number(id), ...shapeRow(await ledger.getAnchor(id)) })))
    },

    /** null when the node doesn't have the receipt (pending, or pruned history). */
    async getReceipt(txHash) {
      const r = await provider.getTransactionReceipt(txHash)
      if (!r) return null
      const events = []
      for (const log of r.logs) {
        // Only logs emitted BY the ledger: anyone can deploy a look-alike.
        if (log.address.toLowerCase() !== address.toLowerCase()) continue
        let parsed = null
        try { parsed = ledger.interface.parseLog(log) } catch { /* not ours */ }
        if (parsed?.name !== 'AnchorRecorded') continue
        events.push({
          id: Number(parsed.args.id),
          logIndex: log.index,
          entityType: parsed.args.entityType,
          entityRef: parsed.args.entityRef,
          stage: parsed.args.stage,
          dataHash: parsed.args.dataHash,
        })
      }
      return { status: r.status, events }
    },
  }
}
