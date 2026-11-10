// Head ▸ Award Approvals. With separation of duties on, the award is the
// Head's decision on the BAC Committee's adopted resolution: approving runs
// the same award code the Admin's "Mark as Winner" used, and writes the same
// three blockchain records in the same order (evaluation commitment, winning
// bid, award). Returning sends it back to the committee with remarks.
import { useEffect, useState } from 'react'
import { ArrowLeft, Award, Undo2 } from 'lucide-react'
import { apiBacApproveAward, apiBacProject, apiBacResolutions, apiBacReturnAward } from '../../api'
import PageHeader from '../../components/ui/PageHeader'
import EmptyState from '../../components/ui/EmptyState'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { ListSkeleton } from '../../components/Skeleton'
import { toast } from '../../components/ui/Toaster'
import {
  RankingTable, ResolutionFacts, ResolutionFileCheck, ResolutionStatus, VoteCounts, VoteList,
} from '../../components/bac/BacParts'
import { runAnchorSequence } from '../../blockchain/anchorStore'
import { refreshProjects } from '../../store/projectsStore'
import { useBacStatus } from '../../utils/workspace'
import { peso } from '../../utils/format'
import '../../style/bac.css'

function Decision({ resolution, onDone, onBack }) {
  const [ranking, setRanking] = useState(null)
  const [confirm, setConfirm] = useState(null)   // 'approve' | 'return'
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)
  const r = resolution
  useEffect(() => { apiBacProject(r.project).then(d => setRanking(d.ranking)).catch(() => setRanking({ rows: [] })) }, [r.project])
  const pending = r.status === 'adopted' && r.head_decision === 'pending'

  const approve = async () => {
    setBusy(true)
    try {
      const res = await apiBacApproveAward(r.id, { remarks })
      toast.success(`${r.project_code} awarded to ${r.recommended_company}.`)
      refreshProjects()
      // Same as the Admin's award: sign the records in order, one prompt at a
      // time. Not awaited: the award is saved; the chain writes can be retried.
      runAnchorSequence((res.anchor_sequence || []).map(a => ({
        anchor: a, label: `${r.project_code} · ${a.stage_label || a.stage}`,
      })))
      onDone()
    } catch (err) {
      toast.error(err.message || 'Could not approve the award.')
    } finally {
      setBusy(false)
    }
  }
  const sendBack = async () => {
    setBusy(true)
    try {
      await apiBacReturnAward(r.id, remarks)
      toast.success(`${r.number} returned to the BAC Committee.`)
      onDone()
    } catch (err) {
      toast.error(err.message || 'Could not return the recommendation.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bac-page">
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
        <ArrowLeft size={14} /> Back to award approvals
      </button>
      <section className="bac-card" aria-labelledby="d-h">
        <div className="bac-card-head">
          <div><h3 id="d-h">{r.number}</h3><p>Recommends {r.recommended_company} for {peso(r.recommended_amount)}</p></div>
          <ResolutionStatus resolution={r} />
        </div>
        <div className="bac-card-body"><ResolutionFacts resolution={r} /></div>
        <ResolutionFileCheck resolution={r} />
      </section>
      <section className="bac-card" aria-labelledby="rk-h">
        <div className="bac-card-head"><div><h3 id="rk-h">Ranking and post-qualification</h3></div></div>
        <div className="bac-card-body">{ranking ? <RankingTable ranking={ranking} /> : <ListSkeleton rows={2} />}</div>
      </section>
      <section className="bac-card" aria-labelledby="vt-h">
        <div className="bac-card-head"><div><h3 id="vt-h">Votes and comments</h3></div><VoteCounts counts={r.counts} /></div>
        <div className="bac-card-body"><VoteList votes={r.votes} /></div>
      </section>
      {pending && (
        <section className="bac-card" aria-labelledby="dec-h">
          <div className="bac-card-head"><div><h3 id="dec-h">Your decision</h3>
            <p>Approving makes the award. Returning sends it back to the committee; you must say why.</p></div></div>
          <div className="bac-card-body">
            <div className="bac-field">
              <label htmlFor="head-remarks">Remarks (required to return, optional to approve)</label>
              <textarea id="head-remarks" value={remarks} onChange={e => setRemarks(e.target.value)} />
            </div>
            <div className="bac-actions">
              <button type="button" className="ui-btn ui-btn--danger-outline ui-btn--sm" disabled={busy || remarks.trim().length < 10}
                title={remarks.trim().length < 10 ? 'Write at least 10 characters to return it' : ''} onClick={() => setConfirm('return')}>
                <Undo2 size={13} /> Return to BAC
              </button>
              <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy} onClick={() => setConfirm('approve')}>
                <Award size={13} /> Approve award
              </button>
            </div>
          </div>
        </section>
      )}
      {confirm === 'approve' && (
        <ConfirmDialog title={`Award ${r.project_code} to ${r.recommended_company}?`} confirmLabel="Approve award" onChain busy={busy}
          points={[`The contract is awarded for ${peso(r.recommended_amount)}; every bidder is notified.`,
            'An award is made once and can\'t be reassigned.',
            'Three records are written: the evaluation commitment, the winning bid and the award.']}
          onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); approve() }} />
      )}
      {confirm === 'return' && (
        <ConfirmDialog title={`Return ${r.number} to the BAC Committee?`} tone="warning" confirmLabel="Return" busy={busy}
          points={['Nothing is awarded.', 'The committee can re-evaluate and Staff can draft a new resolution.',
            'This resolution and your remarks stay in the BAC Records.']}
          onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); sendBack() }} />
      )}
    </div>
  )
}

