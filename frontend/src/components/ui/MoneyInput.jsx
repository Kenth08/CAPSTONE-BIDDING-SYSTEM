// A peso amount field: the ₱ sign is always shown in front of the number (not
// just in the placeholder), and thousands get commas as the user types, e.g.
// "₱ 1,250,000.50". The value handed to onChange is that formatted text;
// parseBudget (store/projectsStore.js) keeps only the digits and the point.
import { formatPesoInput } from '../../utils/inputFormat'
import '../../style/money-input.css'

export default function MoneyInput({ id, value, onChange, placeholder = '50,000', required, ...rest }) {
  return (
    <div className="money-input">
      <span className="money-input-sign" aria-hidden="true">₱</span>
      <input id={id} inputMode="decimal" autoComplete="off" value={value} required={required}
        placeholder={placeholder} aria-describedby={id ? `${id}-cur` : undefined}
        onChange={e => onChange(formatPesoInput(e.target.value))} {...rest} />
      {id && <span id={`${id}-cur`} className="sr-only">Amount in Philippine pesos</span>}
    </div>
  )
}
