// /public/procurement/:code — one procurement's public result plus the
// independent blockchain verifier for it. No login.
//
// Shows only what the server's public record returns (procurement/record.py
// public_record): the procurement, its ABC and dates, and — once awarded —
// WHO won and WHEN. No bid amounts, no bidders, no contract amount (decision D2).
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AlertCircle, Clock, Trophy } from 'lucide-react'

import { apiPublicRecord } from '../api'
import { PublicBackBar, PublicNav } from '../components/PublicShell'
import PublicVerifier from '../components/PublicVerifier'
import { Skeleton } from '../components/Skeleton'
import StatusBadge from '../components/ui/StatusBadge'
import { publicDate } from '../blockchain/recordView'
import { fmtDate, peso } from '../utils/format'
import { normalizeProcurementCode } from '../utils/procurementCode'
import '../style/PublicResultsPage.css'
import '../style/procurement-record.css'

export default function PublicProcurementPage() {
  const { code: raw } = useParams()
  const code = normalizeProcurementCode(raw)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setData(null); setError('')
    apiPublicRecord(code)
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [code])

  const r = data?.result

  return (
    <div className="pub">
      <PublicNav />
      <PublicBackBar />

      <main className="pub-main pub-main--detail rf-home">
        {error && <div className="pub-error" role="alert"><AlertCircle size={18} /> {error}</div>}

        {!error && !data && (
          <div className="rf-card"><div className="rf-card-body">
            <Skeleton width="50%" height={18} /><Skeleton width="70%" style={{ marginTop: 10 }} />
          </div></div>
        )}

        {data && (
          <section className="rf-card" aria-labelledby="pp-h">
            <div className="rf-card-body pr-head">
              <div style={{ minWidth: 0 }}>
                <div className="pr-title-row">
                  <h1 id="pp-h" className="pr-title">{data.name}</h1>
                  <StatusBadge domain="project" status={data.status} />
                </div>
                <div className="pr-meta">
                  <span className="rf-code">{data.code}</span>
                  <span>{data.category || '—'}</span>
                  <span>ABC <strong>{peso(data.budget)}</strong></span>
                  {data.published_at && <span>Published {fmtDate(data.published_at)}</span>}
                  {data.deadline && <span>Deadline {fmtDate(data.deadline)}</span>}
                  {data.bids_received != null && <span>{data.bids_received} bid{data.bids_received === 1 ? '' : 's'} so far</span>}
                </div>
              </div>
            </div>
            <div className="rf-card-body" style={{ paddingTop: 0 }}>
              {r?.state === 'awarded' ? (
                <div className="pr-result-main">
                  <span className="pr-result-icon" aria-hidden="true"><Trophy size={20} /></span>
                  <div>
                    <div className="pr-result-label">Awarded to</div>
                    <div className="pr-result-winner">{r.winner}</div>
                    <div className="pr-muted pr-small">Awarded {publicDate(r.awarded_at)}. Bid amounts and other bidders are not published.</div>
                  </div>
                </div>
              ) : r?.state === 'closed' ? (
                <div className="pr-result-main">
                  <span className="pr-result-icon" aria-hidden="true"><Clock size={20} /></span>
                  <div><div className="pr-result-winner">Bidding closed</div><div className="pr-muted pr-small">{r.detail}</div></div>
                </div>
              ) : (
                <div className="pr-muted pr-small">Results appear here once a winner is selected.</div>
              )}
            </div>
          </section>
        )}

        {/* The verifier reads the contract straight from Sepolia in this
            browser and matches every step by its fingerprint. */}
        {!error && <PublicVerifier key={code} initialCode={code} embedded />}
      </main>
    </div>
  )
}
