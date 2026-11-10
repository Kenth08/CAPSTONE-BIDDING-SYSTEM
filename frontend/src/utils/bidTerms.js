// Delivery timeline and warranty period choices (backend procurement/bid_terms.py).
// Staff pick which of these a procurement offers; bidders choose from that list.
export const DELIVERY_DAY_PRESETS = [7, 15, 30, 45, 60, 90, 120, 180, 270, 365]
export const WARRANTY_MONTH_PRESETS = [3, 6, 12, 18, 24, 36, 60]

export const deliveryLabel = (days) => `${days} calendar day${days === 1 ? '' : 's'}`

export function warrantyLabel(months) {
  if (months % 12 === 0) {
    const years = months / 12
    return `${years} year${years === 1 ? '' : 's'}`
  }
  return `${months} month${months === 1 ? '' : 's'}`
}

// Delivery presets that fit inside the procurement's delivery period (if set).
export const deliveryPresetsFor = (periodDays) =>
  DELIVERY_DAY_PRESETS.filter(d => !Number(periodDays) || d <= Number(periodDays))
