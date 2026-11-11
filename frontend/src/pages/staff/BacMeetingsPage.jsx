// Staff ▸ BAC Meetings. The Secretariat's side of the committee: once a bid
// has passed evaluation and post-qualification, draft the BAC Resolution for
// it (meeting date, basis, minutes), open voting for the members, and follow
// it to the Head. Staff never vote and never choose the bid: the resolution
// always names the ranking's Lowest Calculated Responsive Bid.
import { useEffect, useState } from 'react'
import { ArrowLeft, ClipboardPen, Gavel, Send, Trash2 } from 'lucide-react'
import {
  apiBacCreateResolution, apiBacDiscardResolution, apiBacOpenVoting, apiBacProject, apiBacProjects,
  apiBacRecordVote, apiListBacMemberships,
} from '../../api'
import { storedUser } from '../../components/shell/AppHeader'
import PageHeader from '../../components/ui/PageHeader'
import EmptyState from '../../components/ui/EmptyState'
import StatusBadge from '../../components/ui/StatusBadge'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { ListSkeleton } from '../../components/Skeleton'
import { toast } from '../../components/ui/Toaster'
import {
  RankingTable, ResolutionFacts, ResolutionStatus, VoteCounts, VoteList,
} from '../../components/bac/BacParts'
import { useBacStatus } from '../../utils/workspace'
import { fmtDate, peso } from '../../utils/format'
import '../../style/bac.css'

const today = () => new Date().toISOString().slice(0, 10)

function stageOf(p) {
  if (p.status === 'awarded') return { tone: 'success', label: 'Awarded' }
  if (p.resolution?.status === 'adopted') return { tone: 'warning', label: 'With the Head' }
  if (p.resolution?.status === 'voting') return { tone: 'info', label: 'Voting' }
  if (p.resolution?.status === 'draft') return { tone: 'neutral', label: 'Draft resolution' }
  if (p.post_qualified) return { tone: 'info', label: 'Post-qualification recorded' }
  return { tone: 'neutral', label: `Evaluating (${p.evaluations_done} of ${p.evaluations_expected})` }
}

// Staff enter a vote a member gave at the in-person meeting, from the signed
// ballot or the minutes. The record keeps the member's name, says Staff
// recorded it, and the member is notified (bac_views.ResolutionViewSet.record_vote).
function RecordVoteForm({ resolution, onRecorded }) {
  const [members, setMembers] = useState(null)
  const [form, setForm] = useState({ member: '', choice: 'approve', comment: '' })
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { apiListBacMemberships().then(setMembers).catch(() => setMembers([])) }, [])
  const voted = new Set(resolution.votes.map(v => v.member))
  const pending = (members || []).filter(m => m.active && !voted.has(m.id))
  const who = pending.find(m => String(m.id) === String(form.member))
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const send = async () => {
    setBusy(true)
    try {
      const res = await apiBacRecordVote(resolution.id, { ...form, member: Number(form.member) })
      toast.success(res.status === 'adopted'
        ? `Vote recorded. ${res.number} is adopted and sent to the Head.` : `${who?.name}'s vote recorded.`)
      setForm({ member: '', choice: 'approve', comment: '' })
      onRecorded()
    } catch (err) {
      toast.error(err.message || 'Could not record the vote.')
    } finally {
      setBusy(false)
    }
  }

  if (members !== null && !pending.length) return null
  return (
    <form className="bac-card-body" style={{ borderTop: '1px solid var(--border)' }}
      onSubmit={e => { e.preventDefault(); setConfirm(true) }} aria-labelledby={`rv-h-${resolution.id}`}>
      <h4 id={`rv-h-${resolution.id}`} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ClipboardPen size={15} aria-hidden="true" /> Record an in-person vote
      </h4>
      <p className="bac-hint" style={{ margin: 0 }}>
        For a member who voted at the meeting, from their signed ballot or the minutes. Members can still vote from their own accounts.
      </p>
      <div className="bac-form">
        <div className="bac-field">
          <label htmlFor={`rv-m-${resolution.id}`}>Member</label>
          <select id={`rv-m-${resolution.id}`} value={form.member} onChange={set('member')} required disabled={members === null}>
            <option value="">{members === null ? 'Loading…' : 'Choose a member'}</option>
            {pending.map(m => <option key={m.id} value={m.id}>{m.name} ({m.position_label})</option>)}
          </select>
        </div>
        <div className="bac-field">
          <label htmlFor={`rv-c-${resolution.id}`}>Vote</label>
          <select id={`rv-c-${resolution.id}`} value={form.choice} onChange={set('choice')}>
            <option value="approve">Approve</option>
            <option value="disapprove">Disapprove</option>
            <option value="abstain">Abstain</option>
          </select>
        </div>
        <div className="bac-field full">
          <label htmlFor={`rv-r-${resolution.id}`}>Reason the member gave</label>
          <textarea id={`rv-r-${resolution.id}`} value={form.comment} onChange={set('comment')} required minLength={10}
            placeholder="As written on the ballot or stated in the minutes." />
        </div>
      </div>
      <div className="bac-actions">
        <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !form.member || form.comment.trim().length < 10}>
          {busy ? 'Saving…' : 'Record vote'}
        </button>
      </div>
      {confirm && who && (
        <ConfirmDialog title={`Record ${who.name}'s vote: ${form.choice}?`} confirmLabel="Record vote" busy={busy}
          tone={form.choice === 'disapprove' ? 'danger' : 'primary'}
          points={["The vote is kept permanently under the member's name, marked as given in person and recorded by you.",
            `${who.name} is notified and can add a correction note if it is wrong.`,
            "A recorded vote can't be edited or deleted."]}
          onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); send() }} />
      )}
    </form>
  )
}

