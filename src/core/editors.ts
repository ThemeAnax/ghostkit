import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The package name users install. Kept in one place. */
export const PACKAGE = "@indianic/ghostkit";
export const SERVER_NAME = "ghostkit";

/**
 * `npx -y ...@latest` re-resolves the registry on every launch, so an editor
 * always starts the newest published build. That — not a server that rewrites
 * its own code mid-session — is how an MCP stays up to date safely.
 */
export function launchCommand(): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", "--package", `${PACKAGE}@latest`, "ghostkit-mcp"] };
}

type Format = "json-mcpServers" | "json-servers" | "json-context_servers" | "toml-codex" | "cli-agy";

export interface EditorDef {
  id: string;
  label: string;
  /** Config file we read and write. For cli-agy this is where the CLI stores things. */
  path: string;
  format: Format;
  /** A CLI that, if present, is a better signal than the file existing. */
  cli?: string;
}

export const EDITORS: EditorDef[] = [
  { id: "claude", label: "Claude Code", path: join(homedir(), ".claude.json"), format: "json-mcpServers", cli: "claude" },
  { id: "codex", label: "Codex", path: join(homedir(), ".codex/config.toml"), format: "toml-codex", cli: "codex" },
  { id: "cursor", label: "Cursor", path: join(homedir(), ".cursor/mcp.json"), format: "json-mcpServers", cli: "cursor" },
  {
    id: "windsurf",
    label: "Windsurf",
    path: join(homedir(), ".codeium/windsurf/mcp_config.json"),
    format: "json-mcpServers",
  },
  { id: "gemini", label: "Gemini CLI", path: join(homedir(), ".gemini/settings.json"), format: "json-mcpServers", cli: "gemini" },
  {
    id: "antigravity",
    label: "Antigravity",
    path: join(homedir(), ".gemini/config/mcp_config.json"),
    format: "cli-agy",
    cli: "agy",
  },
  { id: "zed", label: "Zed", path: join(homedir(), ".config/zed/settings.json"), format: "json-context_servers" },
  {
    id: "vscode",
    label: "VS Code",
    path: join(homedir(), "Library/Application Support/Code/User/mcp.json"),
    format: "json-servers",
  },
];

/** These files are JSONC in practice — VS Code and Zed both allow comments. */
function parseLoose(raw: string): Record<string, unknown> {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return stripped.trim() ? (JSON.parse(stripped) as Record<string, unknown>) : {};
}

/**
 * Editor config files are the user's, not ours, and rewriting JSON drops any
 * comments they had. Keep a timestamped copy before touching one.
 */
function backup(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const to = `${path}.ghostkit-bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(path, to);
  return to;
}

function serverKey(format: Format): string {
  if (format === "json-servers") return "servers";
  if (format === "json-context_servers") return "context_servers";
  return "mcpServers";
}

export interface EditorStatus {
  id: string;
  label: string;
  path: string;
  /** The config exists, or its CLI is installed. */
  detected: boolean;
  registered: boolean;
  /** What it currently launches, when registered. */
  current?: string;
  /** Already pointing at the published package rather than a local build. */
  usesLatest?: boolean;
  note?: string;
}

async function hasCli(cli?: string): Promise<boolean> {
  if (!cli) return false;
  try {
    await run("command", ["-v", cli], { shell: true as never });
    return true;
  } catch {
    return false;
  }
}

/** Read what an editor currently has, without changing anything. */
export async function detectEditor(def: EditorDef): Promise<EditorStatus> {
  const cliPresent = await hasCli(def.cli);
  const filePresent = existsSync(def.path);
  const base: EditorStatus = {
    id: def.id,
    label: def.label,
    path: def.path,
    detected: cliPresent || filePresent,
    registered: false,
  };
  if (!filePresent) return base;

  try {
    if (def.format === "toml-codex") {
      const raw = readFileSync(def.path, "utf8");
      const m = raw.match(new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]([\\s\\S]*?)(?=^\\[|\\Z)`, "m"));
      if (!m) return base;
      const cmd = m[1].match(/^command\s*=\s*"([^"]*)"/m)?.[1] ?? "";
      const args = m[1].match(/^args\s*=\s*\[(.*)\]/m)?.[1] ?? "";
      const current = `${cmd} ${args.replace(/"/g, "").replace(/,\s*/g, " ")}`.trim();
      return { ...base, registered: true, current, usesLatest: current.includes(`${PACKAGE}@latest`) };
    }

    const doc = parseLoose(readFileSync(def.path, "utf8"));
    const bucket = (doc[serverKey(def.format)] ?? {}) as Record<string, { command?: string; args?: string[] }>;
    const entry = bucket[SERVER_NAME];
    if (!entry) return base;
    const current = [entry.command, ...(entry.args ?? [])].filter(Boolean).join(" ");
    return { ...base, registered: true, current, usesLatest: current.includes(`${PACKAGE}@latest`) };
  } catch (e) {
    return { ...base, note: `could not read config: ${(e as Error).message}` };
  }
}

