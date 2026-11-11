// Delivery Location picker: Region → Province → City/Municipality → Barangay
// from the official Philippine list (PSGC, via the backend's cached proxy),
// plus the building, street or office typed by hand. The result is one line of
// text, e.g. "Supply Office, Brgy. Poblacion, City of Tagum, Davao del Norte",
// so nothing changes in how a procurement stores its delivery location.
//
// If the list can't be reached, or the user prefers, the field falls back to
// plain typing. An existing value (editing a project) opens in typing mode so
// it is never silently replaced.
import { useEffect, useState } from 'react'
import { MapPin } from 'lucide-react'
import {
  apiLocCityBarangays, apiLocProvinceCities, apiLocRegionCities, apiLocRegionProvinces, apiLocRegions,
} from '../../api'
import { composeLocation } from '../../utils/inputFormat'
import '../../style/location-picker.css'

export default function LocationPicker({ id = 'loc', value, onChange, required = true }) {
  const [mode, setMode] = useState(value ? 'type' : 'pick')
  const [error, setError] = useState('')
  const [lists, setLists] = useState({ regions: null, provinces: [], cities: [], barangays: [] })
  const [sel, setSel] = useState({ region: '', province: '', city: '', barangay: '', place: '' })
  const [noProvinces, setNoProvinces] = useState(false)
  const [loading, setLoading] = useState('')

  const fail = (e) => {
    setError(e?.message || 'The location list could not be loaded.')
    setMode('type')
  }

  useEffect(() => {
    if (mode !== 'pick' || lists.regions) return
    setLoading('regions')
    apiLocRegions().then(r => setLists(l => ({ ...l, regions: r }))).catch(fail).finally(() => setLoading(''))
  }, [mode])  // eslint-disable-line

  // A value set from outside (a project opened for editing after this mounted)
  // shows as text, instead of a picker that would demand a region again.
  useEffect(() => {
    if (mode === 'pick' && value && !sel.city) setMode('type')
  }, [value])  // eslint-disable-line

  const nameOf = (list, code) => list.find(x => x.code === code)?.name || ''
  const emit = (next, l = lists) => {
    onChange(next.city ? composeLocation({
      place: next.place,
      barangay: nameOf(l.barangays, next.barangay),
      city: nameOf(l.cities, next.city),
      province: nameOf(l.provinces, next.province),
    }) : '')
  }

  const pickRegion = async (code) => {
    const next = { ...sel, region: code, province: '', city: '', barangay: '' }
    setSel(next)
    const cleared = { ...lists, provinces: [], cities: [], barangays: [] }
    setLists(cleared)
    emit(next, cleared)
    if (!code) return
    setLoading('provinces')
    try {
      const provinces = await apiLocRegionProvinces(code)
      if (provinces.length) {
        setNoProvinces(false)
        setLists(l => ({ ...l, provinces }))
      } else {
        // Metro Manila has no provinces: its cities hang off the region.
        setNoProvinces(true)
        const cities = await apiLocRegionCities(code)
        setLists(l => ({ ...l, cities }))
      }
    } catch (e) { fail(e) } finally { setLoading('') }
  }

  const pickProvince = async (code) => {
    const next = { ...sel, province: code, city: '', barangay: '' }
    setSel(next)
    const cleared = { ...lists, cities: [], barangays: [] }
    setLists(cleared)
    emit(next, cleared)
    if (!code) return
    setLoading('cities')
    try {
      const cities = await apiLocProvinceCities(code)
      setLists(l => ({ ...l, cities }))
    } catch (e) { fail(e) } finally { setLoading('') }
  }

  const pickCity = async (code) => {
    const next = { ...sel, city: code, barangay: '' }
    setSel(next)
    const cleared = { ...lists, barangays: [] }
    setLists(cleared)
    emit(next, cleared)
    if (!code) return
    setLoading('barangays')
    try {
      const barangays = await apiLocCityBarangays(code)
      setLists(l => ({ ...l, barangays }))
    } catch (e) { fail(e) } finally { setLoading('') }
  }

  const pickBarangay = (code) => { const next = { ...sel, barangay: code }; setSel(next); emit(next) }
  const setPlace = (place) => { const next = { ...sel, place }; setSel(next); emit(next) }

  if (mode === 'type') {
    return (
      <div className="lp">
        <input id={id} value={value} onChange={e => onChange(e.target.value)} required={required}
          placeholder="e.g. Supply Office, Brgy. Poblacion, City of Tagum, Davao del Norte" />
        {error && <span className="lp-note lp-note--warn" role="status">{error}</span>}
        <button type="button" className="lp-switch" onClick={() => { setError(''); setMode('pick') }}>
          <MapPin size={12} aria-hidden="true" /> Choose from the Philippine location list
        </button>
      </div>
    )
  }

  const placeholder = (what, ready) => (loading === what ? 'Loading…' : ready ? 'Choose…' : '—')
  return (
    <div className="lp">
      <div className="lp-grid">
        <label className="lp-field">
          <span>Region</span>
          <select id={id} value={sel.region} onChange={e => pickRegion(e.target.value)} required={required}>
            <option value="">{loading === 'regions' ? 'Loading…' : 'Choose a region…'}</option>
            {(lists.regions || []).map(r => <option key={r.code} value={r.code}>{r.label || r.name}</option>)}
          </select>
        </label>
        {!noProvinces && (
          <label className="lp-field">
            <span>Province</span>
            <select value={sel.province} onChange={e => pickProvince(e.target.value)}
              disabled={!lists.provinces.length} required={required && !noProvinces}>
              <option value="">{placeholder('provinces', lists.provinces.length)}</option>
              {lists.provinces.map(p => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label className="lp-field">
          <span>City / Municipality</span>
          <select value={sel.city} onChange={e => pickCity(e.target.value)} disabled={!lists.cities.length} required={required}>
            <option value="">{placeholder('cities', lists.cities.length)}</option>
            {lists.cities.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <label className="lp-field">
          <span>Barangay <small>(optional)</small></span>
          <select value={sel.barangay} onChange={e => pickBarangay(e.target.value)} disabled={!lists.barangays.length}>
            <option value="">{placeholder('barangays', lists.barangays.length)}</option>
            {lists.barangays.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>
        </label>
        <label className="lp-field lp-field--wide">
          <span>Building, street or office <small>(optional)</small></span>
          <input value={sel.place} onChange={e => setPlace(e.target.value)} placeholder="e.g. Supply Office, Main Campus" />
        </label>
      </div>
      {value && <span className="lp-note"><MapPin size={12} aria-hidden="true" /> {value}</span>}
      <button type="button" className="lp-switch" onClick={() => setMode('type')}>Type the location instead</button>
    </div>
  )
}
