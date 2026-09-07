import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SshconServer {
  alias: string;
  /** The alias of the HOST this domain sits on — normally a root login. */
  serverName: string;
  appPort: number | null;
  host: string;
  port: number;
  username: string;
  password: string;
  authType: string;
  postLoginPath: string;
  database: { name: string; user: string; password: string };
  adminUrl: string;
}

/** sshcon colours its output; only the values matter here. */
function stripAnsi(s: string): string {
  return s.replace(/\u001B\[[0-9;]*m/g, "");
}

/** sshcon renders an unset field as an em dash. */
function clean(v: string): string {
  const t = v.trim();
  return t === "—" || t === "-" ? "" : t;
}

const SECTION_NAMES = ["General", "SSH Connection", "MySQL", "FTP", "Admin Panel"] as const;
type Section = (typeof SECTION_NAMES)[number];

/**
 * Parse `sshcon list <alias> all`. Labels repeat across sections — "Password"
 * appears under SSH, MySQL and FTP alike — so the section heading has to be
 * tracked rather than matching labels globally.
 */
export function parseSshconList(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let section: Section | "" = "";

  for (const line of stripAnsi(raw).split("\n")) {
    const heading = SECTION_NAMES.find((n) => new RegExp(`^\\s*\\S*\\s*${n}\\s*$`).test(line));
    if (heading) {
      section = heading;
      continue;
    }
    const m = line.match(/^\s{2,}(\S.*?)\s{2,}(.+?)\s*$/);
    if (m && section) out.set(`${section}.${m[1].trim()}`, clean(m[2]));
  }
  return out;
}

/**
 * Read everything sshcon already knows about a provisioned domain, so the user
 * names one alias instead of copying host, credentials, database and port by
 * hand. Hand-copied values are exactly where these installs go wrong.
 */
export async function readSshconServer(alias: string): Promise<SshconServer> {
  let stdout = "";
  try {
    ({ stdout } = await run("sshcon", ["list", alias, "all", "--reveal"], { timeout: 30_000 }));
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    stdout = err.stdout ?? "";
    if (!stdout.trim()) throw new Error(`sshcon list ${alias} failed: ${err.stderr || err.message}`);
  }

  const f = parseSshconList(stdout);
  const get = (k: string) => f.get(k) ?? "";
  if (!get("SSH Connection.Host")) {
    throw new Error(`sshcon returned no SSH host for '${alias}'. Is the alias spelled correctly?`);
  }

  const appPort = Number(get("General.Application Port"));
  return {
    alias,
    serverName: get("General.Server Name"),
    appPort: Number.isFinite(appPort) && appPort > 0 ? appPort : null,
    host: get("SSH Connection.Host"),
    port: Number(get("SSH Connection.Port")) || 22,
    username: get("SSH Connection.Username"),
    password: get("SSH Connection.Password"),
    authType: get("SSH Connection.Auth Type"),
    postLoginPath: get("SSH Connection.Post-Login Path"),
    database: {
      name: get("MySQL.Database"),
      user: get("MySQL.User"),
      password: get("MySQL.Password"),
    },
    adminUrl: get("Admin Panel.URL"),
  };
}

/** Whether the sshcon CLI is on PATH at all. */
export async function sshconAvailable(): Promise<boolean> {
  try {
    await run("sshcon", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
