// A titled panel with an optional "go to its page" link in its header. `tone`
// tints the count when the panel is reporting a problem; `foot` is a line that
// stays under the scrolling body.
function Panel({ title, count, tone, linkLabel, onLink, className = "", foot, children }) {
  return (
    <section className={`overview-card ov-panel ${tone ? `ov-panel--${tone}` : ""} ${className}`}>
      <div className="overview-card-head">
        <h2>{title}</h2>
        {count != null && <span className="overview-card-count">{count}</span>}
        {onLink && (
          <button type="button" className="ov-panel-link" onClick={onLink}>
            {linkLabel} →
          </button>
        )}
      </div>
      <div className="overview-card-body">{children}</div>
      {foot && <div className="ov-panel-foot">{foot}</div>}
    </section>
  );
}

export default Panel;
