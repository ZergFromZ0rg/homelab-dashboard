import { useState } from "react";
import DeployForm from "./DeployForm";
import PlacementPreview from "./PlacementPreview";
import DeploymentList from "./DeploymentList";
import RebalancePanel from "./RebalancePanel";
import { previewPlacement, deploy } from "./deployApi";

const EMPTY_SPEC = {
  image: "",
  name: null,
  envRows: [],
  ports: [],
  volumes: [],
  restart_policy: "unless-stopped",
  resources: { cpus: null, memory_mb: null },
  constraints: {
    require_gpu: false,
    node_in: null,
    node_not_in: null,
    max_node_cpu_percent: null,
    notes: null,
  },
};

// Form shape -> API DeploymentSpec.
function toApiSpec(form) {
  return {
    image: form.image.trim(),
    name: form.name?.trim() || null,
    env: Object.fromEntries(
      form.envRows
        .filter((r) => r.key.trim())
        .map((r) => [r.key.trim(), String(r.value ?? "")])
    ),
    ports: form.ports
      .filter((p) => p.host && p.container)
      .map((p) => ({
        host: Number(p.host),
        container: Number(p.container),
        proto: p.proto === "udp" ? "udp" : "tcp",
      })),
    volumes: form.volumes
      .filter((v) => v.source.trim() && v.target.trim())
      .map((v) => ({ source: v.source.trim(), target: v.target.trim() })),
    restart_policy: form.restart_policy,
    resources: {
      cpus: form.resources.cpus || null,
      memory_mb: form.resources.memory_mb || null,
    },
    constraints: {
      require_gpu: form.constraints.require_gpu,
      node_in: form.constraints.node_in?.length ? form.constraints.node_in : null,
      node_not_in: form.constraints.node_not_in?.length
        ? form.constraints.node_not_in
        : null,
      max_node_cpu_percent: form.constraints.max_node_cpu_percent,
      notes: form.constraints.notes,
    },
  };
}

function TokenBox() {
  const [token, setToken] = useState(sessionStorage.getItem("apiToken") ?? "");
  return (
    <div className="deploy-field">
      <span className="deploy-label">API token (only if the backend sets one)</span>
      <input
        className="deploy-input"
        type="password"
        value={token}
        placeholder="X-Register-Token"
        onChange={(e) => {
          setToken(e.target.value);
          if (e.target.value) sessionStorage.setItem("apiToken", e.target.value);
          else sessionStorage.removeItem("apiToken");
        }}
      />
    </div>
  );
}

function DeployTab({ machines, deployments }) {
  const [form, setForm] = useState(EMPTY_SPEC);
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState(null); // {kind: "error"|"ok", text}
  const [busy, setBusy] = useState(null);

  const nodeNames = Object.keys(machines ?? {}).sort();

  async function runPreview() {
    setBusy("preview");
    setStatus(null);
    try {
      setPreview(await previewPlacement(toApiSpec(form)));
    } catch (error) {
      setStatus({ kind: "error", text: error.message });
      setPreview(null);
    } finally {
      setBusy(null);
    }
  }

  async function runDeploy(node) {
    setBusy("deploy");
    setStatus(null);
    try {
      const record = await deploy(toApiSpec(form), node);
      if (record.status === "failed") {
        setStatus({ kind: "error", text: record.error || "deployment failed" });
      } else {
        setStatus({
          kind: "ok",
          text: `Deploying ${record.spec.image} to ${record.placed_on}.`,
        });
        setForm(EMPTY_SPEC);
        setPreview(null);
      }
    } catch (error) {
      setStatus({ kind: "error", text: error.message });
    } finally {
      setBusy(null);
    }
  }

  // Any edit makes a previous preview stale — the backend re-scores on
  // deploy anyway, so a shown recommendation must always match the form.
  function editForm(next) {
    setForm(next);
    setPreview(null);
  }

  const canSubmit = form.image.trim().length > 0 && !busy;

  return (
    <section className="deploy-tab">
      <div className="deploy-columns">
        <div className="deploy-pane">
          <div className="section-header">
            <p className="eyebrow">New workload</p>
            <h2>Deploy a container</h2>
          </div>

          <DeployForm spec={form} onChange={editForm} nodeNames={nodeNames} />
          <TokenBox />

          <div className="deploy-buttons">
            <button
              type="button"
              className="deploy-primary"
              disabled={!canSubmit}
              onClick={runPreview}
            >
              {busy === "preview" ? "Scoring…" : "Preview placement"}
            </button>
            <button
              type="button"
              className="deploy-primary deploy-primary--go"
              disabled={!canSubmit || !preview?.recommended}
              onClick={() => runDeploy(null)}
            >
              {busy === "deploy"
                ? "Deploying…"
                : preview?.recommended
                ? `Deploy to ${preview.recommended}`
                : "Deploy"}
            </button>
          </div>

          {status && (
            <p
              className={
                status.kind === "error" ? "deployment-error" : "deploy-ok"
              }
            >
              {status.text}
            </p>
          )}

          <PlacementPreview
            preview={preview}
            recommended={preview?.recommended}
            onPick={(node) => runDeploy(node)}
          />
        </div>

        <div className="deploy-pane">
          <RebalancePanel deployments={deployments} />
          <DeploymentList deployments={deployments} />
        </div>
      </div>
    </section>
  );
}

export default DeployTab;
