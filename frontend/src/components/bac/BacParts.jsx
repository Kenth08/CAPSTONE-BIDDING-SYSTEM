// Pieces shared by the BAC Committee, Staff, Head and Admin screens.
import { useState } from 'react'
import { CheckCircle2, FileText, Loader2, MessageSquarePlus, ShieldAlert, ShieldCheck } from 'lucide-react'
import { apiBacAddVoteNote, apiFetchFileBlob } from '../../api'
import StatusBadge from '../ui/StatusBadge'
import ConfirmDialog from '../ui/ConfirmDialog'
import { toast } from '../ui/Toaster'
import { fmtDate, fmtDateTime, peso } from '../../utils/format'
import PreviewButton from '../ui/FilePreview'
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

// Who may add a correction note to a vote: the member who cast it (even
// after leaving the committee) or Procurement Staff. Mirrors VoteNoteView.
export function canAddVoteNote(vote, user) {
  if (!user?.id) return false
  return user.role === 'staff' || (user.role === 'bac' && vote.member_user === user.id)
}

function VoteNoteForm({ vote, onAdded }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  if (!open) {
    return (
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" style={{ alignSelf: 'flex-start' }}
        onClick={() => setOpen(true)}>
        <MessageSquarePlus size={13} aria-hidden="true" /> Add correction note
      </button>
    )
  }
  const send = async () => {
    setBusy(true)
    try {
      await apiBacAddVoteNote(vote.id, note.trim())
      toast.success('Correction note added.')
      setOpen(false)
      setNote('')
      onAdded?.()
    } catch (err) {
      toast.error(err.message || 'Could not add the note.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="bac-field" onSubmit={e => { e.preventDefault(); setConfirm(true) }}>
      <label htmlFor={`vn-${vote.id}`}>Correction note</label>
      <textarea id={`vn-${vote.id}`} value={note} onChange={e => setNote(e.target.value)} required minLength={10}
        maxLength={1000} placeholder="e.g. My comment cites the wrong date: the site visit was on 12 November." />
      <span className="bac-hint">The vote and the count stay as they are. The note is shown beside the vote, permanently.</span>
      <div className="bac-actions">
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || note.trim().length < 10}>
          {busy ? 'Saving…' : 'Add note'}
        </button>
      </div>
      {confirm && (
        <ConfirmDialog title={`Add a correction note to ${vote.voter_name}'s vote?`} confirmLabel="Add note" busy={busy}
          points={['The note is kept permanently and can\'t be edited or deleted.',
            `The vote stays ${vote.choice_label}. If the vote itself is wrong, the Head can return the resolution so the committee votes again.`]}
          onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); send() }} />
      )}
    </form>
  )
}

// Every member's vote with their reason, in the order cast. A member who has
// since left the committee is marked; their vote and comment never change.
// A vote Staff entered from an in-person meeting says so, and correction notes
// are listed under the vote. Pass `user` (storedUser()) to offer the note form
// to whoever may add one, and `onChanged` to reload after a note is added.
export function VoteList({ votes, user, onChanged }) {
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
          <span className="bac-vote-meta">
            {v.source === 'in_person'
              ? `Given in person · recorded by ${v.recorded_by_name || 'Procurement Staff'} ${fmtDateTime(v.cast_at)}`
              : `Cast ${fmtDateTime(v.cast_at)}`}
          </span>
          {v.notes?.length > 0 && (
            <ul className="bac-vote-notes" aria-label={`Correction notes on ${v.voter_name}'s vote`}>
              {v.notes.map(n => (
                <li key={n.id}>
                  <span className="bac-vote-meta">Correction note · {n.author_name} ({n.author_role}) · {fmtDateTime(n.created_at)}</span>
                  <p className="bac-vote-comment">{n.note}</p>
                </li>
              ))}
            </ul>
          )}
          {user && canAddVoteNote(v, user) && <VoteNoteForm vote={v} onAdded={onChanged} />}
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
        <PreviewButton url={resolution.resolution_file_url} name={`${resolution.number}.pdf`} className="ui-btn ui-btn--secondary ui-btn--sm" />
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
