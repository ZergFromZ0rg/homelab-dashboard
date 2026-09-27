import { createContext, useContext } from "react";

// One update job per host, shared by the row that started it and the host
// header that shows how it went. See UpdatesProvider.
export const UpdatesContext = createContext(null);

export const useUpdates = () => useContext(UpdatesContext);