function ProjectMeeting({ projectId, onBack }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ meeting_date: today(), meeting_mode: 'in_person', venue: '', justification: '' })
  const [minutes, setMinutes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(null)   // 'open' | 'discard'

  const load = () => apiBacProject(projectId).then(setData).catch(e => setError(e.message || 'Could not load.'))
  useEffect(() => { load() }, [projectId])  // eslint-disable-line

  if (error) return <p className="bac-error" role="alert">{error}</p>
  if (!data) return <ListSkeleton rows={4} />

  const open = data.resolutions.find(r => ['draft', 'voting', 'adopted'].includes(r.status))
  const lcrb = data.ranking.rows.find(r => r.bid_id === data.ranking.lcrb_id)
  const canDraft = !open && lcrb && data.project.status !== 'awarded'
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const draft = async (e) => {
    e.preventDefault()
    setBusy(true)
    const fd = new FormData()
    fd.append('project', projectId)
    Object.entries(form).forEach(([k, v]) => fd.append(k, v))
    if (minutes) fd.append('minutes', minutes)
    try {
      const res = await apiBacCreateResolution(fd)
      toast.success(`${res.number} drafted. Check it, then open voting.`)
      await load()
    } catch (err) {
      toast.error(err.message || 'Could not draft the resolution.')
    } finally {
      setBusy(false)
    }
  }

  const run = async (kind) => {
    setBusy(true)
    try {
      if (kind === 'open') {
        await apiBacOpenVoting(open.id)
        toast.success('Voting is open. The members have been notified.')
      } else {
        await apiBacDiscardResolution(open.id)
        toast.success('Draft discarded.')
      }
      await load()
    } catch (err) {
      toast.error(err.message || 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bac-page">
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
        <ArrowLeft size={14} /> Back to BAC Meetings
      </button>
      <section className="bac-card" aria-labelledby="pm-h">
        <div className="bac-card-head">
          <div><h3 id="pm-h">{data.project.code} · {data.project.name}</h3>
            <p>ABC {peso(data.project.budget)} · {data.project.bid_count} bid(s) · bidding closed {fmtDate(data.project.deadline)}</p></div>
          <StatusBadge {...stageOf(data.project)} />
        </div>
        <div className="bac-card-body">
          <h4 style={{ margin: 0 }}>Ranking</h4>
          <RankingTable ranking={data.ranking} />
        </div>
      </section>

      {canDraft && (
        <form className="bac-card" onSubmit={draft} aria-labelledby="dr-h">
          <div className="bac-card-head"><div>
            <h3 id="dr-h">Draft the BAC Resolution</h3>
            <p>It will recommend {lcrb.company} ({peso(lcrb.amount)}), the bid that passed post-qualification.</p>
          </div></div>
          <div className="bac-card-body">
            <div className="bac-form">
              <div className="bac-field">
                <label htmlFor="dr-date">Meeting date</label>
                <input id="dr-date" type="date" value={form.meeting_date} onChange={set('meeting_date')} required />
              </div>
              <div className="bac-field">
                <label htmlFor="dr-mode">Meeting</label>
                <select id="dr-mode" value={form.meeting_mode} onChange={set('meeting_mode')}>
                  <option value="in_person">In person</option>
                  <option value="online">Online</option>
                </select>
              </div>
              <div className="bac-field">
                <label htmlFor="dr-venue">Venue or link (optional)</label>
                <input id="dr-venue" value={form.venue} onChange={set('venue')} placeholder="e.g. BAC Conference Room" />
              </div>
              <div className="bac-field full">
                <label htmlFor="dr-basis">Basis of the recommendation</label>
                <textarea id="dr-basis" value={form.justification} onChange={set('justification')} required
                  placeholder="e.g. the bid is the lowest among those found responsive, and the bidder passed post-qualification on its documents and site visit;" />
                <span className="bac-hint">Printed in the resolution after "WHEREAS,". The ranking and every vote are added automatically.</span>
              </div>
              <div className="bac-field full">
                <label htmlFor="dr-min">Minutes of the meeting (optional, PDF or image)</label>
                <input id="dr-min" type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => setMinutes(e.target.files?.[0] || null)} />
              </div>
            </div>
            <div className="bac-actions">
              <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</button>
            </div>
          </div>
        </form>
      )}

      {!open && !lcrb && data.project.status !== 'awarded' && (
        <div className="bac-note" role="status"><Gavel size={16} />
          <div><strong>Not ready for a resolution</strong>
            <p>The members are still evaluating, or the Chairperson hasn&apos;t recorded a passed post-qualification yet.</p></div>
        </div>
      )}

      {data.resolutions.map(r => (
        <section key={r.id} className="bac-card" aria-labelledby={`r-${r.id}`}>
          <div className="bac-card-head">
            <div><h3 id={`r-${r.id}`}>{r.number}</h3><p>{r.status_label}</p></div>
            <ResolutionStatus resolution={r} />
          </div>
          <div className="bac-card-body">
            <ResolutionFacts resolution={r} />
            {r.status !== 'draft' && <VoteCounts counts={r.counts} majority={3} />}
            {r.status !== 'draft' && <VoteList votes={r.votes} user={storedUser()} onChanged={load} />}
            {r.status === 'draft' && (
              <div className="bac-actions">
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => setConfirm('discard')}>
                  <Trash2 size={13} /> Discard draft
                </button>
                <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy} onClick={() => setConfirm('open')}>
                  <Send size={13} /> Open voting
                </button>
              </div>
            )}
          </div>
          {r.status === 'voting' && r.meeting_mode === 'in_person' && <RecordVoteForm resolution={r} onRecorded={load} />}
        </section>
      ))}

      {confirm && open && (
        <ConfirmDialog
          title={confirm === 'open' ? `Open voting on ${open.number}?` : `Discard ${open.number}?`}
          tone={confirm === 'open' ? 'primary' : 'danger'}
          confirmLabel={confirm === 'open' ? 'Open voting' : 'Discard draft'}
          points={confirm === 'open'
            ? ['The five members are notified and can vote with a comment.', 'The draft can no longer be changed.',
              'Three approvals adopt it; the PDF is then generated and sent to the Head.']
            : ['The draft is deleted. Nobody has voted on it yet.']}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); run(c) }}
        />
      )}
    </div>
  )
}

