// Export a report as PDF, downloading jsPDF (~140 kB gzip) only when someone
// clicks the button. `busy` is true from the click until the file is saved, so
// the button can show it is working while the library loads.
import { useCallback, useRef, useState } from 'react'
import { toast } from '../components/ui/Toaster'

export function usePdfExport() {
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const exportPdf = useCallback(async (report, filename) => {
    if (running.current) return
    running.current = true
    setBusy(true)
    try {
      const { exportReportPDF } = await import('./exportReport')
      exportReportPDF(report, filename)
    } catch {
      toast.error('Could not prepare the PDF. Check your connection and try again.')
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [])
  return { busy, exportPdf }
}
