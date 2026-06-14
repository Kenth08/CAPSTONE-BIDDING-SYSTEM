// Single source of truth for procurement / business categories.
// Used BOTH by supplier registration (a supplier may select several) and by the
// procurement creation form (a project has exactly one category). Supplier
// eligibility to bid = the project's category is in the supplier's categories.
// Keep this list in sync with PROCUREMENT_CATEGORIES in backend/procurement/models.py.
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
