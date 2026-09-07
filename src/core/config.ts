import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = "ghostkit.config.json";

export const ConfigSchema = z.object({
  site: z.object({
    domain: z.string(),
    /** Loopback port. resolve_server fills this from sshcon's Application Port. */
    port: z.number().int().nullable().default(null),
  }),
  server: z.object({
    /** The domain's own sshcon alias, e.g. "bastian-ghost". The only field an
     *  sshcon user fills in; resolve_server derives the rest from it. */
    sshcon_alias: z.string().default(""),
    /** Root-capable alias for the host, from sshcon's "Server Name".
     *  Provisioning runs through this: the domain alias is an unprivileged
     *  tenant login on the same box. */
    exec_alias: z.string().default(""),
    host: z.string().default(""),
    user: z.string().default("root"),
    port: z.number().int().default(22),
    ssh_key_path: z.string().default(""),
  }),
  /** Blank means ghostkit derives a name from the domain and generates a password. */
  database: z.object({
    name: z.string().default(""),
    user: z.string().default(""),
    password: z.string().default(""),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Blank template. Nothing is pre-answered: a value in this file is a decision
 * the user made, never one ghostkit guessed for them.
 */
const BLANK = {
  _readme: [
    "Set site.domain, then supply the server one of two ways:",
    "(a) sshcon: set server.sshcon_alias to the domain's alias and run resolve_server —",
    "    it fills the host, the root exec alias, the database and the port for you.",
    "(b) no sshcon: fill server.host, server.user, server.ssh_key_path and the whole",
    "    database block by hand — nothing can discover them for you.",
    "Then run preflight, install_ghost, publish_site. ghostkit installs Ghost and stops:",
    "you create the owner account yourself at https://<domain>/ghost/.",
  ],
  site: { domain: "", port: null },
  server: { sshcon_alias: "" },
  database: { name: "", user: "", password: "" },
};

/**
 * Node's resolve() treats a leading "~" as a literal directory name — only a
 * shell expands it — so "~/sites/x" would silently resolve under "<cwd>/~".
 */
function expandHome(dir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return resolve(homedir(), dir.slice(2));
  return dir;
}

export function configPath(dir = process.cwd()): string {
  return resolve(expandHome(dir), CONFIG_FILENAME);
}

export function initConfig(dir = process.cwd()): { path: string; created: boolean; needsFilling: string[] } {
  const path = configPath(dir);
  const created = !existsSync(path);
  if (created) writeFileSync(path, JSON.stringify(BLANK, null, 2) + "\n");
  return { path, created, needsFilling: missingFields(created ? BLANK : readRaw(path)) };
}

function readRaw(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Everything that still blocks a run, reported in one pass. */
export function missingFields(raw: unknown): string[] {
  const c = raw as Record<string, Record<string, unknown>>;
  const missing: string[] = [];
  const need = (path: string, v: unknown) => {
    if (v === undefined || v === null || v === "") missing.push(path);
  };
  need("site.domain", c?.site?.domain);

  // Either sshcon can be asked for the connection details, or all of them —
  // including the panel's database — are supplied by hand.
  if (!c?.server?.sshcon_alias) {
    if (!c?.server?.host) {
      missing.push("server.sshcon_alias OR server.host");
    } else {
      need("server.user", c?.server?.user);
      need("database.name", c?.database?.name);
      need("database.user", c?.database?.user);
      need("database.password", c?.database?.password);
    }
  }
  return missing;
}

export function loadConfig(dir = process.cwd()): Config {
  const path = configPath(dir);
  if (!existsSync(path)) {
    throw new Error(`No ${CONFIG_FILENAME} found. Run init_config first.`);
  }
  const raw = readRaw(path);
  const missing = missingFields(raw);
  if (missing.length) {
    throw new Error(`${CONFIG_FILENAME} is incomplete. Fill in: ${missing.join(", ")}`);
  }
  return ConfigSchema.parse(raw);
}
