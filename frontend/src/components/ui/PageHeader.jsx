// In-content heading: title + one-line description on the left, actions on the
// right. The app header already shows the page name, so this is for sections
// that need their own description or primary action.
export default function PageHeader({ title, description, actions }) {
  return (
    <div className="ui-page-header">
      <div>
        {title && <h2 className="ui-page-header-title">{title}</h2>}
        {description && <p className="ui-page-header-desc">{description}</p>}
      </div>
      {actions && <div className="ui-page-header-actions">{actions}</div>}
    </div>
  )
}
