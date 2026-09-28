import { useState } from "react";
import { jsonOrThrow } from "./apiAuth";
import { confirmedFetch } from "./confirmedFetch";
import { DEMO } from "../demoData";

function _ago(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function OvernightList({ overnight }) {
  if (!overnight || overnight.events_count === 0) {
    return <p className="mb-empty">Quiet night. No significant events.</p>;
  }
  return (
    <ul className="mb-list mb-list--overnight">
      {overnight.highlights.map((ev, i) => (
        <li key={i} className={`mb-item mb-item--${ev.tone}`}>
          <span className={`status-dot status-dot--${ev.tone}`} />
          <span className="mb-text">{ev.text}</span>
          <span className="mb-time">{_ago(Date.now() / 1000 - ev.at)}</span>
        </li>
      ))}
      {overnight.events_count > overnight.highlights.length && (
        <li className="mb-more">+{overnight.events_count - overnight.highlights.length} more events</li>
      )}
    </ul>
  );
}

function DegradingList({ degrading, onNavigate }) {
  if (!degrading || degrading.length === 0) {
    return <p className="mb-empty">All systems nominal. No degrading signals.</p>;
  }
  return (
    <ul className="mb-list mb-list--degrading">
      {degrading.map(item => (
        <li key={item.key} className={`mb-card mb-card--${item.severity}`}>
          <strong>{item.title}</strong>
          <span className="mb-detail">{item.detail}</span>
          {item.host && <button className="btn btn--sm mb-jump" onClick={() => onNavigate("servers", { host: item.host })}>View host</button>}
        </li>
      ))}
    </ul>
  );
}

function ActionQueue({ actions }) {
  const [working, setWorking] = useState({});
  const [errors, setErrors] = useState({});

  if (!actions || actions.length === 0) {
    return <p className="mb-empty">You're all caught up! No approvals needed.</p>;
  }

  const runAction = async (actionItem) => {
    const act = actionItem.action;
    if (act.confirm && !window.confirm(act.confirm)) return;
    
    setWorking(prev => ({ ...prev, [actionItem.id]: true }));
    setErrors(prev => ({ ...prev, [actionItem.id]: null }));
    try {
      if (DEMO) throw new Error("Demo mode — changes aren't saved.");
      // The next /ws tick drops the item once it's done.
      await confirmedFetch(act.url, {
        method: act.method || "POST",
        headers: act.body ? { "Content-Type": "application/json" } : undefined,
        body: act.body ? JSON.stringify(act.body) : undefined,
      }).then(jsonOrThrow);
    } catch (e) {
      setErrors(prev => ({ ...prev, [actionItem.id]: e.message }));
    } finally {
      setWorking(prev => ({ ...prev, [actionItem.id]: false }));
    }
  };

  return (
    <ul className="mb-list mb-list--actions">
      {actions.map(act => (
        <li key={act.id} className="mb-action-card">
          <div className="mb-action-info">
            <strong>{act.title}</strong>
            <span>{act.subtitle}</span>
            {errors[act.id] && <span className="form-error">{errors[act.id]}</span>}
          </div>
          <button 
            className="btn btn--primary" 
            disabled={working[act.id]}
            onClick={() => runAction(act)}
          >
            {working[act.id] ? "Running..." : act.button_label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function MorningBriefing({ summary, onNavigate }) {
  if (!summary) return null;

  return (
    <div className="morning-briefing">
      <div className="mb-header">
        <h2>Morning Briefing</h2>
      </div>
      <div className="mb-columns">
        <section className="mb-column">
          <h3>What happened overnight</h3>
          <OvernightList overnight={summary.overnight} />
        </section>
        
        <section className="mb-column">
          <h3>What's degrading</h3>
          <DegradingList degrading={summary.degrading} onNavigate={onNavigate} />
        </section>

        <section className="mb-column">
          <h3>What needs a yes</h3>
          <ActionQueue actions={summary.needs_action} />
        </section>
      </div>
    </div>
  );
}

export default MorningBriefing;
