import { useCallback, useEffect, useState } from "react";
import { deleteSaved, listSaved, openSaved, renameSaved, saveCapture, savedPcapUrl } from "./captureApi";
import { formatBytes, formatWhen } from "./format";
import Icon from "./Icon";

// Captures kept on the dashboard. Saving is an explicit click and copies what
// the agent holds right now (packets and .pcap), so it survives the next
// capture and an agent restart. Opening one shows it in the packet viewer,
// read-only, with the same filter, conversations and follow-stream.

const PAYLOAD = { none: "headers only", 64: "64 B payload", full: "full packets" };

function SavedCaptures({ host, canSave, onOpen }) {
  const [list, setList] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      setList((await listSaved()).captures);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    let alive = true;
    listSaved()
      .then((body) => alive && setList(body.captures))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  const run = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    await saveCapture(host, name.trim());
    setName("");
  });

  const open = (id) => run(async () => onOpen(await openSaved(id)));

  return (
    <div className="pcap-saved">
      {canSave && (
        <form className="pcap-saved-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input
            className="pcap-expr"
            placeholder={`Name this capture (optional) — saves what ${host} holds now`}
            aria-label="Name for the saved capture"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn--sm btn--primary" disabled={busy}>Save</button>
        </form>
      )}

      {error && <p className="form-error">{error}</p>}

      {list && list.length === 0 && <p className="lan-meta">Nothing saved yet.{canSave ? "" : " Start a capture, then save it here."}</p>}

      {list && list.length > 0 && (
        <table className="net-table lan-table pcap-table pcap-saved-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Host</th>
              <th>Saved</th>
              <th className="pcap-r">Packets</th>
              <th>Kept</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td className="pcap-name">
                  {editing?.id === c.id ? (
                    <form onSubmit={(e) => { e.preventDefault(); run(async () => { await renameSaved(c.id, editing.name); setEditing(null); }); }}>
                      <input className="lan-rename" autoFocus maxLength={80} value={editing.name} onChange={(e) => setEditing({ id: c.id, name: e.target.value })} onBlur={() => setEditing(null)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
                    </form>
                  ) : (
                    <button type="button" className="pcap-linkish" onClick={() => open(c.id)} title="Open in the packet viewer">{c.name}</button>
                  )}
                </td>
                <td className="net-mono net-dim">{c.host}</td>
                <td className="net-dim" title={new Date(c.saved_at * 1000).toLocaleString()}>{formatWhen(c.saved_at)}</td>
                <td className="net-mono pcap-r" title={`${c.total_packets.toLocaleString()} counted, ${c.packets.toLocaleString()} kept in the list`}>{c.packets.toLocaleString()}</td>
                <td className="net-dim" title={[c.iface, c.promisc && "promiscuous", c.drops > 0 && `${c.drops} dropped by the kernel`].filter(Boolean).join(" · ")}>
                  {PAYLOAD[c.payload] || "headers only"} · {formatBytes(c.size)}
                </td>
                <td className="pcap-saved-actions">
                  <button type="button" className="icon-action" title="Rename" aria-label={`Rename ${c.name}`} onClick={() => setEditing({ id: c.id, name: c.name })}><Icon name="edit" /></button>
                  <a className="icon-action" href={savedPcapUrl(c.id)} title="Download .pcap" aria-label={`Download ${c.name} as .pcap`}><Icon name="download" /></a>
                  {confirm === c.id ? (
                    <button type="button" className="btn btn--sm btn--danger" disabled={busy} onClick={() => run(async () => { await deleteSaved(c.id); setConfirm(null); })} onBlur={() => setConfirm(null)} autoFocus>Delete?</button>
                  ) : (
                    <button type="button" className="icon-action" title="Delete" aria-label={`Delete ${c.name}`} onClick={() => setConfirm(c.id)}><Icon name="trash" /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default SavedCaptures;
