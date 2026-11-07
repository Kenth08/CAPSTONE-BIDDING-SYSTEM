import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, CircleDashed, Loader2, ShieldCheck, ShieldX, XCircle } from 'lucide-react'

import { packetVerifyContext } from '../blockchain/anchor'
import { isCurrentCheck, verifyPacket } from '../blockchain/packetVerify'

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
    const inputs = { loadPacket, fileHash }
    setState({ phase: 'loading', ...inputs })
    ;(async () => {
      try {
        const packet = await loadPacket()
        if (!live) return
        if (!packet) { setState({ phase: 'unavailable', ...inputs }); return }
        const result = await verifyPacket(packet, { fileHash, ...packetVerifyContext() })
        if (live) setState({ phase: 'done', result, ...inputs })
      } catch (err) {
        if (live) setState({ phase: 'error', message: err?.message || 'The check could not be run.', ...inputs })
      }
    })()
    return () => { live = false }
  }, [loadPacket, fileHash])

  // Checked on every render: the effect above runs only after a render has already
  // happened with the new inputs, and the old result must not be shown for that one.
  if (!isCurrentCheck(state, loadPacket, fileHash)) {
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
  const { tone, label, note } = result.display
  const passed = result.integrity === 'match'
  const chosen = fileHash ? 'file' : 'no file'
  const Head = tone === 'ok' ? ShieldCheck : tone === 'bad' ? ShieldX : AlertCircle
  return (
    <div className={`pc pc-${tone}`} role="status" data-checked={chosen} data-outcome={result.outcome}>
      <div className="pc-head">
        <Head size={17} />
        <div>
          <strong>{label}</strong>
          <p>
            {passed
              ? result.documentChecked
                ? 'Checked in this browser: the selected file, the record and the blockchain agree.'
                : 'The record was checked against the blockchain in this browser. No document was checked.'
              : `${result.category}. Not verified. The first failed check is marked below.`}
          </p>
          {result.documentMatch && !result.green && (
            <p>This file is the {result.documentMatch.label}, version {result.documentMatch.version}.</p>
          )}
          {note && <p>{note}</p>}
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
