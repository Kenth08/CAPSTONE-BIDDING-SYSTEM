// Admin ▸ BAC Committee: record the designations the Head made (office order
// number, date, scanned copy) and end a seat when a member resigns or a term
// ends. The server enforces five seats, one Chairperson, one Vice-Chairperson,
// and that the Head can't sit on the committee.
import { useEffect, useState } from 'react'
import { Landmark, UserMinus, UserPlus } from 'lucide-react'
import {
  apiCreateBacMembership, apiEndBacMembership, apiListBacMemberships, apiListManagedUsers,
} from '../../api'
import PageHeader from '../../components/ui/PageHeader'
import StatusBadge from '../../components/ui/StatusBadge'
import EmptyState from '../../components/ui/EmptyState'
import { ListSkeleton } from '../../components/Skeleton'
import { toast } from '../../components/ui/Toaster'
import { useBacStatus } from '../../utils/workspace'
import { fmtDate } from '../../utils/format'
import '../../style/bac.css'

const POSITIONS = [
  { value: 'chair', label: 'Chairperson' },
  { value: 'vice_chair', label: 'Vice-Chairperson' },
  { value: 'member', label: 'Member' },
]
const today = () => new Date().toISOString().slice(0, 10)

export default function BacCommitteePage() {
  const status = useBacStatus()
  const [seats, setSeats] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ user: '', position: 'member', designated_on: today(), designation_reference: '' })
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [ending, setEnding] = useState(null)   // { seat, reason, date }

  const load = () => Promise.all([apiListBacMemberships(), apiListManagedUsers()])
    .then(([m, u]) => { setSeats(m); setUsers(u) })
    .catch(e => toast.error(e.message || 'Could not load the committee.'))
    .finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const active = seats.filter(s => s.active)
  const former = seats.filter(s => !s.active)
  const seatedIds = new Set(active.map(s => s.user))
  const candidates = users.filter(u => u.role === 'bac' && u.is_active && !seatedIds.has(u.id))

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const record = async (e) => {
    e.preventDefault()
    setSaving(true); setError('')
    const fd = new FormData()
    Object.entries(form).forEach(([k, v]) => fd.append(k, v))
    if (file) fd.append('designation_document', file)
    try {
      const seat = await apiCreateBacMembership(fd)
      toast.success(`${seat.name} recorded as ${seat.position_label}.`)
      setShowForm(false); setFile(null)
      setForm({ user: '', position: 'member', designated_on: today(), designation_reference: '' })
      load()
    } catch (err) {
      setError(err.message || 'Could not record the designation.')
    } finally {
      setSaving(false)
    }
  }

  const endSeat = async (e) => {
    e.preventDefault()
    try {
      await apiEndBacMembership(ending.seat.id, { end_reason: ending.reason, ended_on: ending.date })
      toast.success(`${ending.seat.name}'s seat ended. Their votes and evaluations stay on the record.`)
      setEnding(null)
      load()
    } catch (err) {
      toast.error(err.message || 'Could not end the designation.')
    }
  }

  return (
    <div className="bac-page ad-content">
      <PageHeader title="BAC Committee"
        description="The Head designates the members. Record each designation here with the office order that made it."
        actions={!showForm && active.length < (status.seats || 5) && (
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => setShowForm(true)}>
            <UserPlus size={13} /> Record designation
          </button>
        )} />

      <div className={`bac-note${status.workflow_enabled ? ' bac-note--success' : ''}`} role="status">
        <Landmark size={16} aria-hidden="true" />
        <div>
          <strong>{status.workflow_enabled ? 'The BAC Committee workflow is on'
            : 'The BAC Committee workflow is off'}</strong>
          <p>{status.workflow_enabled
            ? 'The committee evaluates bids and votes on the award. The Head approves it.'
            : 'Bids are still evaluated and awarded the original way. Set up the five seats here first; the workflow is switched on in the server settings (BAC_WORKFLOW_ENABLED).'}</p>
        </div>
        <div className="bac-seats" aria-label={`${active.length} of ${status.seats || 5} seats filled`} style={{ marginLeft: 'auto' }}>
          {Array.from({ length: status.seats || 5 }).map((_, i) => (
            <span key={i} className={`bac-seat${i < active.length ? ' is-filled' : ''}`} />
          ))}
        </div>
      </div>

      {showForm && (
        <form className="bac-card" onSubmit={record} aria-labelledby="des-h">
          <div className="bac-card-head"><div>
            <h3 id="des-h">Record a designation</h3>
            <p>Only an active BAC Committee account can be seated. Create it under Users first.</p>
          </div></div>
          <div className="bac-card-body">
            <div className="bac-form">
              <div className="bac-field">
                <label htmlFor="des-user">Member</label>
                <select id="des-user" value={form.user} onChange={set('user')} required>
                  <option value="">Choose a BAC Committee account</option>
                  {candidates.map(u => <option key={u.id} value={u.id}>{u.full_name || u.username} ({u.username})</option>)}
                </select>
                {!candidates.length && <span className="bac-hint">No unseated BAC Committee accounts. Add one under Users.</span>}
              </div>
              <div className="bac-field">
                <label htmlFor="des-pos">Position</label>
                <select id="des-pos" value={form.position} onChange={set('position')}>
                  {POSITIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div className="bac-field">
                <label htmlFor="des-date">Designated on</label>
                <input id="des-date" type="date" value={form.designated_on} onChange={set('designated_on')} required />
              </div>
              <div className="bac-field">
                <label htmlFor="des-ref">Office Order / Memo No.</label>
                <input id="des-ref" value={form.designation_reference} onChange={set('designation_reference')}
                  placeholder="e.g. Office Order No. 2026-014" required />
              </div>
              <div className="bac-field full">
                <label htmlFor="des-file">Scanned office order (optional)</label>
                <input id="des-file" type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => setFile(e.target.files?.[0] || null)} />
              </div>
            </div>
            {error && <p className="bac-error" role="alert">{error}</p>}
            <div className="bac-actions">
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { setShowForm(false); setError('') }}>Cancel</button>
              <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={saving}>{saving ? 'Saving…' : 'Record designation'}</button>
            </div>
          </div>
        </form>
      )}

      <section className="bac-card" aria-labelledby="seats-h">
        <div className="bac-card-head"><div>
          <h3 id="seats-h">Current members</h3>
          <p>{active.length} of {status.seats || 5} seats filled. A decision needs {status.majority || 3} votes.</p>
        </div></div>
        {loading ? <div className="bac-card-body"><ListSkeleton rows={3} /></div>
          : !active.length ? <EmptyState icon={Landmark} title="No members recorded"
            description="Record the five designations to set up the committee." />
            : (
              <div className="bac-table-wrap">
                <table className="bac-table">
                  <caption className="sr-only">Current BAC Committee members</caption>
                  <thead><tr><th scope="col">Member</th><th scope="col">Position</th><th scope="col">Designation</th>
                    <th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {active.map(s => (
                      <tr key={s.id}>
                        <td><strong>{s.name}</strong><div className="bac-hint">{s.username}</div></td>
                        <td><StatusBadge tone={s.position === 'member' ? 'neutral' : 'info'} label={s.position_label} /></td>
                        <td>
                          {s.designation_reference}
                          <div className="bac-hint">since {fmtDate(s.designated_on)} · recorded by {s.recorded_by_name || 'system'}
                            {s.designation_document_url && <> · <a href={s.designation_document_url}>office order</a></>}</div>
                        </td>
                        <td>
                          <div className="bac-actions">
                            <button type="button" className="ui-btn ui-btn--danger-outline ui-btn--sm"
                              onClick={() => setEnding({ seat: s, reason: '', date: today() })}>
                              <UserMinus size={13} /> End designation
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </section>

      {ending && (
        <form className="bac-card" onSubmit={endSeat} aria-labelledby="end-h">
          <div className="bac-card-head"><div>
            <h3 id="end-h">End {ending.seat.name}&apos;s designation</h3>
            <p>Their evaluations, votes and comments stay in the BAC Records, marked as a former member.</p>
          </div></div>
          <div className="bac-card-body">
            <div className="bac-form">
              <div className="bac-field">
                <label htmlFor="end-reason">Reason</label>
                <input id="end-reason" value={ending.reason} onChange={e => setEnding(x => ({ ...x, reason: e.target.value }))}
                  placeholder="e.g. Resigned, End of term" required />
              </div>
              <div className="bac-field">
                <label htmlFor="end-date">Ended on</label>
                <input id="end-date" type="date" value={ending.date} onChange={e => setEnding(x => ({ ...x, date: e.target.value }))} required />
              </div>
            </div>
            <div className="bac-actions">
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setEnding(null)}>Cancel</button>
              <button type="submit" className="ui-btn ui-btn--danger ui-btn--sm">End designation</button>
            </div>
          </div>
        </form>
      )}

      {former.length > 0 && (
        <section className="bac-card" aria-labelledby="former-h">
          <div className="bac-card-head"><div><h3 id="former-h">Former members</h3></div></div>
          <div className="bac-table-wrap">
            <table className="bac-table">
              <caption className="sr-only">Former BAC Committee members</caption>
              <thead><tr><th scope="col">Member</th><th scope="col">Position</th><th scope="col">Served</th><th scope="col">Reason</th></tr></thead>
              <tbody>
                {former.map(s => (
                  <tr key={s.id}>
                    <td>{s.name}</td><td>{s.position_label}</td>
                    <td>{fmtDate(s.designated_on)} to {fmtDate(s.ended_on)}</td><td>{s.end_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
