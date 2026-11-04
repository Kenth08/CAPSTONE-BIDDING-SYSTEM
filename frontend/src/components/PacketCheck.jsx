import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, CircleDashed, Loader2, ShieldCheck, ShieldX, XCircle } from 'lucide-react'

import { packetVerifyContext } from '../blockchain/anchor'
import { verifyPacket } from '../blockchain/packetVerify'
import '../style/packet-check.css'

const TONE = {
  verified: 'ok', hash_mismatch: 'bad', not_found: 'bad', invalid_tx: 'bad', unconfirmed: 'pending',
}
const STEP_ICON = { pass: CheckCircle2, fail: XCircle, skip: CircleDashed }

/**
 * Full independent check of one record: fetches its verification packet via
 * `loadPacket` (null = this viewer has no packet for it) and runs
 * verifyPacket against the ledger from this browser. `fileHash` (optional) is
 * the sha256 of a document the visitor picked; it never leaves the browser.
 */
export default function PacketCheck({ loadPacket, fileHash = null, unavailableText }) {
  const [state, setState] = useState({ phase: 'loading' })

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const packet = await loadPacket()
        if (!live) return
        if (!packet) { setState({ phase: 'unavailable' }); return }
        const result = await verifyPacket(packet, { fileHash, ...packetVerifyContext() })
        if (live) setState({ phase: 'done', result })
      } catch (err) {
        if (live) setState({ phase: 'error', message: err?.message || 'The check could not be run.' })
      }
    })()
    return () => { live = false }
  }, [loadPacket, fileHash])

  if (state.phase === 'loading') {
    return <div className="pc pc-pending"><Loader2 size={15} className="pc-spin" /> Checking against the blockchain…</div>
  }
  if (state.phase === 'unavailable') {
    return <div className="pc pc-pending"><AlertCircle size={15} /> <span>{unavailableText}</span></div>
  }
  if (state.phase === 'error') {
    return (
      <div className="pc pc-pending">
        <AlertCircle size={15} /> <span><strong>UNCONFIRMED</strong> — {state.message}</span>
      </div>
    )
  }

  const { result } = state
  const tone = TONE[result.outcome] || 'pending'
  const Head = tone === 'ok' ? ShieldCheck : tone === 'bad' ? ShieldX : AlertCircle
  return (
    <div className={`pc pc-${tone}`} role="status">
      <div className="pc-head">
        <Head size={17} />
        <div>
          <strong>{result.label}</strong>
          <p>
            {result.outcome === 'verified'
              ? result.documentChecked
                ? 'Independently verified in this browser: the file, the record and the blockchain all agree.'
                : 'The record is independently verified on the blockchain. No document was checked.'
              : 'Not verified. The first failed check is marked below.'}
          </p>
        </div>
      </div>
      <ol className="pc-steps">
        {result.checks.map((c) => {
          const Icon = STEP_ICON[c.status] || CircleDashed
          return (
            <li key={c.key} className={`pc-step pc-step-${c.status}`}>
              <Icon size={13} />
              <div>
                <span>{c.label}</span>
                {c.status !== 'skip' || c.detail !== 'Not run.' ? <small>{c.detail}</small> : null}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
