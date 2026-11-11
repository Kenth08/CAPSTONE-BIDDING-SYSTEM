import './pageStyles'
import { lazy, Suspense } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import { getToken, getRole } from './api'
import { PageSkeleton } from './components/Skeleton'

// Each page group is its own download, so nobody waits for the code of a role they
// don't have. The first two pages above are where most visits start.
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))
const SupplierDashboard = lazy(() => import('./pages/SupplierDashboard'))
const HeadDashboard = lazy(() => import('./pages/HeadDashboard'))
const BacDashboard = lazy(() => import('./pages/BacDashboard'))
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'))
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage'))
const SupplierRegister = lazy(() => import('./pages/SupplierRegister'))
const PublicResultsPage = lazy(() => import('./pages/PublicResultsPage'))
const PublicProcurementPage = lazy(() => import('./pages/PublicProcurementPage'))
const PublicAnchorDetailPage = lazy(() =>
  import('./components/AnchorDetail').then((m) => ({ default: m.PublicAnchorDetailPage })))
const TermsPage = lazy(() => import('./pages/TermsPage'))
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'))

// A deploy replaces these files, so a tab left open can ask for one that no longer
// exists. Reload to get the new version, at most once a minute so a real outage
// doesn't become a reload loop.
const RELOADED_AT = 'chunk-reload-at'
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', () => {
    let last = 0
    try { last = Number(sessionStorage.getItem(RELOADED_AT)) || 0 } catch { /* blocked storage */ }
    if (Date.now() - last < 60_000) return
    try { sessionStorage.setItem(RELOADED_AT, String(Date.now())) } catch { /* blocked storage */ }
    window.location.reload()
  })
}

function ProtectedRoute({ children, role }) {
  const token = getToken()
  const savedRole = getRole()
  if (!token) return <Navigate to="/login" replace />
  if (savedRole !== role) return <Navigate to={`/${savedRole}`} replace />
  return children
}

function App() {
  return (
    <Router>
      <Suspense fallback={<PageSkeleton full />}>
        <Routes>
          <Route path="/"           element={<LandingPage />} />
          <Route path="/login"      element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password"  element={<ResetPasswordPage />} />
          <Route path="/verify-email"    element={<VerifyEmailPage />} />
          <Route path="/register"   element={<SupplierRegister />} />
          <Route path="/public"     element={<PublicResultsPage />} />
          <Route path="/public/procurement/:code" element={<PublicProcurementPage />} />
          <Route path="/public/procurement/:code/record/:anchorId" element={<PublicAnchorDetailPage />} />
          <Route path="/terms"      element={<TermsPage />} />
          <Route path="/privacy"    element={<PrivacyPage />} />
          <Route path="/admin/*"    element={<ProtectedRoute role="admin"><AdminDashboard /></ProtectedRoute>} />
          <Route path="/supplier/*" element={<ProtectedRoute role="supplier"><SupplierDashboard /></ProtectedRoute>} />
          <Route path="/head/*"     element={<ProtectedRoute role="head"><HeadDashboard /></ProtectedRoute>} />
          {/* Separation of duties: Procurement Staff share the Admin's
              procurement screens under /staff; the BAC Committee has its own. */}
          <Route path="/staff/*"    element={<ProtectedRoute role="staff"><AdminDashboard workspace="staff" /></ProtectedRoute>} />
          <Route path="/bac/*"      element={<ProtectedRoute role="bac"><BacDashboard /></ProtectedRoute>} />
        </Routes>
      </Suspense>
    </Router>
  )
}

export default App