export async function detectAll(): Promise<EditorStatus[]> {
  return Promise.all(EDITORS.map(detectEditor));
}

export interface RegisterResult {
  id: string;
  label: string;
  ok: boolean;
  action: "created" | "updated" | "unchanged" | "failed" | "skipped";
  path: string;
  backup?: string;
  error?: string;
}

/** Add or update the ghostkit entry in one editor. */
export async function registerEditor(def: EditorDef, opts: { force?: boolean } = {}): Promise<RegisterResult> {
  const { command, args } = launchCommand();
  const base = { id: def.id, label: def.label, path: def.path };

  try {
    const before = await detectEditor(def);
    if (before.registered && before.usesLatest && !opts.force) {
      return { ...base, ok: true, action: "unchanged" };
    }

    // Antigravity owns its own config format; let its CLI write it.
    if (def.format === "cli-agy") {
      if (!(await hasCli("agy"))) {
        return { ...base, ok: false, action: "skipped", error: "the 'agy' CLI is not installed" };
      }
      await run("agy", ["mcp", "add", "-t", "stdio", SERVER_NAME, command, ...args]);
      return { ...base, ok: true, action: before.registered ? "updated" : "created" };
    }

    const bak = backup(def.path);

    if (def.format === "toml-codex") {
      const raw = existsSync(def.path) ? readFileSync(def.path, "utf8") : "";
      const block =
        `[mcp_servers.${SERVER_NAME}]\n` +
        `command = "${command}"\n` +
        `args = [${args.map((a) => `"${a}"`).join(", ")}]\n` +
        `type = "stdio"\n`;
      // Replace only our own section, so the rest of the file — hooks,
      // comments, other servers — survives untouched.
      const re = new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\][\\s\\S]*?(?=^\\[|\\Z)`, "m");
      const next = re.test(raw) ? raw.replace(re, block + "\n") : `${raw.trimEnd()}\n\n${block}`;
      mkdirSync(dirname(def.path), { recursive: true });
      writeFileSync(def.path, next);
      return { ...base, ok: true, action: before.registered ? "updated" : "created", backup: bak };
    }

    const doc = existsSync(def.path) ? parseLoose(readFileSync(def.path, "utf8")) : {};
    const key = serverKey(def.format);
    const bucket = (doc[key] ?? {}) as Record<string, unknown>;
    bucket[SERVER_NAME] =
      def.format === "json-servers"
        ? { type: "stdio", command, args }
        : def.format === "json-context_servers"
          ? { command, args, env: {} }
          : { type: "stdio", command, args, env: {} };
    doc[key] = bucket;
    mkdirSync(dirname(def.path), { recursive: true });
    writeFileSync(def.path, JSON.stringify(doc, null, 2) + "\n");
    return { ...base, ok: true, action: before.registered ? "updated" : "created", backup: bak };
  } catch (e) {
    return { ...base, ok: false, action: "failed", error: (e as Error).message };
  }
}

/** What npm says is newest, versus what is running. */
export async function latestVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await run("npm", ["view", PACKAGE, "version"], { timeout: 20_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
