import { formatAge, formatBytes } from "./format";

// "If this host died": what the dashboard can say about it from two sources, the
// agent's own word on its compose-file backup (it arrives with every update) and the
// recovery report (which stacks a job covers and which data nothing does). Plain
// functions of that data, so a panel can say what it knows and no more.

const WORDS = {
  ok: "Backed up",
  stale: "Behind",
  failing: "Failing",
  pending: "Hasn't run yet",
  not_configured: "Not backed up",
  disabled: "Switched off",
  unsupported: "Agent too old to say",
  unknown: "Couldn't ask",
};

const TONES = { ok: "ok", stale: "warn", pending: "warn", failing: "bad", not_configured: "bad" };

// The compose-file backup, as a word, a line of detail and a tone.
export function configBackup(backup) {
  const state = backup?.state ?? "unknown";
  let detail = "";
  if ((state === "ok" || state === "stale") && backup.last_success_age != null) detail = `pushed ${formatAge(backup.last_success_age)}`;
  else if (state === "failing") detail = backup.last_error || "";
  else if (state === "not_configured") detail = "set BACKUP_REPO and GITHUB_TOKEN on its agent";
  return { state, word: WORDS[state] ?? state, detail, tone: TONES[state] ?? "none" };
}

// The stacks with something nobody has decided about: data that no job covers and
// nobody skipped on purpose. Biggest first. `partial` means the agent stopped
// measuring, so the size is at least that.
export function openStacks(recovery) {
  return (recovery?.projects ?? [])
    .map((project) => {
      // A stack skipped as a whole, or with everything decided, has nothing open.
      const open = project.ignored || project.settled ? [] : (project.items ?? []).filter((item) => !item.protected_by && !item.ignored);
      return {
        project: project.project,
        bytes: open.reduce((sum, item) => sum + (item.bytes || 0), 0),
        partial: open.some((item) => item.partial),
        pieces: open.length,
      };
    })
    .filter((stack) => stack.pieces > 0)
    .sort((a, b) => b.bytes - a.bytes || a.project.localeCompare(b.project));
}

// The verdict for one host. `backup` is the machine's own report, `recovery` the
// report from the agent (null until it has answered), `failed` that asking it did
// not work. A lost stack is red; a compose backup that is failing or missing is red
// too (you would have nothing to rebuild from); one that is behind is amber.
export function protection({ backup, recovery = null, failed = false }) {
  const config = configBackup(backup ?? recovery?.config_backup);
  const stacks = openStacks(recovery);
  const bytes = recovery ? (recovery.unprotected_bytes ?? stacks.reduce((sum, stack) => sum + stack.bytes, 0)) : 0;
  const known = Boolean(recovery);

  let tone;
  let label;
  if (stacks.length > 0) {
    tone = "bad";
    label = `${formatBytes(bytes)} at risk`;
  } else if (config.tone === "bad") {
    tone = "bad";
    label = config.state === "failing" ? "backup failing" : "no compose backup";
  } else if (config.tone === "warn") {
    tone = "warn";
    label = "backup behind";
  } else if (!known) {
    tone = "none";
    label = failed ? "couldn't check" : "checking…";
  } else if (config.tone === "ok") {
    tone = "ok";
    label = "safe";
  } else {
    tone = "none";
    label = config.word.toLowerCase();
  }

  return { tone, label, config, stacks, bytes, known, failed: failed && !known, ignored: recovery?.ignored_count ?? 0 };
}
