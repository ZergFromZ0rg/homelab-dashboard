import { hostColor } from "./hostColor";

// Pick any number of nodes by toggling chips — replaces a multi-select box,
// which needs ⌘-click to pick more than one and hides that it can.
function NodePicker({ nodes, value = [], onChange }) {
  const selected = new Set(value);

  return (
    <div className="node-picker">
      {nodes.map((node) => {
        const on = selected.has(node);
        return (
          <button
            key={node}
            type="button"
            className={`node-chip ${on ? "node-chip--on" : ""}`}
            style={{ "--host-color": hostColor(node) }}
            aria-pressed={on}
            onClick={() =>
              onChange(on ? value.filter((n) => n !== node) : [...value, node])
            }
          >
            {node}
          </button>
        );
      })}
    </div>
  );
}

export default NodePicker;
