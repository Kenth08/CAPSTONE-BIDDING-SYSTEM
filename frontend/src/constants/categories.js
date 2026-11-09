// Single source of truth for procurement / business categories.
// Used BOTH by supplier registration (a supplier may select several) and by the
// procurement creation form (a project has exactly one category). Supplier
// eligibility to bid = the project's category is in the supplier's categories.
// Keep this list in sync with PROCUREMENT_CATEGORIES in backend/procurement/models.py.
// The Admin can add more at runtime; read the full list with useCategories()
// (store/categoriesStore.js). This constant is only its starting value/fallback.
export const CATEGORIES = [
  'IT Equipment',
  'Office Supplies',
  'Furniture',
  'Construction',
  'Electrical Supplies',
  'Laboratory Equipment',
  'Printing Services',
  'Janitorial Supplies',
  'Food & Catering',
  'Transportation Services',
  'Medical Supplies',
  'Sports Equipment',
  'Books & Educational Materials',
]

// Collapse spacing and compare ignoring case, the same way the backend does
// (models.find_category), so "it  equipment" is recognised as "IT Equipment".
export const normalizeCategory = (name) => String(name || '').split(/\s+/).filter(Boolean).join(' ')

export function findCategory(list, name) {
  const key = normalizeCategory(name).toLowerCase()
  if (!key) return null
  return (list || []).find(c => c.toLowerCase() === key) || null
}
