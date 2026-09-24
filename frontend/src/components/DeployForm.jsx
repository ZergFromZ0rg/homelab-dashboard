import NodePicker from "./NodePicker";

// Controlled form for a DeploymentSpec. Holds no server state — the
// parent (DeployTab) owns the spec object and the preview/deploy calls.

function Rows({ label, rows, columns, onChange, addLabel }) {
  function update(index, key, value) {
    const next = rows.map((row, i) =>
      i === index ? { ...row, [key]: value } : row
    );
    onChange(next);
  }

  function add() {
    onChange([...rows, Object.fromEntries(columns.map((c) => [c.key, c.default ?? ""]))]);
  }

  function remove(index) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className="deploy-field">
      <div className="deploy-rows-head">
        <span className="deploy-label">{label}</span>
        <button type="button" className="deploy-add" onClick={add}>
          + {addLabel}
        </button>
      </div>
      {rows.map((row, index) => (
        <div key={index} className="deploy-row">
          {columns.map((col) => (
            <input
              key={col.key}
              className="deploy-input"
              type={col.type ?? "text"}
              placeholder={col.placeholder}
              value={row[col.key] ?? ""}
              style={col.width ? { flex: col.width } : undefined}
              onChange={(e) => update(index, col.key, e.target.value)}
            />
          ))}
          <button type="button" className="deploy-row-remove" onClick={() => remove(index)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function DeployForm({ spec, onChange, nodeNames }) {
  const set = (patch) => onChange({ ...spec, ...patch });
  const setConstraint = (patch) =>
    onChange({ ...spec, constraints: { ...spec.constraints, ...patch } });
  const setResource = (patch) =>
    onChange({ ...spec, resources: { ...spec.resources, ...patch } });

  return (
    <div className="deploy-form">
      <div className="deploy-grid deploy-grid--2">
        <div className="deploy-field">
          <span className="deploy-label">Image *</span>
          <input
            className="deploy-input"
            placeholder="lscr.io/linuxserver/jellyfin:latest"
            value={spec.image}
            onChange={(e) => set({ image: e.target.value })}
          />
        </div>

        <div className="deploy-field">
          <span className="deploy-label">Container name</span>
          <input
            className="deploy-input"
            placeholder="(agent generates one if blank)"
            value={spec.name ?? ""}
            onChange={(e) => set({ name: e.target.value || null })}
          />
        </div>
      </div>

      <Rows
        label="Environment"
        addLabel="env var"
        rows={spec.envRows}
        columns={[
          { key: "key", placeholder: "PUID", width: 1 },
          { key: "value", placeholder: "1000", width: 2 },
        ]}
        onChange={(envRows) => set({ envRows })}
      />

      <Rows
        label="Ports (host → container)"
        addLabel="port"
        rows={spec.ports}
        columns={[
          { key: "host", placeholder: "8096", type: "number", width: 1 },
          { key: "container", placeholder: "8096", type: "number", width: 1 },
          { key: "proto", placeholder: "tcp", width: 1 },
        ]}
        onChange={(ports) => set({ ports })}
      />

      <Rows
        label="Volumes (source → target)"
        addLabel="volume"
        rows={spec.volumes}
        columns={[
          { key: "source", placeholder: "jellyfin-config", width: 1 },
          { key: "target", placeholder: "/config", width: 1 },
        ]}
        onChange={(volumes) => set({ volumes })}
      />

      <div className="deploy-grid">
        <div className="deploy-field">
          <span className="deploy-label">Restart policy</span>
          <select
            className="deploy-input"
            value={spec.restart_policy}
            onChange={(e) => set({ restart_policy: e.target.value })}
          >
            <option value="unless-stopped">unless-stopped</option>
            <option value="always">always</option>
            <option value="on-failure">on-failure</option>
            <option value="no">no</option>
          </select>
        </div>

        <div className="deploy-field">
          <span className="deploy-label">CPU limit (vCPU)</span>
          <input
            className="deploy-input"
            type="number"
            step="0.5"
            placeholder="none"
            value={spec.resources.cpus ?? ""}
            onChange={(e) =>
              setResource({ cpus: e.target.value ? Number(e.target.value) : null })
            }
          />
        </div>

        <div className="deploy-field">
          <span className="deploy-label">Memory limit (MB)</span>
          <input
            className="deploy-input"
            type="number"
            placeholder="none"
            value={spec.resources.memory_mb ?? ""}
            onChange={(e) =>
              setResource({
                memory_mb: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
        </div>
      </div>

      <div className="deploy-field">
        <label className="deploy-check">
          <input
            type="checkbox"
            checked={spec.constraints.require_gpu}
            onChange={(e) => setConstraint({ require_gpu: e.target.checked })}
          />
          Requires a GPU
        </label>
      </div>

      {nodeNames.length > 0 && (
        <div className="deploy-grid">
          <div className="deploy-field">
            <span className="deploy-label">Only these nodes</span>
            <NodePicker
              nodes={nodeNames}
              value={spec.constraints.node_in ?? []}
              onChange={(next) => setConstraint({ node_in: next })}
            />
          </div>
          <div className="deploy-field">
            <span className="deploy-label">Never these nodes</span>
            <NodePicker
              nodes={nodeNames}
              value={spec.constraints.node_not_in ?? []}
              onChange={(next) => setConstraint({ node_not_in: next })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default DeployForm;
