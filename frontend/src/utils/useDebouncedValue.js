// The value, ~200 ms after it stops changing. For search boxes: the input stays
// live while filtering a long list waits until the user pauses typing.
// Clearing ('') applies at once, so "Clear search" never lags.
import { useEffect, useState } from 'react'

export function useDebouncedValue(value, delay = 200) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (value === '' || value === settled) { setSettled(value); return undefined }
    const t = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(t)
  }, [value, delay]) // eslint-disable-line react-hooks/exhaustive-deps
  return value === '' ? '' : settled
}
