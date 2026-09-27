import { createContext, useContext } from "react";

// Lets any row or card open a shell without threading props through every
// tab: `open({host, target, container, name})` adds a tab to the dock, and
// `available(host)` says whether that host's agent allows shells at all.
export const TerminalContext = createContext(null);

export function useTerminal() {
  return useContext(TerminalContext);
}
