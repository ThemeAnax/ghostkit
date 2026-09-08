import { chmodSync, closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = "ghostkit.config.json";

export const ConfigSchema = z.object({
  site: z.object({
    domain: z.string(),
    /** Ghost's publication title. Blank falls back to the domain. */
    title: z.string().default(""),
    /** Loopback port. resolve_server fills this from sshcon's Application Port. */
    port: z.number().int().nullable().default(null),
  }),
  /**
   * The owner account, claimed over loopback the moment the install finishes.
   * Ghost's setup endpoint is unauthenticated and works exactly once, so
   * claiming it before the site is public is what makes the site safe to expose.
   */
  admin: z
    .object({
      name: z.string().default(""),
      email: z.string().default(""),
      /** Blank means ghostkit generates one and writes it back here. */
      password: z.string().default(""),
      /** {id}:{secret}, written by create_admin_key. This is a full admin credential. */
      api_key: z.string().default(""),
    })
    .default({ name: "", email: "", password: "", api_key: "" }),
  /** Blank source installs Ghost's bundled default; otherwise a path or URL. */
  theme: z
    .object({
      source: z.string().default(""),
      activate: z.boolean().default(true),
    })
    .default({ source: "", activate: true }),
  branding: z
    .object({
      description: z.string().default(""),
      /** Blank derives a stable colour from the title. */
      accent_color: z.string().default(""),
      generate_assets: z.boolean().default(true),
      navigation: z
        .array(z.object({ label: z.string(), url: z.string() }))
        .default([]),
    })
    .default({ description: "", accent_color: "", generate_assets: true, navigation: [] }),
  /** SendGrid covers transactional mail only; Ghost sends newsletters via Mailgun. */
  mail: z
    .object({
      sendgrid_api_key: z.string().default(""),
      from: z.string().default(""),
    })
    .default({ sendgrid_api_key: "", from: "" }),
  /** Byline for generated content. Optional; themeseed asks per blog without it. */
  author: z
    .object({
      name: z.string().default(""),
      email: z.string().default(""),
    })
    .default({ name: "", email: "" }),
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
    "Set site.domain and admin.name / admin.email, then supply the server one of two ways:",
    "(a) sshcon: set server.sshcon_alias to the domain's alias and run resolve_server —",
    "    it fills the host, the root exec alias, the database and the port for you.",
    "(b) no sshcon: fill server.host, server.user, server.ssh_key_path and the whole",
    "    database block by hand — nothing can discover them for you.",
    "Leave admin.password blank and ghostkit generates one, writes it back here, and",
    "returns it. Then run preflight, install_ghost, publish_site.",
  ],
  site: { domain: "", title: "", port: null },
  admin: { name: "", email: "", password: "", api_key: "" },
  theme: { source: "", activate: true },
  branding: { description: "", accent_color: "", generate_assets: true, navigation: [] },
  mail: { sendgrid_api_key: "", from: "" },
  author: { name: "", email: "" },
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

/**
 * This file holds the database password, so it must never exist
 * world-readable — not even for the instant between create and chmod. The
 * mode passed to open() applies only on creation, so an already-present file
 * (created 0644 by an earlier version) is corrected explicitly.
 */
export function writeConfigFile(path: string, data: unknown): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

export function initConfig(dir = process.cwd()): { path: string; created: boolean; needsFilling: string[] } {
  const path = configPath(dir);
  const created = !existsSync(path);
  if (created) writeConfigFile(path, BLANK);
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
  // The owner is claimed automatically, so these are needed before install —
  // not afterwards. A name and an email cannot be invented; a password can.
  need("admin.name", c?.admin?.name);
  need("admin.email", c?.admin?.email);
  const pw = c?.admin?.password;
  if (typeof pw === "string" && pw.length > 0 && pw.length < 10) {
    missing.push("admin.password (Ghost requires at least 10 characters; leave blank to generate one)");
  }

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
