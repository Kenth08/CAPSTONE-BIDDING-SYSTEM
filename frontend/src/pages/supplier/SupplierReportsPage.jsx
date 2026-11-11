import { Link } from 'react-router-dom'
import { FileText, BarChart2, Loader2 } from 'lucide-react'
import StatusBadge from '../../components/ui/StatusBadge'
import { TableEmpty } from '../../components/ui/EmptyState'
import { exportReportCSV } from '../../utils/exportCsv'
import { usePdfExport } from '../../utils/usePdfExport'
import {
  BID_LABEL, fmtPeso,
} from './shared'

export default function SupplierReportsPage({ bids, profile }) {
  const { busy: pdfBusy, exportPdf } = usePdfExport()
  const totalBids   = bids.length
  const underReview = bids.filter(b => b.status === 'under_review').length
  const qualified   = bids.filter(b => b.status === 'qualified').length
  const won         = bids.filter(b => b.status === 'winner').length
  const awardedValue = bids.filter(b => b.status === 'winner').reduce((s, b) => s + b.amountRaw, 0)

  const stats = [
    { label: 'TOTAL BIDS',     value: totalBids,            cls: ''             },
    { label: 'UNDER REVIEW',   value: underReview,          cls: 'sd-val-yellow' },
    { label: 'QUALIFIED',      value: qualified,            cls: 'sd-val-blue'   },
    { label: 'WON',            value: won,                  cls: 'sd-val-purple' },
    { label: 'AWARDED VALUE',  value: fmtPeso(awardedValue), cls: 'sd-val-green'  },
  ]

  const categoryCount = bids.reduce((acc, b) => {
    const key = b.category || 'Uncategorized'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})

  const reportShape = {
    title: 'My Bidding Report',
    stats: stats.map(({ label, value }) => ({ label, value })),
    sections: [
      {
        heading: 'By Category',
        columns: ['Category', 'Bids'],
        rows: Object.entries(categoryCount).map(([cat, count]) => [cat, count]),
      },
      {
        heading: 'Bid History',
        columns: ['Project', 'Amount', 'Status', 'Submitted'],
        rows: bids.map(b => [b.project, b.amount, BID_LABEL[b.status] || b.status, b.submitted]),
      },
    ],
  }

  const filename = `my-bidding-report-${new Date().toISOString().slice(0, 10)}`

  return (
    <div className="sd-content">
      <div className="sd-report-bar">
        <div>
          <h2 className="sd-bold" style={{ fontSize: 16 }}>{profile?.company || 'My'} Bidding Report</h2>
        </div>
        <div className="sd-export-btns">
          <button className="sd-btn-export-csv" onClick={() => exportReportCSV(reportShape, `${filename}.csv`)}>
            <FileText size={14} aria-hidden="true" /> Export CSV
          </button>
          <button className="sd-btn-primary" disabled={pdfBusy} aria-busy={pdfBusy} onClick={() => exportPdf(reportShape, `${filename}.pdf`)}>
            {pdfBusy
              ? <><Loader2 size={14} className="sd-spin" aria-hidden="true" /> Preparing PDF…</>
              : <><FileText size={14} aria-hidden="true" /> Export PDF</>}
          </button>
        </div>
      </div>

      <div className="sd-report-stats">
        {stats.map(({ label, value, cls }) => (
          <div className="sd-stat-card" key={label}>
            <div className="sd-stat-label">{label}</div>
            <div className="sd-stat-value sd-stat-value-sm">{value}</div>
          </div>
        ))}
      </div>

      <div className="sd-card">
        <div className="sd-card-header"><h2>By Category</h2></div>
        <table className="sd-table">
          <thead><tr><th>CATEGORY</th><th>BIDS</th></tr></thead>
          <tbody>
            {Object.keys(categoryCount).length === 0 ? (
              <TableEmpty colSpan={2} icon={BarChart2} title="No bids yet" description="Your bids will be grouped by category here." />
            ) : Object.entries(categoryCount).map(([cat, count]) => (
              <tr key={cat}><td>{cat}</td><td>{count}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sd-card">
        <div className="sd-card-header"><h2>Bid History</h2></div>
        <table className="sd-table">
          <thead><tr><th>Project</th><th className="sd-num">Amount</th><th>Status</th><th>Submitted</th></tr></thead>
          <tbody>
            {bids.length === 0 ? (
              <TableEmpty colSpan={4} icon={FileText} title="No bids yet" description="Your bid history will appear here."
                action={<Link to="/supplier/projects" className="sd-btn-cancel">Browse bid opportunities</Link>} />
            ) : bids.map(b => (
              <tr key={b.id}>
                <td className="sd-bold">{b.project}</td>
                <td className="sd-num">{b.amount}</td>
                <td><StatusBadge domain="bid" status={b.status} label={BID_LABEL[b.status]} /></td>
                <td className="sd-muted">{b.submitted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
