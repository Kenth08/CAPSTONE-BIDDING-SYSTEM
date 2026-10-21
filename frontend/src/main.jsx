import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './style/tokens.css'
import './index.css'
// Shared components + app shell load last so they win over page stylesheets.
import './style/app-shell.css'
import './style/ui.css'
import './style/dashboard-polish.css'
import './style/admin-polish.css'
import './style/head-polish.css'
import './style/supplier-polish.css'
import './style/public-polish.css'
// UI refresh building blocks (KpiCard, DataTable, charts, …) — last on purpose.
import './style/refresh.css'

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
