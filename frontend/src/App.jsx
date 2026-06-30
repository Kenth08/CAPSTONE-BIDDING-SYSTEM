import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import AdminDashboard from './pages/AdminDashboard'
import SupplierDashboard from './pages/SupplierDashboard'
import HeadDashboard from './pages/HeadDashboard'
import LoginPage from './pages/LoginPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import VerifyEmailPage from './pages/VerifyEmailPage'
import SupplierRegister from './pages/SupplierRegister'
import PublicResultsPage from './pages/PublicResultsPage'
import TermsPage from './pages/TermsPage'
import PrivacyPage from './pages/PrivacyPage'
import { getToken, getRole } from './api'

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
      <Routes>
        <Route path="/"           element={<LandingPage />} />
        <Route path="/login"      element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password"  element={<ResetPasswordPage />} />
        <Route path="/verify-email"    element={<VerifyEmailPage />} />
        <Route path="/register"   element={<SupplierRegister />} />
        <Route path="/public"     element={<PublicResultsPage />} />
        <Route path="/terms"      element={<TermsPage />} />
        <Route path="/privacy"    element={<PrivacyPage />} />
        <Route path="/admin/*"    element={<ProtectedRoute role="admin"><AdminDashboard /></ProtectedRoute>} />
        <Route path="/supplier/*" element={<ProtectedRoute role="supplier"><SupplierDashboard /></ProtectedRoute>} />
        <Route path="/head/*"     element={<ProtectedRoute role="head"><HeadDashboard /></ProtectedRoute>} />
      </Routes>
    </Router>
  )
}

export default App
