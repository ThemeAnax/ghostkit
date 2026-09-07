#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { initConfig, loadConfig, missingFields, configPath, writeConfigFile } from "../core/config.js";
import { Ssh, shellQuote } from "../core/ssh.js";
import { preflight, setupStatus, installedVersion, waitForGhost } from "../core/ghost.js";
import { resolveSite, apacheDirectives, serviceState } from "../core/site.js";
import { readSshconServer } from "../core/sshcon.js";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.2.1";

const server = new McpServer({ name: "ghostkit", version: VERSION });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

function sshFor(dir?: string) {
  const cfg = loadConfig(dir);
  return { cfg, ssh: new Ssh(cfg.server) };
}

/** What the user does after ghostkit steps back. Kept in one place. */
function nextSteps(domain: string, ghostDir: string, shellUser: string) {
  return {
    "1_create_your_admin_account": `Open https://${domain}/ghost/ and create the owner account. ` +
      `This endpoint is unauthenticated and one-shot — the FIRST person to open it owns the site. Do it now.`,
    "2_install_a_theme": `Ghost admin -> Settings -> Design -> Change theme -> Upload theme, and pick your zip.`,
    "3_set_up_email_sendgrid": [
      `Transactional mail (member logins, staff invites, password resets) needs SMTP.`,
      `As ${shellUser}:  cd ${ghostDir} && ghost config mail.transport SMTP \\`,
      `  && ghost config mail.options.service SendGrid \\`,
      `  && ghost config mail.options.auth.user apikey \\`,
      `  && ghost config mail.options.auth.pass '<SG.your-key>' \\`,
      `  && ghost config mail.from 'noreply@${domain}'`,
      `Newsletters (bulk mail) are Mailgun-only in Ghost; SendGrid cannot send them.`,
    ].join("\n"),
    "4_re_enable_the_sign_in_code": `ghostkit set security.staffDeviceVerification=false in ` +
      `${ghostDir}/config.production.json, because Ghost emails a sign-in code and, with no mail ` +
      `configured, that locks you out of your own site. Once step 3 works, set it back to true.`,
    "5_restart": `As ${shellUser}:  systemctl --user restart ghost   (no sudo needed)`,
    "6_admin_api_key_for_themeseed": `Ghost admin -> Settings -> Integrations -> Add custom integration. ` +
      `Copy the Admin API key ({id}:{secret}) and give it to themeseed's add_site. ` +
      `themeseed rejects Content API keys.`,
  };
}

server.registerTool(
  "init_config",
  {
    title: "Create a blank ghostkit config",
    description:
      "Write a blank ghostkit.config.json and report which fields still need filling. Always the first step. " +
      "Does not overwrite an existing file.",
    inputSchema: { dir: z.string().optional().describe("Directory for the config. Defaults to cwd.") },
  },
  async ({ dir }) => {
    const r = initConfig(dir);
    return json({
      path: r.path,
      created: r.created,
      still_required: r.needsFilling,
      note: "With sshcon: set server.sshcon_alias, then run resolve_server. Without it, fill server.host, server.user, server.ssh_key_path and the database block by hand.",
    });
  },
);

