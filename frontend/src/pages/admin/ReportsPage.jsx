import { useState, useEffect, useMemo } from 'react'
import { FolderOpen, Users, Award, BarChart2, FileText, Loader2 } from 'lucide-react'
import { apiListSuppliers, apiListAwards } from '../../api'
import { getCached, loadCached } from '../../utils/sessionCache'
import { useProjects } from '../../store/projectsStore'
import StatusBadge from '../../components/ui/StatusBadge'
import { TableEmpty } from '../../components/ui/EmptyState'
import { Skeleton, TableSkeleton } from '../../components/Skeleton'
import { exportReportCSV } from '../../utils/exportCsv'
import { usePdfExport } from '../../utils/usePdfExport'
import {
  AWARDS_CACHE, SUPPLIERS_CACHE, fmtDate, peso,
} from './shared'

const QUAL_LABEL = {
  verified: 'Verified',
  waiting_admin_approval: 'Waiting Admin Approval',
  needs_revision: 'Needs Revision',
  rejected: 'Rejected',
}
// ── Reports Page ──────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { projects, loaded: projectsLoaded, error: projectsError } = useProjects()
  // Shown at once from the Awards / Suppliers pages' cache, then refreshed.
  const [awards, setAwards] = useState(() => getCached(AWARDS_CACHE) || [])
  const [suppliers, setSuppliers] = useState(() => getCached(SUPPLIERS_CACHE) || [])
  // Skeletons only on a first visit, while there is nothing at all to show.
  const [awardsReady, setAwardsReady] = useState(() => getCached(AWARDS_CACHE) !== undefined)
  const [suppliersReady, setSuppliersReady] = useState(() => getCached(SUPPLIERS_CACHE) !== undefined)
  const [reportTab, setReportTab] = useState('procurement')
  const { busy: pdfBusy, exportPdf } = usePdfExport()

  useEffect(() => {
    loadCached(AWARDS_CACHE, apiListAwards).then(setAwards).catch(() => {}).finally(() => setAwardsReady(true))
    loadCached(SUPPLIERS_CACHE, apiListSuppliers).then(setSuppliers).catch(() => {}).finally(() => setSuppliersReady(true))
  }, [])

  // ── Procurement report data ────────────────────────────────────────────
  // Recomputed only when the projects or awards change, not on every render
  // (switching tabs, a PDF export starting).
  const { typeCount, procurementStats, procurementReportShape } = useMemo(() => {
    const totalProjects  = projects.length
    const activePrj      = projects.filter(p => p.status === 'published' || p.status === 'active').length
    const awardedPrj     = projects.filter(p => p.status === 'awarded').length
    const totalBids       = projects.reduce((s, p) => s + p.bids, 0)
    const awardedAmount  = awards.reduce((sum, a) => sum + Number(a.amount || 0), 0)

    const typeCount = projects.reduce((acc, p) => {
      acc[p.type] = (acc[p.type] || 0) + 1
      return acc
    }, {})

    const procurementStats = [
      { label: 'TOTAL PROJECTS', value: totalProjects, cls: ''              },
      { label: 'ACTIVE',          value: activePrj,    cls: 'ad-val-blue'   },
      { label: 'AWARDED',         value: awardedPrj,   cls: 'ad-val-purple' },
      { label: 'TOTAL BIDS',      value: totalBids,    cls: 'ad-val-yellow' },
      { label: 'AWARDED AMOUNT',  value: peso(awardedAmount), cls: 'ad-val-green' },
    ]

    const procurementReportShape = {
      title: 'Procurement Report',
      stats: procurementStats.map(({ label, value }) => ({ label, value })),
      sections: [
        {
          heading: 'By Procurement Type',
          columns: ['Type', 'Count'],
          rows: Object.entries(typeCount).map(([type, count]) => [type, count]),
        },
        {
          heading: 'Recent Awards',
          columns: ['Project', 'Winner', 'Amount', 'Date'],
          rows: awards.map(a => [a.project_name, a.supplier_name, peso(a.amount), fmtDate(a.awarded_at)]),
        },
      ],
    }
    return { typeCount, procurementStats, procurementReportShape }
  }, [projects, awards])

  // ── Supplier report data ───────────────────────────────────────────────
  const { supplierAwardStats, categoryCount, supplierStats, supplierReportShape } = useMemo(() => {
    const totalSuppliers = suppliers.length
    const verifiedSup    = suppliers.filter(s => s.qualification_status === 'verified').length
    const pendingSup      = suppliers.filter(s =>
      s.qualification_status === 'waiting_admin_approval' || s.qualification_status === 'needs_revision').length
    const rejectedSup    = suppliers.filter(s => s.qualification_status === 'rejected').length

    // Awards grouped by supplier in one pass (was a scan of every award per supplier).
    const wonBy = new Map()
    for (const a of awards) {
      const w = wonBy.get(a.supplier) || { count: 0, amount: 0 }
      w.count += 1
      w.amount += Number(a.amount || 0)
      wonBy.set(a.supplier, w)
    }
    const supplierAwardStats = suppliers.reduce((acc, s) => {
      acc[s.id] = wonBy.get(s.id) || { count: 0, amount: 0 }
      return acc
    }, {})
    const awardedSupCount = Object.values(supplierAwardStats).filter(v => v.count > 0).length

    const categoryCount = suppliers.reduce((acc, s) => {
      for (const cat of (s.business_types || [])) acc[cat] = (acc[cat] || 0) + 1
      return acc
    }, {})

    const supplierStats = [
      { label: 'TOTAL SUPPLIERS', value: totalSuppliers, cls: ''              },
      { label: 'VERIFIED',         value: verifiedSup,    cls: 'ad-val-green'  },
      { label: 'PENDING REVIEW',  value: pendingSup,     cls: 'ad-val-yellow' },
      { label: 'REJECTED',         value: rejectedSup,    cls: 'ad-val-red'    },
      { label: 'WITH AWARDS',     value: awardedSupCount, cls: 'ad-val-purple' },
    ]

    const supplierReportShape = {
      title: 'Supplier Report',
      stats: supplierStats.map(({ label, value }) => ({ label, value })),
      sections: [
        {
          heading: 'By Business Category',
          columns: ['Category', 'Suppliers'],
          rows: Object.entries(categoryCount).map(([cat, count]) => [cat, count]),
        },
        {
          heading: 'Supplier Directory',
          columns: ['Company', 'Qualification Status', 'Registered', 'Contracts Won', 'Awarded Amount'],
          rows: suppliers.map(s => [
            s.company,
            QUAL_LABEL[s.qualification_status] || s.qualification_status,
            fmtDate(s.registered),
            supplierAwardStats[s.id]?.count || 0,
            peso(supplierAwardStats[s.id]?.amount || 0),
          ]),
        },
      ],
    }
    return { supplierAwardStats, categoryCount, supplierStats, supplierReportShape }
  }, [suppliers, awards])

  const projectsPending = !projectsLoaded && !projectsError && projects.length === 0
  const procurementLoading = projectsPending || !awardsReady
  const supplierLoading = !suppliersReady || !awardsReady

  const activeReport = reportTab === 'procurement' ? procurementReportShape : supplierReportShape

  return (
    <div className="ad-content">
      <div className="ad-report-bar">
        <div className="ad-report-tabs" role="tablist" aria-label="Report type">
          <button
            role="tab"
            aria-selected={reportTab === 'procurement'}
            className={`ad-report-tab${reportTab === 'procurement' ? ' active' : ''}`}
            onClick={() => setReportTab('procurement')}
          ><FolderOpen size={14} aria-hidden="true" /> Procurement Report</button>
          <button
            role="tab"
            aria-selected={reportTab === 'supplier'}
            className={`ad-report-tab${reportTab === 'supplier' ? ' active' : ''}`}
            onClick={() => setReportTab('supplier')}
          ><Users size={14} aria-hidden="true" /> Supplier Report</button>
        </div>
        <div className="ad-export-btns">
          <button
            className="ad-btn-export-csv"
            onClick={() => exportReportCSV(activeReport, `${reportTab}-report-${new Date().toISOString().slice(0, 10)}.csv`)}
          ><FileText size={14} aria-hidden="true" /> Export CSV</button>
          <button
            className="ad-btn-primary"
            disabled={pdfBusy}
            aria-busy={pdfBusy}
            onClick={() => exportPdf(activeReport, `${reportTab}-report-${new Date().toISOString().slice(0, 10)}.pdf`)}
          >{pdfBusy
            ? <><Loader2 size={14} className="ui-spin" aria-hidden="true" /> Preparing PDF…</>
            : <><FileText size={14} aria-hidden="true" /> Export PDF</>}</button>
        </div>
      </div>

      {reportTab === 'procurement' && (
        <>
          <div className="ad-report-stats">
            {procurementStats.map(({ label, value, cls }) => (
              <div className="ad-stat-card" key={label}>
                <div className="ad-stat-label">{label}</div>
                <div className="ad-stat-value ad-stat-value-sm">{procurementLoading ? <Skeleton width={64} height={18} /> : value}</div>
              </div>
            ))}
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>By Procurement Type</h2></div>
            <table className="ad-table">
              <thead><tr><th>Type</th><th className="ad-num">Count</th></tr></thead>
              <tbody>
                {projectsPending ? <TableSkeleton rows={3} cols={2} />
                : Object.keys(typeCount).length === 0 ? (
                  <TableEmpty colSpan={2} icon={BarChart2} title="No data yet" description="Numbers appear here as projects and suppliers are added." />
                ) : Object.entries(typeCount).map(([type, count]) => (
                  <tr key={type}><td>{type}</td><td className="ad-num">{count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>Recent Awards</h2></div>
            <table className="ad-table">
              <thead><tr><th>Project</th><th>Winner</th><th className="ad-num">Amount</th><th>Date</th></tr></thead>
              <tbody>
                {!awardsReady ? <TableSkeleton rows={3} cols={4} />
                : awards.length === 0 ? (
                  <TableEmpty colSpan={4} icon={Award} title="No awards yet" description="Awarded contracts will be summarised here." />
                ) : awards.map(a => (
                  <tr key={a.id}>
                    <td>{a.project_name}</td>
                    <td>{a.supplier_name}</td>
                    <td className="ad-num">{peso(a.amount)}</td>
                    <td className="ad-muted ad-nowrap">{fmtDate(a.awarded_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {reportTab === 'supplier' && (
        <>
          <div className="ad-report-stats">
            {supplierStats.map(({ label, value, cls }) => (
              <div className="ad-stat-card" key={label}>
                <div className="ad-stat-label">{label}</div>
                <div className="ad-stat-value ad-stat-value-sm">{supplierLoading ? <Skeleton width={64} height={18} /> : value}</div>
              </div>
            ))}
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>By Business Category</h2></div>
            <table className="ad-table">
              <thead><tr><th>Category</th><th className="ad-num">Suppliers</th></tr></thead>
              <tbody>
                {!suppliersReady ? <TableSkeleton rows={3} cols={2} />
                : Object.keys(categoryCount).length === 0 ? (
                  <TableEmpty colSpan={2} icon={BarChart2} title="No data yet" description="Numbers appear here as projects and suppliers are added." />
                ) : Object.entries(categoryCount).map(([cat, count]) => (
                  <tr key={cat}><td>{cat}</td><td className="ad-num">{count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ad-card">
            <div className="ad-card-header"><h2>Supplier Directory</h2></div>
            <div className="ad-x-scroll">
            <table className="ad-table">
              <thead>
                <tr>
                  <th>Company</th><th>Qualification Status</th><th>Registered</th>
                  <th className="ad-num">Contracts Won</th><th className="ad-num">Awarded Amount</th>
                </tr>
              </thead>
              <tbody>
                {!suppliersReady ? <TableSkeleton rows={4} cols={5} />
                : suppliers.length === 0 ? (
                  <TableEmpty colSpan={5} icon={Users} title="No suppliers yet" description="Registered suppliers will be listed here." />
                ) : suppliers.map(s => (
                  <tr key={s.id}>
                    <td className="ad-bold">{s.company}</td>
                    <td><StatusBadge domain="qualification" status={s.qualification_status} /></td>
                    <td className="ad-muted">{fmtDate(s.registered)}</td>
                    <td className="ad-num">{supplierAwardStats[s.id]?.count || 0}</td>
                    <td className="ad-num">{peso(supplierAwardStats[s.id]?.amount || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
