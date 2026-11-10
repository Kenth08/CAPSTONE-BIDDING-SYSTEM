// Pieces shared by the BAC Committee, Staff, Head and Admin screens.
import { useState } from 'react'
import { CheckCircle2, FileText, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'
import { apiFetchFileBlob } from '../../api'
import StatusBadge from '../ui/StatusBadge'
import { fmtDate, fmtDateTime, peso } from '../../utils/format'
import '../../style/bac.css'

const RESOLUTION_TONE = {
  draft: 'neutral', voting: 'info', adopted: 'success', not_adopted: 'danger', returned: 'warning',
}
const HEAD_TONE = { pending: 'warning', approved: 'success', returned: 'danger' }

export function ResolutionStatus({ resolution }) {
  if (!resolution) return null
  if (resolution.status === 'adopted') {
    return <StatusBadge tone={HEAD_TONE[resolution.head_decision]}
      label={resolution.head_decision === 'approved' ? 'Award approved by Head'
        : resolution.head_decision === 'pending' ? 'Adopted, awaiting Head' : 'Returned'} />
  }
  return <StatusBadge tone={RESOLUTION_TONE[resolution.status] || 'neutral'} label={resolution.status_label} />
}

export function VoteCounts({ counts, majority = 3 }) {
  if (!counts) return null
  return (
    <div className="bac-counts" aria-label="Vote count">
      <span className="bac-count approve">Approve {counts.approve}</span>
      <span className="bac-count disapprove">Disapprove {counts.disapprove}</span>
      <span className="bac-count">Abstain {counts.abstain}</span>
      <span className="bac-hint" style={{ alignSelf: 'center' }}>{majority} approvals adopt it</span>
    </div>
  )
}

// Every member's vote with their reason, in the order cast. A member who has
// since left the committee is marked; their vote and comment never change.
export function VoteList({ votes }) {
  if (!votes?.length) return <p className="bac-hint">No votes yet.</p>
  return (
    <div className="bac-votes">
      {votes.map(v => (
        <article key={v.id} className="bac-vote">
          <div className="bac-vote-head">
            <span className="bac-vote-who">
              {v.voter_name}<small>{v.position_label}{v.member_active === false
                ? ` · left the committee${v.member_ended_on ? ` ${fmtDate(v.member_ended_on)}` : ''}` : ''}</small>
            </span>
            <StatusBadge tone={v.choice === 'approve' ? 'success' : v.choice === 'disapprove' ? 'danger' : 'neutral'}
              label={v.choice_label} />
          </div>
          <p className="bac-vote-comment">{v.comment}</p>
          <span className="bac-vote-meta">Cast {fmtDateTime(v.cast_at)}</span>
        </article>
      ))}
    </div>
  )
}

// The computed ranking: bids a majority passed, lowest amount first.
export function RankingTable({ ranking }) {
  const rows = ranking?.rows || []
  if (!rows.length) {
    return <p className="bac-hint">No bid has been passed by a majority of members yet, so there is no ranking.</p>
  }
  return (
    <div className="bac-table-wrap">
      <table className="bac-table">
        <caption className="sr-only">Ranking of bids that passed evaluation</caption>
        <thead>
          <tr><th scope="col">Rank</th><th scope="col">Bidder</th><th scope="col" className="num">Amount</th>
            <th scope="col">Members passed</th><th scope="col">Post-qualification</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.bid_id} className={r.bid_id === ranking.candidate_id ? 'is-candidate' : ''}>
              <td>{r.rank}</td>
              <td>
                {r.company}
                {r.bid_id === ranking.lcrb_id && <div className="bac-hint">Lowest Calculated Responsive Bid</div>}
                {r.bid_id === ranking.candidate_id && r.bid_id !== ranking.lcrb_id && <div className="bac-hint">Next to post-qualify</div>}
              </td>
              <td className="num">{peso(r.amount)}</td>
              <td>{r.evaluations_passed} of {r.evaluations_count}</td>
              <td>
                {r.post_qualification || '—'}
                {r.post_qualification_remarks && <div className="bac-hint">{r.post_qualification_remarks}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Downloads the stored resolution PDF in the browser, hashes it, and compares
// it with the fingerprint recorded the moment the committee adopted it.
export function ResolutionFileCheck({ resolution }) {
  const [state, setState] = useState(null)   // null | 'busy' | { match, hash } | { error }
  if (!resolution?.resolution_file_url) return null
  const check = async () => {
    setState('busy')
    try {
      const hash = await sha256Hex(await apiFetchFileBlob(resolution.resolution_file_url))
      setState({ match: hash === resolution.resolution_sha256, hash })
    } catch (e) {
      setState({ error: e?.message || 'The file could not be read.' })
    }
  }
  return (
    <div className="bac-card-body" style={{ paddingTop: 0 }}>
      <div className="bac-actions" style={{ justifyContent: 'flex-start' }}>
        <a className="ui-btn ui-btn--secondary ui-btn--sm" href={resolution.resolution_file_url}>
          <FileText size={13} aria-hidden="true" /> Download resolution PDF
        </a>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={check} disabled={state === 'busy'}>
          {state === 'busy' ? <Loader2 size={13} className="ui-spin" /> : <ShieldCheck size={13} />} Check the file
        </button>
      </div>
      <div className="bac-hint">
        Fingerprint recorded at adoption: <span className="bac-hash">{resolution.resolution_sha256}</span>
      </div>
      {state && state !== 'busy' && (state.error
        ? <div className="bac-note bac-note--warning" role="status"><ShieldAlert size={16} /> <div>{state.error}</div></div>
        : state.match
          ? <div className="bac-note bac-note--success" role="status"><CheckCircle2 size={16} />
            <div><strong>Match</strong><p>The stored file is exactly what the committee adopted.</p></div></div>
          : <div className="bac-note bac-note--danger" role="status"><ShieldAlert size={16} />
            <div><strong>Mismatch</strong><p>The stored file differs from what was adopted: {state.hash}</p></div></div>
      )}
    </div>
  )
}

// Header facts of one resolution.
export function ResolutionFacts({ resolution }) {
  const r = resolution
  return (
    <dl className="bac-kv">
      <div><dt>Procurement</dt><dd>{r.project_code} · {r.project_name}</dd></div>
      <div><dt>Recommended bidder</dt><dd>{r.recommended_company}</dd></div>
      <div><dt>Amount</dt><dd>{peso(r.recommended_amount)}</dd></div>
      <div><dt>Meeting</dt><dd>{fmtDate(r.meeting_date)} · {r.meeting_mode_label}{r.venue ? ` · ${r.venue}` : ''}</dd></div>
      <div><dt>Prepared by</dt><dd>{r.prepared_by_name}</dd></div>
      {r.decided_at && <div><dt>Committee decided</dt><dd>{fmtDateTime(r.decided_at)}</dd></div>}
      {r.head_decided_at && <div><dt>Head decision</dt><dd>{r.head_decision_label} by {r.head_decided_by_name}, {fmtDateTime(r.head_decided_at)}</dd></div>}
      <div className="full" style={{ gridColumn: '1 / -1' }}><dt>Basis of the recommendation</dt><dd>{r.justification}</dd></div>
      {r.head_remarks && <div style={{ gridColumn: '1 / -1' }}><dt>Head&apos;s remarks</dt><dd>{r.head_remarks}</dd></div>}
      {r.minutes_url && <div><dt>Minutes</dt><dd><a href={r.minutes_url}>Download minutes</a></dd></div>}
    </dl>
  )
}