server.registerTool(
  "resolve_server",
  {
    title: "Fill server and database details from an sshcon alias",
    description:
      "Read `sshcon list <alias> all` and write what it knows into the config: the root exec alias (from the " +
      "alias's Server Name), SSH host and port, the database the panel provisioned, and the allocated " +
      "application port. Without sshcon those fields must be filled in by hand. Secrets go to the config file, " +
      "never into the response.",
    inputSchema: {
      dir: z.string().optional(),
      alias: z.string().optional().describe("Overrides server.sshcon_alias from the config."),
    },
  },
  async ({ dir, alias }) => {
    const path = configPath(dir);
    let raw: Record<string, Record<string, unknown>>;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      return json({ ok: false, path, error: (e as Error).message, hint: "Run init_config first." });
    }

    const useAlias = alias || (raw.server?.sshcon_alias as string) || "";
    if (!useAlias) {
      return json({
        ok: false,
        error: "No server.sshcon_alias set and no alias given.",
        hint: "Set server.sshcon_alias, or fill server.host / server.user / server.ssh_key_path and the database block by hand.",
      });
    }

    const s = await readSshconServer(useAlias);

    // server.user is deliberately untouched: it is the account provisioning
    // runs as, which must be root. s.username is the unprivileged tenant, and
    // the shell user is read back from ISPConfig anyway.
    raw.server = {
      ...(raw.server ?? {}),
      sshcon_alias: useAlias,
      exec_alias: s.serverName || useAlias,
      host: s.host,
      port: s.port,
    };
    raw.database = {
      name: (raw.database?.name as string) || s.database.name,
      user: (raw.database?.user as string) || s.database.user,
      password: (raw.database?.password as string) || s.database.password,
    };
    if (s.appPort && !raw.site?.port) raw.site = { ...(raw.site ?? {}), port: s.appPort };

    // 0600: this write is what puts the database password in the file.
    writeConfigFile(path, raw);

    const mask = (v: string) => (v ? `${v.slice(0, 3)}***(${v.length})` : "");
    return json({
      ok: true,
      path,
      derived: {
        exec_alias: raw.server.exec_alias,
        exec_alias_note: `provisioning runs through '${raw.server.exec_alias}' — the root login for this host`,
        host: s.host,
        ssh_port: s.port,
        tenant_user: s.username,
        application_port: s.appPort,
        database: { name: s.database.name, user: s.database.user, password: mask(s.database.password) },
      },
      still_required: missingFields(raw),
    });
  },
);

server.registerTool(
  "preflight",
  {
    title: "Check the host is ready for Ghost",
    description:
      "Every host check in one pass: the domain and its shell user, Node and ghost-cli AS THE TENANT (root's " +
      "PATH proves nothing about theirs), the database engine, systemd, and whether the shell user is jailed. " +
      "Returns a pass/fail matrix with fix commands.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const { cfg, ssh } = sshFor(dir);
    const r = await preflight(ssh, { domain: cfg.site.domain });
    return json({
      ...r,
      note:
        r.db.engine === "mariadb"
          ? "Ghost officially supports MySQL 8 only; MariaDB is unsupported but works in practice."
          : undefined,
    });
  },
);

server.registerTool(
  "install_ghost",
  {
    title: "Install the latest Ghost into the domain's web folder",
    description:
      "Install Ghost on a private loopback port under a systemd --user unit, in the domain's own web folder. " +
      "Installs the LATEST Ghost. Creates no owner account and no theme — you do that yourself at /ghost/ " +
      "afterwards. The site is NOT publicly reachable until publish_site.",
    inputSchema: {
      dir: z.string().optional(),
      port: z.number().int().optional().describe("Loopback port. Defaults to site.port, else auto-allocated from 50001."),
      ghost_version: z.string().optional().describe("Pin a major version, e.g. \"5\". Default: latest."),
      wipe: z
        .boolean()
        .optional()
        .describe("Clear the web folder even when it holds files that are not ISPConfig defaults or a previous Ghost."),
    },
  },
  async ({ dir, port, ghost_version, wipe }) => {
    const { cfg, ssh } = sshFor(dir);
    const pre = await preflight(ssh, { domain: cfg.site.domain });
    if (pre.blocked) {
      return json({ ok: false, error: "preflight blocked", checks: pre.checks.filter((c) => !c.ok) });
    }

    // Ship the script rather than assuming it is already on the host.
    const script = readFileSync(resolve(here, "../../scripts/ghost-site-enable"), "utf8");
    const b64 = Buffer.from(script).toString("base64");
    await ssh.must(
      `echo ${shellQuote(b64)} | base64 -d > /usr/local/sbin/ghost-site-enable && chmod +x /usr/local/sbin/ghost-site-enable`,
    );

    const effectivePort = port ?? cfg.site.port ?? undefined;
    const args = [
      `--domain ${shellQuote(cfg.site.domain)}`,
      effectivePort ? `--port ${effectivePort}` : "",
      ghost_version ? `--ghost-version ${shellQuote(ghost_version)}` : "",
      wipe ? "--wipe" : "",
      cfg.database.name ? `--dbname ${shellQuote(cfg.database.name)}` : "",
      cfg.database.user ? `--dbuser ${shellQuote(cfg.database.user)}` : "",
      cfg.database.password ? `--dbpass ${shellQuote(cfg.database.password)}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const out = await ssh.must(`/usr/local/sbin/ghost-site-enable ${args}`, { timeoutMs: 900_000 });
    const site = await resolveSite(ssh, cfg.site.domain);
    const up = await waitForGhost(ssh, site.port, cfg.site.domain);

    return json({
      ok: true,
      ghost_version: await installedVersion(ssh, site),
      responding_on_loopback: up,
      site,
      next: "Run publish_site to expose it, then claim the owner account immediately.",
      log: out.slice(-3000),
    });
  },
);

server.registerTool(
  "publish_site",
  {
    title: "Get the vhost directives that make the site public",
    description:
      "Return the Apache directive block and port. This server does NOT write it — apply it with " +
      "sshmanager_update_domain({server_id, apache_directives}), or paste it into ISPConfig. Run this LAST: " +
      "it is the step that exposes the site.",
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
        : `UNCLAIMED. Once this is public, https://${cfg.site.domain}/ghost/ will let ANYONE create the owner ` +
          `account — Ghost's setup endpoint is unauthenticated and one-shot. Open it and claim the site the ` +
          `moment the directives are applied, then run status to confirm.`,
      how_to_apply: [
        "sshmanager_update_domain({server_id, apache_directives}) — writes these verbatim. PREFERRED.",
        "paste into ISPConfig -> Sites -> Options -> Apache Directives",
      ],
      trap:
        "Do NOT use sshmanager_set_domain_port for this. It regenerates its own proxy block and drops " +
        'RequestHeader set X-Forwarded-Proto "https", after which Ghost answers POST ' +
        "/ghost/api/admin/session/ with 201 and no Set-Cookie — so nobody can sign in and the admin UI just " +
        "spins. Same trap applies to sending application_ports to sshmanager_update_domain without " +
        "apache_directives.",
    });
  },
);

