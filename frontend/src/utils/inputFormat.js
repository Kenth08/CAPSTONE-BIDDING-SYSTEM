// Pure helpers for form inputs, kept free of React and CSS so `npm test` can
// import them (components/ui/MoneyInput.jsx, components/ui/LocationPicker.jsx).

// "1250000.505" -> "1,250,000.50". Keeps digits and one decimal point (two
// decimals); store/projectsStore.js parseBudget reads it back as a number.
export function formatPesoInput(raw) {
  const cleaned = String(raw ?? '').replace(/[^\d.]/g, '')
  const [whole, ...rest] = cleaned.split('.')
  const digits = whole.replace(/^0+(?=\d)/, '')
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return rest.length ? `${grouped || '0'}.${rest.join('').slice(0, 2)}` : grouped
}

// One line of delivery location text from the picked PSGC names.
export function composeLocation({ place, barangay, city, province }) {
  const brgy = barangay && (/^(barangay|brgy)/i.test(barangay) ? barangay : `Brgy. ${barangay}`)
  return [place?.trim(), brgy, city, province].filter(Boolean).join(', ')
}
