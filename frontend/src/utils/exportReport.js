// Shared CSV/PDF export for the Admin Reports page. Both the Procurement and
// Supplier report tabs build the same shape — { title, stats, sections } —
// and hand it to one of these so the export logic isn't duplicated per tab.
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

const today = () => new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

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

// Escape a value for a CSV cell (wrap in quotes, double up any embedded quotes).
function csvCell(value) {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportReportCSV({ title, stats = [], sections = [] }, filename) {
  const lines = [title, `Generated ${today()}`, '']

  if (stats.length) {
    lines.push(...stats.map(({ label, value }) => `${csvCell(label)},${csvCell(value)}`))
    lines.push('')
  }

  for (const { heading, columns, rows } of sections) {
    lines.push(heading)
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

export function exportReportPDF({ title, stats = [], sections = [] }, filename) {
  const doc = new jsPDF()
  const marginX = 14
  let y = 16

  doc.setFontSize(16)
  doc.text(title, marginX, y)
  y += 7
  doc.setFontSize(10)
  doc.setTextColor(120)
  doc.text(`Generated ${today()}`, marginX, y)
  doc.setTextColor(0)
  y += 6

  if (stats.length) {
    autoTable(doc, {
      startY: y,
      head: [stats.map(s => s.label)],
      body: [stats.map(s => String(s.value))],
      theme: 'grid',
      styles: { fontSize: 9, halign: 'center' },
      headStyles: { fillColor: [16, 185, 129] },
    })
    y = doc.lastAutoTable.finalY + 8
  }

  for (const { heading, columns, rows } of sections) {
    doc.setFontSize(12)
    doc.text(heading, marginX, y)
    y += 4
    autoTable(doc, {
      startY: y,
      head: [columns],
      body: rows.length ? rows : [columns.map(() => '—')],
      theme: 'striped',
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
      margin: { left: marginX, right: marginX },
    })
    y = doc.lastAutoTable.finalY + 10
  }

  doc.save(filename)
}