server.registerTool(
  "status",
  {
    title: "Is the site up, and has anyone claimed it?",
    description:
      "Probe the live host and report the truth: Ghost version, service state, loopback health, whether the " +
      "public URL answers, and — most importantly — whether the owner account has been claimed yet. Never " +
      "fails; always answers. Safe to run at any point.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const { cfg, ssh } = sshFor(dir);
    const site = await resolveSite(ssh, cfg.site.domain);
    const claimed = await setupStatus(ssh, site.port, cfg.site.domain);
    const loopback = await ssh.curlLoopback(site.port, cfg.site.domain, "/ghost/api/admin/site/");
    const publicProbe = await ssh.exec(
      `curl -sS -o /dev/null -m 15 -w '%{http_code}' ${shellQuote(`https://${cfg.site.domain}/`)} 2>/dev/null || echo 000`,
    );

    return json({
      domain: cfg.site.domain,
      ghost_version: await installedVersion(ssh, site),
      service: await serviceState(ssh, site),
      loopback_http: loopback.status,
      public_http: Number(publicProbe.stdout.trim()) || 0,
      owner_claimed: claimed,
      admin_url: `https://${cfg.site.domain}/ghost/`,
      warning: claimed
        ? undefined
        : "OWNER NOT CLAIMED. If this site is already public, anyone who opens /ghost/ can take it. Claim it now.",
      port: site.port,
      ghost_dir: site.ghostDir,
      shell_user: site.shellUser,
    });
  },
);

server.registerTool(
  "next_steps",
  {
    title: "What the user does after ghostkit steps back",
    description:
      "Print the hand-off instructions: claim the admin account, upload a theme, wire SendGrid, re-enable the " +
      "sign-in code, restart, and create the Admin API key for themeseed. ghostkit does none of these on " +
      "purpose — they are one-time choices that belong to the site owner.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const { cfg, ssh } = sshFor(dir);
    const site = await resolveSite(ssh, cfg.site.domain);
    const claimed = await setupStatus(ssh, site.port, cfg.site.domain);
    return json({
      url: `https://${cfg.site.domain}`,
      admin_url: `https://${cfg.site.domain}/ghost/`,
      owner_claimed: claimed,
      steps: nextSteps(cfg.site.domain, site.ghostDir, site.shellUser),
    });
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
