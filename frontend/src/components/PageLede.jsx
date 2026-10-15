// The line under the navigation: what this page is for, and — where the page
// has two views of the same thing (live / over time, traffic / packets) — the
// switch between them. `views` is [[id, label], …]; `onView(id)` moves between
// them.
function PageLede({ text, views, current, onView }) {
  const switchable = views?.length > 1;
  if (!text && !switchable) return null;
  return (
    <div className="page-lede">
      {text && <p title={text}>{text}</p>}
      {switchable && (
        <div className="segmented page-lede-views" role="group" aria-label="View">
          {views.map(([id, label]) => (
            <button key={id} type="button" className={current === id ? "active" : ""} aria-pressed={current === id} onClick={() => onView(id)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default PageLede;
