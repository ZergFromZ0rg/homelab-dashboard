// Compose-stack form: a project name, the compose YAML, optional .env
// pairs, and the shared scheduler constraints.

function StackForm({ value, onChange, nodeNames }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const setConstraint = (patch) =>
    onChange({ ...value, constraints: { ...value.constraints, ...patch } });

  function setEnvRow(index, key, v) {
    const envRows = value.envRows.map((row, i) =>
      i === index ? { ...row, [key]: v } : row
    );
    set({ envRows });
  }

  return (
    <div className="deploy-form">
      <div className="deploy-field">
        <span className="deploy-label">Project name *</span>
        <input
          className="deploy-input"
          placeholder="media-stack"
          value={value.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>

      <div className="deploy-field">
        <span className="deploy-label">docker-compose.yml *</span>
        <textarea
          className="deploy-input deploy-textarea"
          rows={12}
          spellCheck={false}
          placeholder={"services:\n  app:\n    image: nginx:latest\n    ports:\n      - \"8080:80\"\n    deploy:\n      resources:\n        limits:\n          memory: 256M"}
          value={value.compose_yaml}
          onChange={(e) => set({ compose_yaml: e.target.value })}
        />
        <span className="deploy-hint">
          Named volumes only (bind mounts need the agent's allowlist).
          Add <code>deploy.resources.limits.memory</code> per service so
          placement can reserve RAM.
        </span>
      </div>

      <div className="deploy-field">
        <span className="deploy-label">.env (compose interpolation)</span>
        {value.envRows.map((row, index) => (
          <div key={index} className="deploy-row">
            <input
              className="deploy-input"
              placeholder="PUID"
              value={row.key}
              onChange={(e) => setEnvRow(index, "key", e.target.value)}
            />
            <input
              className="deploy-input"
              placeholder="1000"
              value={row.value}
              onChange={(e) => setEnvRow(index, "value", e.target.value)}
            />
            <button
              type="button"
              className="deploy-row-remove"
              onClick={() =>
                set({ envRows: value.envRows.filter((_, i) => i !== index) })
              }
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="deploy-add"
          onClick={() => set({ envRows: [...value.envRows, { key: "", value: "" }] })}
        >
          + env var
        </button>
      </div>

      <div className="deploy-field">
        <label className="deploy-check">
          <input
            type="checkbox"
            checked={value.constraints.require_gpu}
            onChange={(e) => setConstraint({ require_gpu: e.target.checked })}
          />
          A service needs a GPU
        </label>
      </div>

      {nodeNames.length > 0 && (
        <div className="deploy-grid">
          <div className="deploy-field">
            <span className="deploy-label">Only these nodes</span>
            <select
              className="deploy-input"
              multiple
              value={value.constraints.node_in ?? []}
              onChange={(e) =>
                setConstraint({
                  node_in: [...e.target.selectedOptions].map((o) => o.value),
                })
              }
            >
              {nodeNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="deploy-field">
            <span className="deploy-label">Never these nodes</span>
            <select
              className="deploy-input"
              multiple
              value={value.constraints.node_not_in ?? []}
              onChange={(e) =>
                setConstraint({
                  node_not_in: [...e.target.selectedOptions].map((o) => o.value),
                })
              }
            >
              {nodeNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

export default StackForm;