export default function AwardApprovalsPage() {
  const status = useBacStatus()
  const [rows, setRows] = useState(null)
  const [openId, setOpenId] = useState(null)
  const load = () => apiBacResolutions({ status: 'adopted,returned' }).then(setRows).catch(e => { toast.error(e.message); setRows([]) })
  useEffect(() => { load() }, [])
  const open = (rows || []).find(r => r.id === openId)
  if (open) return <div className="hd-content"><Decision resolution={open} onBack={() => setOpenId(null)} onDone={() => { setOpenId(null); load() }} /></div>

  const pending = (rows || []).filter(r => r.head_decision === 'pending')
  const decided = (rows || []).filter(r => r.head_decision !== 'pending')
  return (
    <div className="bac-page hd-content">
      <PageHeader title="Award Approvals"
        description="Resolutions the BAC Committee adopted. Review the ranking and each member's vote, then approve the award or return it." />
      {!status.loading && !status.workflow_enabled && (
        <div className="bac-note" role="status"><Award size={16} />
          <div><strong>The BAC Committee workflow is off</strong><p>Awards are still made the original way.</p></div></div>
      )}
      <section className="bac-card" aria-labelledby="p-h">
        <div className="bac-card-head"><div><h3 id="p-h">Waiting for your decision</h3></div></div>
        {rows === null ? <div className="bac-card-body"><ListSkeleton rows={3} /></div>
          : !pending.length ? <EmptyState icon={Award} title="Nothing waiting" description="Adopted resolutions appear here." />
            : <div className="bac-list">{pending.map(r => (
              <button key={r.id} type="button" className="bac-list-row" onClick={() => setOpenId(r.id)}>
                <span><strong>{r.number}</strong>
                  <span className="sub">{r.project_code} · {r.project_name} · {r.recommended_company}, {peso(r.recommended_amount)}</span></span>
                <ResolutionStatus resolution={r} />
              </button>))}</div>}
      </section>
      {decided.length > 0 && (
        <section className="bac-card" aria-labelledby="dd-h">
          <div className="bac-card-head"><div><h3 id="dd-h">Decided</h3></div></div>
          <div className="bac-list">{decided.map(r => (
            <button key={r.id} type="button" className="bac-list-row" onClick={() => setOpenId(r.id)}>
              <span><strong>{r.number}</strong><span className="sub">{r.project_code} · {r.recommended_company}</span></span>
              <ResolutionStatus resolution={r} />
            </button>))}</div>
        </section>
      )}
    </div>
  )
}
