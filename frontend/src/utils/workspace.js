// Which office dashboard is open, and whether separation of duties is on.
//
// The Admin and the Procurement Staff share the procurement screens in
// pages/AdminDashboard.jsx: the Admin's at /admin/..., the Staff's at
// /staff/.... `ws('/projects')` builds a link inside whichever of the two is
// open, so a screen never sends Staff to an Admin URL (which would bounce them
// back to their own dashboard).
//
// `useBacStatus()` reads GET /api/bac/status/: whether the backend's
// BAC_WORKFLOW_ENABLED switch is on, and the caller's BAC seat. While it is
// off, everything works the original way and the Admin keeps every action.
import { useEffect, useState } from 'react'
import { apiBacStatus, getRole } from '../api'

export function workspaceBase() {
  return window.location.pathname.startsWith('/staff') ? '/staff' : '/admin'
}

export const ws = (path = '') => `${workspaceBase()}${path}`

// Turns a notification link written for the Admin (/admin/...) into the same
// page in the Staff dashboard when a Staff account follows it.
export function linkForRole(link) {
  if (!link) return link
  if (getRole() === 'staff' && link.startsWith('/admin')) return `/staff${link.slice('/admin'.length)}`
  return link
}

const OFF = { workflow_enabled: false, membership: null, seats: 5, majority: 3, active_members: 0 }

export function useBacStatus() {
  const [status, setStatus] = useState({ ...OFF, loading: true })
  useEffect(() => {
    let alive = true
    apiBacStatus()
      .then(s => { if (alive) setStatus({ ...OFF, ...s, loading: false }) })
      // Can't tell: behave as before (switch off). The server refuses anything
      // a role may not do whatever the page shows.
      .catch(() => { if (alive) setStatus({ ...OFF, loading: false }) })
    return () => { alive = false }
  }, [])
  return status
}

// May this account prepare and publish procurements (create, submit,
// publish, issue NOA/NTP)? Staff always; the Admin only while the switch is off.
export function canPrepare(role, workflowOn) {
  return role === 'staff' || (role === 'admin' && !workflowOn)
}