export default function BacMeetingsPage() {
  const status = useBacStatus()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState(null)

  useEffect(() => {
    if (openId) return
    apiBacProjects().then(setRows).catch(e => toast.error(e.message || 'Could not load.')).finally(() => setLoading(false))
  }, [openId])

  if (openId) return <div className="ad-content"><ProjectMeeting projectId={openId} onBack={() => setOpenId(null)} /></div>

  return (
    <div className="bac-page ad-content">
      <PageHeader title="BAC Meetings"
        description="Procurements whose bidding has closed. Draft the resolution once a bid passes post-qualification." />
      {!status.loading && !status.workflow_enabled && (
        <div className="bac-note bac-note--warning" role="status"><Gavel size={16} />
          <div><strong>The BAC Committee workflow is off</strong>
            <p>Bids are still evaluated and awarded the original way, so nothing here can be changed yet.</p></div>
        </div>
      )}
      <section className="bac-card" aria-label="Procurements">
        {loading ? <div className="bac-card-body"><ListSkeleton rows={4} /></div>
          : !rows.length ? <EmptyState icon={Gavel} title="Nothing to prepare"
            description="Procurements appear here once their bidding deadline has passed." />
            : (
              <div className="bac-list" role="list">
                {rows.map(p => (
                  <button key={p.id} type="button" role="listitem" className="bac-list-row" onClick={() => setOpenId(p.id)}>
                    <span style={{ minWidth: 0 }}>
                      <strong>{p.code} · {p.name}</strong>
                      <span className="sub">{p.bid_count} bid(s) · {p.qualified} qualified · ABC {peso(p.budget)}</span>
                    </span>
                    <StatusBadge {...stageOf(p)} />
                  </button>
                ))}
              </div>
            )}
      </section>
    </div>
  )
}
