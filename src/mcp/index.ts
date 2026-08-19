#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { initConfig, loadConfig, missingFields, configPath } from "../core/config.js";
import { Ssh, shellQuote } from "../core/ssh.js";
import { preflight, setupOwner, createAdminKey, installTheme, setupStatus } from "../core/ghost.js";
import { resolveSite, apacheDirectives, restartGhost } from "../core/site.js";
import { configureGhostMail, sendNotification } from "../core/mail.js";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";

const server = new McpServer({ name: "ghostkit", version: VERSION });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

function sshFor(dir?: string) {
  const cfg = loadConfig(dir);
  return { cfg, ssh: new Ssh(cfg.server) };
}

server.registerTool(
  "init_config",
  {
    title: "Create a blank ghostkit config",
    description:
      "Write a blank ghostkit.config.json for the user to fill in, and report which fields are still required. " +
      "Always the first step. Does not overwrite an existing file.",
    inputSchema: { dir: z.string().optional().describe("Directory to write the config into. Defaults to cwd.") },
  },
  async ({ dir }) => {
    const r = initConfig(dir);
    return json({
      path: r.path,
      created: r.created,
      still_required: r.needsFilling,
      note:
        "Fill the file, then run preflight. Set server.sshcon_alias if the host is managed by sshcon, " +
        "otherwise set server.host/user/ssh_key_path. Leave database.* blank to auto-generate.",
    });
  },
);

server.registerTool(
  "preflight",
  {
    title: "Check the host is ready for Ghost",
    description:
      "Run every host check in one pass: Node version, ghost-cli, database engine, systemd, whether the shell " +
      "user is jailed (a hard blocker), and outbound SMTP. Returns a pass/fail matrix with fix commands. " +
      "Also decides which Ghost major version this host can safely run.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const { cfg, ssh } = sshFor(dir);
    const r = await preflight(ssh, { domain: cfg.site.domain });
    const wanted = cfg.site.ghost_version === "auto" ? r.db.ghostVersion : cfg.site.ghost_version;
    const conflict =
      wanted === "6" && r.db.engine === "mariadb"
        ? "Ghost 6 on MariaDB is not supported. Either set ghost_version to 5 or install MySQL 8."
        : undefined;
    return json({ ...r, resolved_ghost_version: wanted, conflict });
  },
);

