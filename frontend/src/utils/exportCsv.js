// CSV export for the report pages (Admin Reports, Supplier report). Split from
// exportReport.js so exporting a CSV doesn't download jsPDF; the PDF export
// is loaded on demand (`await import('./exportReport')`) when someone clicks it.
import { csvCell } from './csv'

export const today = () => new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Every cell — including titles and headings — goes through csvCell, which
// also neutralises spreadsheet formulas (see utils/csv.js).
export function exportReportCSV({ title, stats = [], sections = [] }, filename) {
  const lines = [csvCell(title), `Generated ${today()}`, '']

  if (stats.length) {
    lines.push(...stats.map(({ label, value }) => `${csvCell(label)},${csvCell(value)}`))
    lines.push('')
  }

  for (const { heading, columns, rows } of sections) {
    lines.push(csvCell(heading))
    lines.push(columns.map(csvCell).join(','))
    if (rows.length === 0) {
      lines.push('No data.')
    } else {
      for (const row of rows) lines.push(row.map(csvCell).join(','))
    }
    lines.push('')
  }

  triggerDownload(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), filename)
}
