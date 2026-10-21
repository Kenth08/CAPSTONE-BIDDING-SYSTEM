import { useState } from 'react'
import {
  Armchair, BookOpen, Bus, Dumbbell, FlaskConical, HardHat, Laptop, Package, Paintbrush,
  Printer, Stethoscope, UtensilsCrossed, Zap,
} from 'lucide-react'

// One line icon per procurement category, for image placeholders.
const CATEGORY_ICON = {
  'IT Equipment': Laptop,
  'Office Supplies': Package,
  Furniture: Armchair,
  Construction: HardHat,
  'Electrical Supplies': Zap,
  'Laboratory Equipment': FlaskConical,
  'Printing Services': Printer,
  'Janitorial Supplies': Paintbrush,
  'Food & Catering': UtensilsCrossed,
  'Transportation Services': Bus,
  'Medical Supplies': Stethoscope,
  'Sports Equipment': Dumbbell,
  'Books & Educational Materials': BookOpen,
}
export const categoryIcon = (category) => CATEGORY_ICON[category] || Package

/**
 * Fixed-size image (48px in tables, 64–96px in cards) with object-fit cover,
 * lazy loading and a category-icon placeholder when there is no image or it
 * fails to load. With `onOpen` it is a button that opens the lightbox.
 * `badge` shows e.g. "+2" for more images.
 */
export default function Thumbnail({ src, alt, size = 48, category, onOpen, badge, className = '' }) {
  const [failed, setFailed] = useState(false)
  const Icon = categoryIcon(category)
  const showImg = src && !failed
  const inner = (
    <>
      {showImg ? (
        <img src={src} alt={onOpen ? '' : alt} width={size} height={size} loading="lazy" decoding="async"
          onError={() => setFailed(true)} />
      ) : (
        <span className="rf-thumb-ph" aria-hidden="true"><Icon size={Math.round(size * 0.42)} /></span>
      )}
      {badge && <span className="rf-thumb-badge" aria-hidden="true">{badge}</span>}
    </>
  )
  const style = { width: size, height: size }
  if (onOpen && showImg) {
    return (
      <button type="button" className={`rf-thumb is-button ${className}`} style={style}
        onClick={(e) => { e.stopPropagation(); onOpen() }}
        aria-label={`View ${alt}${badge ? ` (${badge} more)` : ''}`}>
        {inner}
      </button>
    )
  }
  return (
    <span className={`rf-thumb ${className}`} style={style} role={showImg ? undefined : 'img'}
      aria-label={showImg ? undefined : `No image — ${category || 'procurement'}`}>
      {inner}
    </span>
  )
}
