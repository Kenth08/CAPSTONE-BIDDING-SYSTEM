import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import AdminDashboard from './pages/AdminDashboard'
import SupplierDashboard from './pages/SupplierDashboard'
import HeadDashboard from './pages/HeadDashboard'
import LoginPage from './pages/LoginPage'
import SupplierRegister from './pages/SupplierRegister'
import PublicResultsPage from './pages/PublicResultsPage'
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
        <Route path="/register"   element={<SupplierRegister />} />
        <Route path="/public"     element={<PublicResultsPage />} />
        <Route path="/admin/*"    element={<ProtectedRoute role="admin"><AdminDashboard /></ProtectedRoute>} />
        <Route path="/supplier/*" element={<ProtectedRoute role="supplier"><SupplierDashboard /></ProtectedRoute>} />
        <Route path="/head/*"     element={<ProtectedRoute role="head"><HeadDashboard /></ProtectedRoute>} />
      </Routes>
    </Router>
  )
}

export default App
