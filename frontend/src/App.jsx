import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import AdminDashboard from './pages/AdminDashboard'
import SupplierDashboard from './pages/SupplierDashboard'
import HeadDashboard from './pages/HeadDashboard'
import LoginPage from './pages/LoginPage'

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/admin/*" element={<AdminDashboard />} />
        <Route path="/supplier/*" element={<SupplierDashboard />} />
        <Route path="/head/*" element={<HeadDashboard />} />
      </Routes>
    </Router>
  )
}

export default App
