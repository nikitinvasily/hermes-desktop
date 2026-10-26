import type { ConnectionConfig } from "./config";
import type { SubagentSessionSummary } from "./sessions";
import type { SshConfig } from "./ssh-tunnel";
import { remoteDashboardRequestJson } from "./remote-api";
import { sshExec, shellQuote } from "./ssh-remote";

type Row = Record<string, unknown>;
function summarize(row: Row): SubagentSessionSummary {
  const goal = String(row.delegation_goal ?? row.title ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    id: String(row.id),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    title: goal.length > 80 ? `${goal.slice(0, 79)}…` : goal,
    model: typeof row.model === "string" ? row.model : null,
    messageCount: Number(row.message_count) || 0,
  };
}
function newestFirst(
  a: SubagentSessionSummary,
  b: SubagentSessionSummary,
): number {
  return b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Compact REST rows omit model_config: require the server's parent receipt
 * plus BOTH explicit lineage fields. Older dashboards fail closed, never local. */
export async function remoteListSubagentSessions(
  connection: ConnectionConfig,
  parent: string,
  profile?: string,
): Promise<SubagentSessionSummary[]> {
  if (!parent) return [];
  const rows: Row[] = [];
  let offset = 0;
  for (;;) {
    const query = new URLSearchParams({
      parent_id: parent,
      archived: "include",
      limit: "100",
      offset: String(offset),
    });
    const page = await remoteDashboardRequestJson<{
      parent_id?: string;
      sessions: Row[];
      total: number;
    }>(connection, `/api/sessions?${query}`, {}, profile);
    if (page?.parent_id !== parent) return [];
    if (
      !Array.isArray(page.sessions) ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0
    )
      throw new Error("Invalid subagent sessions response");
    rows.push(...page.sessions);
    offset += page.sessions.length;
    if (offset >= page.total) break;
    if (!page.sessions.length)
      throw new Error("Incomplete subagent sessions pagination");
  }
  return rows
    .filter(
      (row): boolean =>
        row != null &&
        row.parent_session_id === parent &&
        row.delegation_parent_id === parent &&
        (row.profile == null || row.profile === (profile || "default")),
    )
    .map(summarize)
    .sort(newestFirst);
}

function isDelegate(row: Row, parent: string): boolean {
  if (row.parent_session_id !== parent) return false;
  try {
    const config =
      typeof row.model_config === "string"
        ? JSON.parse(row.model_config)
        : row.model_config;
    return (
      config != null &&
      typeof config === "object" &&
      config._delegate_from != null
    );
  } catch {
    return false;
  }
}

/** A separate SSH process reads only the requested profile DB. No tunnel swap,
 * dashboard startup, local DB fallback, or remote gateway-epoch inference. */
export async function sshListSubagentSessions(
  config: SshConfig,
  parent: string,
  profile?: string,
): Promise<SubagentSessionSummary[]> {
  if (!parent) return [];
  if (
    profile &&
    (!/^[a-zA-Z0-9_.-]+$/.test(profile) || profile === "." || profile === "..")
  )
    throw new Error("Invalid SSH profile");
  const script = `import json, sqlite3, sys
from pathlib import Path
payload = json.load(sys.stdin)
profile = payload.get("profile") or "default"
home = Path.home() / ".hermes"
if profile != "default": home = home / "profiles" / profile
path = home / "state.db"
if not path.is_file():
 print("[]"); sys.exit(0)
conn = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
columns = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
if not {"parent_session_id", "model_config"}.issubset(columns):
 print("[]"); conn.close(); sys.exit(0)
rows = []
for record in conn.execute("SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC, id ASC", (payload["parent"],)):
 row = dict(record)
 goal = conn.execute("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1", (row["id"],)).fetchone()
 row["delegation_goal"] = goal[0] if goal else row.get("title")
 rows.append(row)
conn.close()
print(json.dumps(rows))`;
  const command = `root="$HOME"/.hermes/hermes-agent; if [ -d "$root" ]; then cd "$root" || exit; fi; python=python3; if [ -x "$root/venv/bin/python" ]; then python="$root/venv/bin/python"; fi; "$python" -c ${shellQuote(script)}`;
  const rows = JSON.parse(
    await sshExec(config, command, JSON.stringify({ parent, profile })),
  ) as Row[];
  return rows
    .filter((row): boolean => isDelegate(row, parent))
    .map(summarize)
    .sort(newestFirst);
}
