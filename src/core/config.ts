import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = "ghostkit.config.json";

export const ConfigSchema = z.object({
  site: z.object({
    domain: z.string(),
    title: z.string().default(""),
    /** "auto" resolves to 5 on MariaDB, 6 on MySQL 8. Never 6 on MariaDB. */
    ghost_version: z.union([z.literal("auto"), z.literal("5"), z.literal("6")]).default("auto"),
  }),
  server: z.object({
    /** Preferred when present: an sshcon alias such as "server8". */
    sshcon_alias: z.string().default(""),
    host: z.string().default(""),
    user: z.string().default("root"),
    port: z.number().int().default(22),
    ssh_key_path: z.string().default(""),
    /** Set to let sshmanager provision the domain instead of using an existing one. */
    ispconfig_server_id: z.number().int().nullable().default(null),
  }),
  owner: z.object({
    name: z.string(),
    email: z.string(),
    /** Ghost enforces a 10 character minimum. */
    password: z.string(),
  }),
  theme: z.object({
    zip_url: z.string().default(""),
    activate: z.boolean().default(true),
  }),
  database: z.object({
    name: z.string().default(""),
    user: z.string().default(""),
    password: z.string().default(""),
  }),
  mail: z.object({
    sendgrid_api_key: z.string().default(""),
    from: z.string().default(""),
    notify_on_complete: z.string().default(""),
  }),
  seed: z.object({
    enabled: z.boolean().default(true),
    post_count: z.number().int().default(12),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Blank template written on first run for the user to fill in. */
const BLANK = {
  site: { domain: "", title: "", ghost_version: "auto" },
  server: {
    sshcon_alias: "",
    host: "",
    user: "root",
    port: 22,
    ssh_key_path: "",
    ispconfig_server_id: null,
  },
  owner: { name: "", email: "", password: "" },
  theme: { zip_url: "", activate: true },
  database: { name: "", user: "", password: "" },
  mail: { sendgrid_api_key: "", from: "", notify_on_complete: "" },
  seed: { enabled: true, post_count: 12 },
};

export function configPath(dir = process.cwd()): string {
  return resolve(dir, CONFIG_FILENAME);
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

/**
 * Which fields still block a run. Reported in one pass so the user fills the
 * file once rather than discovering requirements one failure at a time.
 */
export function missingFields(raw: unknown): string[] {
  const c = raw as Record<string, Record<string, unknown>>;
  const missing: string[] = [];
  const need = (path: string, v: unknown) => {
    if (v === undefined || v === null || v === "") missing.push(path);
  };
  need("site.domain", c?.site?.domain);
  need("owner.name", c?.owner?.name);
  need("owner.email", c?.owner?.email);
  need("owner.password", c?.owner?.password);

  // A server is reachable either by sshcon alias or by host — one or the other.
  const hasAlias = Boolean(c?.server?.sshcon_alias);
  const hasHost = Boolean(c?.server?.host);
  if (!hasAlias && !hasHost) missing.push("server.sshcon_alias OR server.host");

  const pw = c?.owner?.password;
  if (typeof pw === "string" && pw.length > 0 && pw.length < 10) {
    missing.push("owner.password (Ghost requires at least 10 characters)");
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
