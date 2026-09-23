import { useState } from "react";
import TokenBox from "./TokenBox";
import DeployForm from "./DeployForm";
import StackForm from "./StackForm";
import FleetCapacity from "./FleetCapacity";
import PlacementPreview from "./PlacementPreview";
import DeploymentList from "./DeploymentList";
import RebalancePanel from "./RebalancePanel";
import { previewPlacement, deploy, previewStack, deployStack } from "./deployApi";

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
  },
};

const EMPTY_STACK = {
  name: "",
  compose_yaml: "",
  envRows: [],
  constraints: {
    require_gpu: false,
    node_in: null,
    node_not_in: null,
    max_node_cpu_percent: null,
  },
};

function envFromRows(rows) {
  return Object.fromEntries(
    rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), String(r.value ?? "")])
  );
}

function toApiSpec(form) {
  return {
    image: form.image.trim(),
    name: form.name?.trim() || null,
    env: envFromRows(form.envRows),
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
    constraints: toApiConstraints(form.constraints),
  };
}

function toApiConstraints(c) {
  return {
    require_gpu: c.require_gpu,
    node_in: c.node_in?.length ? c.node_in : null,
    node_not_in: c.node_not_in?.length ? c.node_not_in : null,
    max_node_cpu_percent: c.max_node_cpu_percent,
  };
}

function toApiStack(form) {
  return {
    name: form.name.trim(),
    compose_yaml: form.compose_yaml,
    env: envFromRows(form.envRows),
    constraints: toApiConstraints(form.constraints),
  };
}

function DeployTab({ machines, deployments, connected }) {
  const [mode, setMode] = useState("container");
  const [form, setForm] = useState(EMPTY_SPEC);
  const [stackForm, setStackForm] = useState(EMPTY_STACK);
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState(null); // {kind: "error"|"ok", text}
  const [busy, setBusy] = useState(null);

  const nodeNames = Object.keys(machines ?? {}).sort();
  const isStack = mode === "stack";

  async function runPreview() {
    setBusy("preview");
    setStatus(null);
    try {
      setPreview(
        isStack
          ? await previewStack(toApiStack(stackForm))
          : await previewPlacement(toApiSpec(form))
      );
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
      const record = isStack
        ? await deployStack(toApiStack(stackForm), node)
        : await deploy(toApiSpec(form), node);

      if (record.status === "failed") {
        setStatus({ kind: "error", text: record.error || "deployment failed" });
      } else {
        const what = isStack ? record.stack.name : record.spec.image;
        setStatus({ kind: "ok", text: `Deploying ${what} to ${record.placed_on}.` });
        setForm(EMPTY_SPEC);
        setStackForm(EMPTY_STACK);
        setPreview(null);
      }
    } catch (error) {
      setStatus({ kind: "error", text: error.message });
    } finally {
      setBusy(null);
    }
  }

  // Any edit invalidates a shown preview — the backend re-scores on deploy
  // regardless, so a visible recommendation must always match the form.
  function editForm(next) {
    setForm(next);
    setPreview(null);
  }
  function editStack(next) {
    setStackForm(next);
    setPreview(null);
  }

  function switchMode(next) {
    setMode(next);
    setPreview(null);
    setStatus(null);
  }

  const canSubmit =
    !busy &&
    (isStack
      ? stackForm.name.trim() && stackForm.compose_yaml.trim()
      : form.image.trim());

  return (
    <section className="deploy-tab">
      <FleetCapacity machines={machines} deployments={deployments} />

      <div className="deploy-columns">
        <div className="deploy-pane">
          <div className="section-header">
            <p className="eyebrow">New workload</p>
            <h2>Deploy {isStack ? "a compose stack" : "a container"}</h2>
          </div>

          <div className="deploy-mode">
            <button
              type="button"
              className={`deploy-mode-btn ${!isStack ? "active" : ""}`}
              onClick={() => switchMode("container")}
            >
              Single container
            </button>
            <button
              type="button"
              className={`deploy-mode-btn ${isStack ? "active" : ""}`}
              onClick={() => switchMode("stack")}
            >
              Compose stack
            </button>
          </div>

          {isStack ? (
            <StackForm value={stackForm} onChange={editStack} nodeNames={nodeNames} />
          ) : (
            <DeployForm spec={form} onChange={editForm} nodeNames={nodeNames} />
          )}
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

          {preview && !preview.recommended && (
            <p className="placement-warning">
              ⚠ No node meets the requirements — Deploy is disabled. See each
              node's reasons below.
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
          <DeploymentList deployments={deployments} connected={connected} />
        </div>
      </div>
    </section>
  );
}

export default DeployTab;
