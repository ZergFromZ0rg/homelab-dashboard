import { IconButton } from "./Icon";
import { useTerminal } from "./terminalContext";

// ">_" on a server card: a shell on that machine itself. Only there when
// the host's agent allows terminals (TERMINAL_ENABLED).
function HostShellButton({ host }) {
  const terminal = useTerminal();
  if (!terminal?.available(host)) return null;
  return (
    <IconButton
      icon="terminal"
      label={`Open a shell on ${host}`}
      onClick={() => terminal.open({ host, target: "host" })}
    />
  );
}

export default HostShellButton;
