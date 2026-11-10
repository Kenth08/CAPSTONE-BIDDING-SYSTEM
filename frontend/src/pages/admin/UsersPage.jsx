// Admin ▸ Users: the procuring entity's accounts (backend accounts/user_admin.py).
// The Admin creates Procurement Staff, BAC Committee and Head accounts, and
// deactivates them. Accounts are never deleted (their records stay attributed),
// roles never change, and Admin accounts are listed read-only.
import { useEffect, useState } from 'react'
import { Lock, UserCheck, UserPlus, UserX } from 'lucide-react'
import { apiCreateManagedUser, apiListManagedUsers, apiUnlockAccount, apiUpdateManagedUser } from '../../api'
import PageHeader from '../../components/ui/PageHeader'
import StatusBadge from '../../components/ui/StatusBadge'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { ListSkeleton } from '../../components/Skeleton'
import { toast } from '../../components/ui/Toaster'
import { fmtDateTime } from '../../utils/format'
import '../../style/bac.css'

const ROLES = [
  { value: 'staff', label: 'Procurement Staff' },
  { value: 'bac', label: 'BAC Committee' },
  { value: 'head', label: 'Head' },
]
const EMPTY = { username: '', full_name: '', email: '', role: 'staff', password: '' }

export default function UsersPage() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(EMPTY)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(null)   // { user, activate }
  const [busyId, setBusyId] = useState(null)

  const load = () => apiListManagedUsers().then(setUsers)
    .catch(e => toast.error(e.message || 'Could not load the accounts.'))
    .finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const create = async (e) => {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const user = await apiCreateManagedUser(form)
      toast.success(`${user.role_label} account ${user.username} created. Give them the temporary password and ask them to change it.`)
      setForm(EMPTY); setShowForm(false)
      load()
    } catch (err) {
      setError(err.message || 'Could not create the account.')
    } finally {
      setSaving(false)
    }
  }

  const setActive = async (user, active) => {
    setBusyId(user.id)
    try {
      await apiUpdateManagedUser(user.id, { is_active: active })
      toast.success(`${user.username} ${active ? 'reactivated' : 'deactivated'}.`)
      load()
    } catch (err) {
      toast.error(err.message || 'Could not change the account.')
    } finally {
      setBusyId(null)
    }
  }

  const unlock = async (user) => {
    setBusyId(user.id)
    try {
      const res = await apiUnlockAccount(user.id)
      toast.success(res.detail || `${user.username} unlocked.`)
      load()
    } catch (err) {
      toast.error(err.message || 'Could not unlock the account.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="bac-page ad-content">
      <PageHeader title="Users"
        description="Accounts of the procuring entity. Suppliers register themselves and are reviewed under Suppliers."
        actions={!showForm && (
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => setShowForm(true)}>
            <UserPlus size={13} /> Add account
          </button>
        )} />

      {showForm && (
        <form className="bac-card" onSubmit={create} aria-labelledby="new-user-h">
          <div className="bac-card-head">
            <div>
              <h3 id="new-user-h">New account</h3>
              <p>A BAC Committee account needs a designation under BAC Committee before it can evaluate or vote.</p>
            </div>
          </div>
          <div className="bac-card-body">
            <div className="bac-form">
              <div className="bac-field">
                <label htmlFor="nu-role">Role</label>
                <select id="nu-role" value={form.role} onChange={set('role')}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div className="bac-field">
                <label htmlFor="nu-name">Full name</label>
                <input id="nu-name" value={form.full_name} onChange={set('full_name')} required autoComplete="off" />
              </div>
              <div className="bac-field">
                <label htmlFor="nu-user">Username</label>
                <input id="nu-user" value={form.username} onChange={set('username')} required autoComplete="off" />
              </div>
              <div className="bac-field">
                <label htmlFor="nu-email">Email</label>
                <input id="nu-email" type="email" value={form.email} onChange={set('email')} required autoComplete="off" />
              </div>
              <div className="bac-field">
                <label htmlFor="nu-pw">Temporary password</label>
                <input id="nu-pw" type="text" value={form.password} onChange={set('password')} required autoComplete="new-password" />
                <span className="bac-hint">At least 8 characters, not common or all numbers.</span>
              </div>
            </div>
            {error && <p className="bac-error" role="alert">{error}</p>}
            <div className="bac-actions">
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { setShowForm(false); setError('') }}>Cancel</button>
              <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={saving}>
                {saving ? 'Creating…' : 'Create account'}
              </button>
            </div>
          </div>
        </form>
      )}

      <section className="bac-card" aria-label="Accounts">
        {loading ? <div className="bac-card-body"><ListSkeleton rows={5} /></div> : (
          <div className="bac-table-wrap">
            <table className="bac-table">
              <caption className="sr-only">Accounts</caption>
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Status</th>
                  <th scope="col">Last sign-in</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.full_name || u.username}</strong>
                      <div className="bac-hint">{u.username} · {u.email}</div>
                    </td>
                    <td>
                      {u.role_label}
                      {u.bac_position && <div className="bac-hint">{u.bac_position}</div>}
                    </td>
                    <td>
                      {u.is_active ? <StatusBadge tone="success" label="Active" /> : <StatusBadge tone="neutral" label="Deactivated" />}
                      {u.locked && <div><StatusBadge tone="warning" label="Locked" /></div>}
                    </td>
                    <td className="bac-hint">{u.last_login ? fmtDateTime(u.last_login) : 'Never'}</td>
                    <td>
                      {u.role !== 'admin' && (
                        <div className="bac-actions">
                          {u.locked && (
                            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busyId === u.id} onClick={() => unlock(u)}>
                              <Lock size={13} /> Unlock
                            </button>
                          )}
                          {u.is_active ? (
                            <button type="button" className="ui-btn ui-btn--danger-outline ui-btn--sm" disabled={busyId === u.id}
                              onClick={() => setConfirm({ user: u, activate: false })}>
                              <UserX size={13} /> Deactivate
                            </button>
                          ) : (
                            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busyId === u.id}
                              onClick={() => setConfirm({ user: u, activate: true })}>
                              <UserCheck size={13} /> Reactivate
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirm && (
        <ConfirmDialog
          title={`${confirm.activate ? 'Reactivate' : 'Deactivate'} ${confirm.user.username}?`}
          tone={confirm.activate ? 'primary' : 'danger'}
          confirmLabel={confirm.activate ? 'Reactivate' : 'Deactivate'}
          points={confirm.activate
            ? ['They can sign in again with their current password.']
            : ['They can no longer sign in.', 'Their past actions, evaluations and votes stay on the record.',
              'A BAC Committee member must have their designation ended first.']}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); setActive(c.user, c.activate) }}
        />
      )}
    </div>
  )
}
