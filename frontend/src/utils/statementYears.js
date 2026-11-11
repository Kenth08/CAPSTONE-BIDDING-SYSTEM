// Years a supplier may pick for its Audited Financial Statements.
//
// Eligibility asks for the most recent audited statements, and a company may
// not have filed last year's yet early in the year, so the list is the last
// two completed calendar years, newest first. It moves forward by itself every
// January. The server applies the same rule (accounts/serializers.py,
// STATEMENT_YEARS_BACK); a value already on file is never changed.
export const STATEMENT_YEARS_BACK = 2

export function statementYearOptions(today = new Date()) {
  const current = today.getFullYear()
  return Array.from({ length: STATEMENT_YEARS_BACK }, (_, i) => current - 1 - i)
}
