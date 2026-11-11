// BAC Records: every resolution the committee voted on, with each member's
// vote and comment. Read-only for everyone (Admin, Head, Staff, members);
// votes can't be edited, and a member who has since left stays on the record.
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ScrollText, Search } from 'lucide-react'
import { apiBacResolutions, apiListBacMemberships } from '../../api'
import PageHeader from '../../components/ui/PageHeader'
import EmptyState from '../../components/ui/EmptyState'
import { ListSkeleton } from '../../components/Skeleton'
import {
  ResolutionFacts, ResolutionFileCheck, ResolutionStatus, VoteCounts, VoteList,
} from '../../components/bac/BacParts'
import { fmtDate } from '../../utils/format'
import { storedUser } from '../../components/shell/AppHeader'

export default function BacRecordsPage({ className = '' }) {
  const [rows, setRows] = useState([])
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [year, setYear] = useState('')
  const [member, setMember] = useState('')
  const [openId, setOpenId] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const user = storedUser()

  useEffect(() => {
    apiListBacMemberships().then(setMembers).catch(() => {})
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const timer = setTimeout(() => {
      apiBacResolutions({ q, year, member, status: 'voting,adopted,not_adopted,returned' })
        .then(r => { if (alive) { setRows(r); setError('') } })
        .catch(e => { if (alive) setError(e.message || 'Could not load the BAC Records.') })
        .finally(() => { if (alive) setLoading(false) })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [q, year, member, reloadKey])

  const years = useMemo(() => {
    const now = new Date().getFullYear()
    return [now, now - 1, now - 2, now - 3]
  }, [])
  const open = rows.find(r => r.id === openId)

  if (open) {
    return (
      <div className={`bac-page ${className}`}>
        <button type="button" className="ad-back-link ui-btn ui-btn--ghost ui-btn--sm" style={{ alignSelf: 'flex-start' }}
          onClick={() => setOpenId(null)}>
          <ArrowLeft size={14} /> Back to BAC Records
        </button>
        <section className="bac-card" aria-labelledby="rec-title">
          <div className="bac-card-head">
            <div>
              <h3 id="rec-title">{open.number}</h3>
              <p>{open.project_code} · {open.project_name}</p>
            </div>
            <ResolutionStatus resolution={open} />
          </div>
          <div className="bac-card-body"><ResolutionFacts resolution={open} /></div>
          <ResolutionFileCheck resolution={open} />
        </section>
        <section className="bac-card" aria-labelledby="votes-title">
          <div className="bac-card-head">
            <div>
              <h3 id="votes-title">Votes and comments</h3>
              <p>Kept permanently. A vote can&apos;t be changed after it is cast; the member or Staff can add a correction note beside it.</p>
            </div>
            <VoteCounts counts={open.counts} />
          </div>
          <div className="bac-card-body"><VoteList votes={open.votes} user={user} onChanged={() => setReloadKey(k => k + 1)} /></div>
        </section>
      </div>
    )
  }

  return (
    <div className={`bac-page ${className}`}>
      <PageHeader title="BAC Records"
        description="Every resolution the BAC Committee voted on, with each member's vote and the reason they gave." />
      <div className="bac-card">
        <div className="bac-card-body">
          <div className="bac-filters">
            <div className="bac-field">
              <label htmlFor="rec-q">Search</label>
              <input id="rec-q" type="search" value={q} onChange={e => setQ(e.target.value)}
                placeholder="Procurement code, name or resolution number" />
            </div>
            <div className="bac-field">
              <label htmlFor="rec-member">Member</label>
              <select id="rec-member" value={member} onChange={e => setMember(e.target.value)}>
                <option value="">All members</option>
                {members.map(m => (
                  <option key={m.id} value={m.id}>{m.name} ({m.position_label}{m.active ? '' : ', former'})</option>
                ))}
              </select>
            </div>
            <div className="bac-field">
              <label htmlFor="rec-year">Year</label>
              <select id="rec-year" value={year} onChange={e => setYear(e.target.value)}>
                <option value="">All years</option>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
        </div>
        {error && <div className="bac-card-body"><p className="bac-error" role="alert">{error}</p></div>}
        {loading ? <div className="bac-card-body"><ListSkeleton rows={4} /></div>
          : !rows.length ? (
            <EmptyState icon={q || year || member ? Search : ScrollText}
              title={q || year || member ? 'No matching records' : 'No resolutions yet'}
              description="Resolutions appear here once the BAC Committee opens voting on one." />
          ) : (
            <div className="bac-list" role="list">
              {rows.map(r => (
                <button key={r.id} type="button" role="listitem" className="bac-list-row" onClick={() => setOpenId(r.id)}>
                  <span style={{ minWidth: 0 }}>
                    <strong>{r.number}</strong>
                    <span className="sub">{r.project_code} · {r.project_name} · meeting {fmtDate(r.meeting_date)}</span>
                    <span className="sub">Recommended: {r.recommended_company} · {r.votes.length} vote(s)</span>
                  </span>
                  <ResolutionStatus resolution={r} />
                </button>
              ))}
            </div>
          )}
      </div>
    </div>
  )
}
