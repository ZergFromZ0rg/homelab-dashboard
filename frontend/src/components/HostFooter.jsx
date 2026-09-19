// Server-level facts that aren't host metrics: what runs on it and whether
// its agent is talking to us. Sits under a host's vitals.
function HostFooter({ machine, containers }) {
  const list = containers || [];
  const running = list.filter((c) => c.status === "running").length;
  const unhealthy = list.filter((c) => c.health === "unhealthy").length;

  let agent = { label: "agent connected", tone: "ok" };
  if (machine.agent_reachable === false) {
    agent = { label: "agent unreachable", tone: "bad" };
  } else if (machine.agent_stale_age != null) {
    agent = { label: `agent stale ${machine.agent_stale_age}s`, tone: "warn" };
  } else if (machine.agent_reachable === undefined) {
    agent = { label: "no agent", tone: "none" };
  }

  return (
    <div className="host-foot">
      <span className="chip">
        {running}/{list.length} containers running
      </span>
      {unhealthy > 0 && <span className="chip chip--bad">{unhealthy} unhealthy</span>}
      <span className={`chip chip--${agent.tone}`}>{agent.label}</span>
    </div>
  );
}

export default HostFooter;
