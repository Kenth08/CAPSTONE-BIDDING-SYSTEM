import { Check } from 'lucide-react'

// Numbered horizontal stepper with completed / current / upcoming states.
// Purely visual: `current` is the index of the active step. Scrolls sideways on
// narrow screens instead of squashing the labels.
export default function Stepper({ steps, current, label = 'Progress' }) {
  return (
    <ol className="ui-stepper" aria-label={label}>
      {steps.map((step, i) => {
        const state = i < current ? 'is-done' : i === current ? 'is-active' : 'is-upcoming'
        return (
          <li
            key={step}
            className={`ui-step ${state}`}
            aria-current={i === current ? 'step' : undefined}
          >
            <span className="ui-step-dot">{i < current ? <Check size={15} aria-hidden="true" /> : i + 1}</span>
            <span className="ui-step-label">{step}</span>
            {i < current && <span className="sr-only">(completed)</span>}
          </li>
        )
      })}
    </ol>
  )
}
