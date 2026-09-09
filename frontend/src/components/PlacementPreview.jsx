// Renders a PlacementResponse: the ranked node list with scores and
// reasons, plus any warnings.

function ScoreBar({ score, eligible }) {
  return (
    <div className="score-bar" title={`score ${score}`}>
      <div
        className={`score-bar-fill ${eligible ? "" : "score-bar-fill--out"}`}
        style={{ width: `${Math.max(2, score)}%` }}
      />
    </div>
  );
}

function PlacementPreview({ preview, recommended, onPick }) {
  if (!preview) return null;

  const { ranked, warnings, stack_services: services } = preview;

  return (
    <div className="placement-preview">
      <div className="section-header">
        <p className="eyebrow">Scheduler</p>
        <h2>Recommended placement</h2>
      </div>

      {services && (
        <div className="placement-services">
          {services.map((s) => (
            <div key={s.name} className="placement-service">
              <strong>{s.name}</strong>
              <span>{s.image || "(build)"}</span>
              <span className="placement-service-res">
                {s.memory_mb ? `${s.memory_mb} MB` : "mem —"}
                {s.cpus ? ` · ${s.cpus} vCPU` : ""}
                {s.host_ports?.length ? ` · :${s.host_ports.join(" :")}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {warnings?.map((w, i) => (
        <p key={i} className="placement-warning">
          ⚠ {w}
        </p>
      ))}

      <div className="placement-nodes">
        {ranked.map((r) => (
          <div
            key={r.node}
            className={`placement-node ${r.eligible ? "" : "placement-node--out"} ${
              r.node === recommended ? "placement-node--top" : ""
            }`}
          >
            <div className="placement-node-head">
              <span className="placement-node-name">{r.node}</span>
              {r.node === recommended && (
                <span className="placement-badge">recommended</span>
              )}
              {r.has_gpu && <span className="placement-tag">GPU</span>}
              <span className="placement-score">
                {r.eligible ? r.score.toFixed(0) : "—"}
              </span>
            </div>

            <ScoreBar score={r.score} eligible={r.eligible} />

            <ul className="placement-reasons">
              {r.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>

            {r.eligible && r.node !== recommended && onPick && (
              <button
                type="button"
                className="deploy-add"
                onClick={() => onPick(r.node)}
              >
                deploy here instead
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default PlacementPreview;
