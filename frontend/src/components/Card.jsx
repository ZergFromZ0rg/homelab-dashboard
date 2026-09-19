// A titled panel used across Overview and Personal. `actions` sits at the
// right of the header (inline controls for that card, e.g. a unit toggle).
function Card({ title, count, actions, className = "", children }) {
  return (
    <section className={`overview-card ${className}`}>
      <div className="overview-card-head">
        <h2>{title}</h2>
        {count != null && <span className="overview-card-count">{count}</span>}
        {actions && <div className="overview-card-actions">{actions}</div>}
      </div>
      <div className="overview-card-body">{children}</div>
    </section>
  );
}

export default Card;