server.registerTool(
  "install_ghost",
  {
    title: "Install Ghost bound to loopback",
    description:
      "Install Ghost for the configured domain on a private loopback port under a systemd --user unit. " +
      "The site is NOT publicly reachable afterwards — that is deliberate, so ownership can be claimed first. " +
      "Requires the domain and its shell user (Chroot = None) to already exist on the host.",
    inputSchema: {
      dir: z.string().optional(),
      port: z.number().int().optional().describe("Loopback port. Auto-allocated from 50001 if omitted."),
    },
  },
  async ({ dir, port }) => {
    const { cfg, ssh } = sshFor(dir);
    const pre = await preflight(ssh, { domain: cfg.site.domain });
    if (pre.blocked) {
      return json({ ok: false, error: "preflight blocked", checks: pre.checks.filter((c) => !c.ok) });
    }
    const version = cfg.site.ghost_version === "auto" ? pre.db.ghostVersion : cfg.site.ghost_version;

    // Ship the provisioning script rather than assuming it is on the host.
    const script = readFileSync(resolve(here, "../../scripts/ghost-site-enable"), "utf8");
    const b64 = Buffer.from(script).toString("base64");
    await ssh.must(
      `echo ${shellQuote(b64)} | base64 -d > /usr/local/sbin/ghost-site-enable && chmod +x /usr/local/sbin/ghost-site-enable`,
    );

    const args = [
      `--domain ${shellQuote(cfg.site.domain)}`,
      `--ghost-version ${version}`,
      "--create-db",
      "--install",
      port ? `--port ${port}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const out = await ssh.must(`/usr/local/sbin/ghost-site-enable ${args}`, { timeoutMs: 900_000 });
    const site = await resolveSite(ssh, cfg.site.domain);
    return json({ ok: true, ghost_version: version, site, log: out.slice(-4000) });
  },
);

server.registerTool(
  "setup_owner",
  {
    title: "Claim ownership of the Ghost site",
    description:
      "Create the owner account through Ghost's one-shot Setup API, over loopback, BEFORE the site is public. " +
      "This endpoint is unauthenticated: whoever calls it first owns the site, so never expose the site before " +
      "running this. Idempotent — reports if setup already ran.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const { cfg, ssh } = sshFor(dir);
    const site = await resolveSite(ssh, cfg.site.domain);
    const r = await setupOwner(ssh, site.port, cfg.site.domain, {
      name: cfg.owner.name,
      email: cfg.owner.email,
      password: cfg.owner.password,
      blogTitle: cfg.site.title,
    });
    return json({ ...r, admin_url: `https://${cfg.site.domain}/ghost/` });
  },
);

server.registerTool(
  "create_admin_key",
  {
    title: "Create an Admin API key for themeseed",
    description:
      "Log in as the owner and create a custom integration, returning an Admin API key as {id}:{secret}. " +
      "Pass this to themeseed's add_site — themeseed rejects Content API keys.",
    inputSchema: { dir: z.string().optional(), name: z.string().optional() },
  },
  async ({ dir, name }) => {
    const { cfg, ssh } = sshFor(dir);
    const site = await resolveSite(ssh, cfg.site.domain);
    if (!(await setupStatus(ssh, site.port, cfg.site.domain))) {
      return json({ ok: false, error: "Owner not set up yet — run setup_owner first." });
    }
    const key = await createAdminKey(
      ssh,
      site.port,
      cfg.site.domain,
      { email: cfg.owner.email, password: cfg.owner.password },
      name ?? "ghostkit",
    );
    return json({ ok: true, admin_api_key: key, url: `https://${cfg.site.domain}` });
  },
);

server.registerTool(
  "install_theme",
  {
    title: "Upload and activate a theme",
    description:
      "Download the theme zip from theme.zip_url onto the host, upload it through the Admin API, and activate it. " +
      "Must run BEFORE themeseed generates content — themeseed analyses the ACTIVE theme.",
    inputSchema: {
      dir: z.string().optional(),
      admin_api_key: z.string().describe("From create_admin_key, as {id}:{secret}"),
      zip_url: z.string().optional().describe("Overrides theme.zip_url from the config"),
    },
  },
  async ({ dir, admin_api_key, zip_url }) => {
    const { cfg, ssh } = sshFor(dir);
    const url = zip_url || cfg.theme.zip_url;
    if (!url) return json({ ok: false, error: "No theme zip URL in config or arguments." });
    const site = await resolveSite(ssh, cfg.site.domain);
    const r = await installTheme(ssh, site.port, cfg.site.domain, admin_api_key, url, cfg.theme.activate);
    return json({ ok: true, theme: r });
  },
);

server.registerTool(
  "configure_mail",
  {
    title: "Point Ghost's transactional mail at SendGrid",
    description:
      "Write a root-managed env file owned by the site user and reference it from the systemd unit, then restart " +
      "Ghost. Covers member signup/login links and staff invites. NOTE: Ghost requires Mailgun for bulk " +
      "newsletter sending — SendGrid cannot send newsletters.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const { cfg, ssh } = sshFor(dir);
    if (!cfg.mail.sendgrid_api_key) return json({ ok: false, error: "mail.sendgrid_api_key is empty" });
    const site = await resolveSite(ssh, cfg.site.domain);
    const { envPath } = await configureGhostMail(ssh, {
      domain: cfg.site.domain,
      sysUser: site.sysUser,
      sysGroup: site.sysGroup,
      unitPath: site.unitPath,
      sendgridApiKey: cfg.mail.sendgrid_api_key,
      from: cfg.mail.from,
    });
    const state = await restartGhost(ssh, site);
    return json({
      ok: true,
      env_path: envPath,
      ghost: state,
      warning: "SendGrid covers transactional mail only. Newsletters require Mailgun.",
    });
  },
);

server.registerTool(
  "publish_site",
  {
    title: "Get the Apache directives that make the site public",
    description:
      "Returns the vhost directive block and port. This server does NOT write it — call sshmanager_set_domain_port " +
      "(simplest, includes WebSocket upgrade and ACME passthrough) or sshmanager_update_domain with these " +
      "directives, or paste them into ISPConfig manually. Run this LAST: it is the step that exposes the site.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const { cfg, ssh } = sshFor(dir);
    const site = await resolveSite(ssh, cfg.site.domain);
    const claimed = await setupStatus(ssh, site.port, cfg.site.domain);
    return json({
      port: site.port,
      apache_directives: apacheDirectives(site.port),
      owner_claimed: claimed,
      warning: claimed
        ? undefined
        : "Owner NOT yet claimed. Publishing now lets anyone claim this site. Run setup_owner first.",
      how_to_apply: [
        "sshmanager_set_domain_port({server_id, port}) — regenerates a standard proxy block, or",
        "sshmanager_update_domain({server_id, apache_directives}) — writes these verbatim, or",
        "paste into ISPConfig -> Sites -> Options -> Apache Directives",
      ],
      trap:
        "Never send application_ports to sshmanager_update_domain without apache_directives — it regenerates " +
        "and overwrites the directive block.",
    });
  },
);

server.registerTool(
  "report",
  {
    title: "Summarise the install and optionally email it",
    description:
      "Collect the final state of the site and, when mail.notify_on_complete is set, send the summary via the " +
      "SendGrid API directly (independent of Ghost's own mail config).",
    inputSchema: { dir: z.string().optional(), admin_api_key: z.string().optional() },
  },
  async ({ dir, admin_api_key }) => {
    const { cfg, ssh } = sshFor(dir);
    const site = await resolveSite(ssh, cfg.site.domain);
    const state = await ssh.exec(
      `su - ${shellQuote(site.shellUser)} -c 'systemctl --user is-active ghost' 2>/dev/null`,
    );
    const summary = {
      url: `https://${cfg.site.domain}`,
      admin_url: `https://${cfg.site.domain}/ghost/`,
      owner_email: cfg.owner.email,
      port: site.port,
      ghost_dir: site.ghostDir,
      shell_user: site.shellUser,
      service: state.stdout.trim(),
      admin_api_key: admin_api_key ?? "(not requested)",
    };

    let notified: unknown = "not configured";
    if (cfg.mail.notify_on_complete && cfg.mail.sendgrid_api_key) {
      notified = await sendNotification({
        apiKey: cfg.mail.sendgrid_api_key,
        to: cfg.mail.notify_on_complete,
        from: cfg.mail.from || `noreply@${cfg.site.domain}`,
        subject: `Ghost ready: ${cfg.site.domain}`,
        text: Object.entries(summary)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
      });
    }
    return json({ summary, notified });
  },
);

server.registerTool(
  "config_status",
  {
    title: "Show which config fields are still missing",
    description: "Read ghostkit.config.json and report the fields that still block a run.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const path = configPath(dir);
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      return json({ path, still_required: missingFields(raw) });
    } catch (e) {
      return json({ path, error: (e as Error).message, hint: "Run init_config first." });
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[ghostkit] ghostkit MCP server ${VERSION} ready on stdio`);
