#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type { Config } from "../core/config.js";
import { initConfig, loadConfig, missingFields, configPath, writeConfigFile } from "../core/config.js";
import { Ssh, shellQuote } from "../core/ssh.js";
import {
  preflight,
  setupStatus,
  setupOwner,
  generatePassword,
  installedVersion,
  waitForGhost,
  createAdminKey,
  installTheme,
  uploadRoutes,
  uploadRoutesAsOwner,
  importContent,
  contentCount,
  configureMail,
} from "../core/ghost.js";
import type { SiteLayout } from "../core/site.js";
import {
  resolveSite,
  apacheDirectives,
  serviceState,
  restartGhost,
  applyVhost,
  ipBoundVhosts,
  ispconfigIpBinding,
  repairIpBinding,
  checkGhostPort,
  suggestGhostPort,
  GHOST_PORT_MIN,
  GHOST_PORT_MAX,
} from "../core/site.js";
import { readSshconServer } from "../core/sshcon.js";
import { applyBranding } from "../core/branding.js";
import { EDITORS, detectAll, registerEditor, latestVersion, launchCommand, PACKAGE } from "../core/editors.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Read the version rather than restating it. Hardcoding it here means a
 * release can ship with the number from the one before — which it did: 0.6.0
 * went out announcing itself as 0.5.0, so `version` reported an update that
 * was already installed.
 *
 * dist/mcp/index.js and the esbuild bundle in plugin/ sit at different depths,
 * so try both rather than assuming one layout.
 */
const VERSION: string = (() => {
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const p = resolve(here, rel);
      if (existsSync(p)) {
        const v = JSON.parse(readFileSync(p, "utf8")).version;
        if (typeof v === "string" && v) return v;
      }
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
})();

const server = new McpServer({ name: "ghostkit", version: VERSION });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

function sshFor(dir?: string) {
  const cfg = loadConfig(dir);
  return { cfg, ssh: new Ssh(cfg.server) };
}

/**
 * Find scripts/ghost-site-enable. The server runs from three different layouts
 * — dist/mcp/ when installed from npm, plugin/ as a single bundled file inside
 * a Claude Code plugin, and src/mcp/ in development — so a single relative path
 * would break two of them.
 */
function provisioningScript(): string {
  const candidates = [
    resolve(here, "../../scripts/ghost-site-enable"), // dist/mcp/  -> repo root
    resolve(here, "../scripts/ghost-site-enable"), // plugin/    -> repo root
    resolve(here, "scripts/ghost-site-enable"), // repo root itself
    resolve(process.cwd(), "scripts/ghost-site-enable"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Could not find scripts/ghost-site-enable. Looked in:\n  ${candidates.join("\n  ")}`,
    );
  }
  return found;
}

/**
 * Claim the owner account, generating a password when the config leaves one
 * blank. A generated password is written back to the config first: it is the
 * only record of it, and a secret that exists solely in a tool result is gone
 * the moment the conversation scrolls away.
 */
async function claimOwner(
  dir: string | undefined,
  ssh: Ssh,
  cfg: Config,
  site: SiteLayout,
): Promise<{ alreadySetUp: boolean; password: string; generated: boolean; blogTitle: string }> {
  // Check first. Generating before knowing would write a password into the
  // config for a site claimed by some other account — a stored secret that
  // looks authoritative and opens nothing.
  if (await setupStatus(ssh, site.port, cfg.site.domain)) {
    return {
      alreadySetUp: true,
      password: cfg.admin.password,
      generated: false,
      blogTitle: cfg.site.title?.trim() || cfg.site.domain,
    };
  }

  let password = cfg.admin.password;
  let generated = false;

  if (!password) {
    password = generatePassword();
    generated = true;
    const path = configPath(dir);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
    raw.admin = { ...(raw.admin ?? {}), password };
    writeConfigFile(path, raw);
  }

  const r = await setupOwner(ssh, site.port, cfg.site.domain, {
    name: cfg.admin.name,
    email: cfg.admin.email,
    password,
    blogTitle: cfg.site.title,
  });
  return { alreadySetUp: r.alreadySetUp, password, generated, blogTitle: r.blogTitle };
}

/** What the user does after ghostkit steps back. Kept in one place. */
function nextSteps(domain: string, ghostDir: string, shellUser: string) {
  return {
    "1_sign_in": `Sign in at https://${domain}/ghost/ with admin.email and admin.password from your ` +
      `ghostkit.config.json. ghostkit already claimed the owner account over loopback, before the site was ` +
      `public, so nobody else could take it. Change the password once you are in.`,
    "2_theme": `If you did not set theme.source, the site is on Ghost's default theme. Set it and run ` +
      `install_theme, or upload one in Settings -> Design.`,
    "3_email": `Run configure_mail with a SendGrid key for transactional mail — member logins, staff invites, ` +
      `password resets. Newsletters are Mailgun-only in Ghost; no SendGrid key changes that.`,
    "4_re_enable_the_sign_in_code": `ghostkit set security.staffDeviceVerification to false at install, because ` +
      `Ghost emails a code on every sign-in and with no mail configured that locks you out of your own site. ` +
      `Once step 3 works, set it back to true in ${ghostDir}/config.production.json and restart.`,
    "5_restart": `As ${shellUser}:  systemctl --user restart ghost   (no sudo needed)`,
    "6_themeseed": `admin.api_key in your config is the Admin API key, as {id}:{secret}. Hand it to themeseed's ` +
      `add_site so it can write articles. Run create_admin_key if it is still blank.`,
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
      note:
        "With sshcon: set server.sshcon_alias (the SITE's alias) and server.exec_alias (the HOST's root " +
        'alias, e.g. "server4"), then run resolve_server. These are two different things and exec_alias ' +
        "cannot be derived from the other — ask which host the site belongs on rather than guessing. " +
        "Without sshcon, fill server.host, server.user, server.ssh_key_path and the database block by hand.",
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
    // Keep an exec_alias the caller already set: they know which host they meant,
    // and sshcon's "Server Name" is only a hint. Never fall back to useAlias —
    // that is the domain's own tenant login, so writing it here would look like
    // a resolved host while being an account that cannot provision anything.
    const existingExec = (raw.server?.exec_alias as string) || "";
    raw.server = {
      ...(raw.server ?? {}),
      sshcon_alias: useAlias,
      exec_alias: existingExec || s.serverName || "",
      host: s.host,
      port: s.port,
    };
    raw.database = {
      name: (raw.database?.name as string) || s.database.name,
      user: (raw.database?.user as string) || s.database.user,
      password: (raw.database?.password as string) || s.database.password,
    };
    // Only adopt the panel's application port when it is inside the Ghost range.
    // ISPConfig allocates PHP-FPM pool ports from 9000–9099 and knows nothing
    // about Ghost; copying one of those in is how php-fpm later fails to bind.
    const appPortUsable =
      !!s.appPort && s.appPort >= GHOST_PORT_MIN && s.appPort <= GHOST_PORT_MAX;
    if (appPortUsable && !raw.site?.port) raw.site = { ...(raw.site ?? {}), port: s.appPort };

    // 0600: this write is what puts the database password in the file.
    writeConfigFile(path, raw);

    // Earliest point ghostkit can see a freshly provisioned site. Provisioning
    // defaults a new site to the host's literal IP instead of "*", and such a
    // vhost outranks every wildcard one on the address — the new site starts
    // answering for every hostname on the box within seconds of being created,
    // long before preflight or publish_site would have caught it. Report it
    // here so the window is seconds rather than a whole install.
    let ipBinding: string | null = null;
    const domain = (raw.site?.domain as string) || "";
    if (domain) {
      try {
        ipBinding = await ispconfigIpBinding(sshFor(dir).ssh, domain);
      } catch {
        // No usable SSH yet is normal mid-provision; preflight checks again.
      }
    }

    const mask = (v: string) => (v ? `${v.slice(0, 3)}***(${v.length})` : "");
    return json({
      ok: true,
      path,
      derived: {
        exec_alias: raw.server.exec_alias || null,
        exec_alias_note: raw.server.exec_alias
          ? `provisioning runs through '${raw.server.exec_alias}' — the root login for this host`
          : `sshcon has no "Server Name" for '${useAlias}', so the host is unknown. Set server.exec_alias ` +
            `to the host's root alias (e.g. "server4") — ASK which host rather than guessing, since the ` +
            `wrong one provisions a site on somebody else's server.`,
        host: s.host,
        ssh_port: s.port,
        tenant_user: s.username,
        application_port: s.appPort,
        application_port_note: s.appPort
          ? appPortUsable
            ? undefined
            : `sshcon records application port ${s.appPort}, which is OUTSIDE the Ghost range ` +
              `${GHOST_PORT_MIN}–${GHOST_PORT_MAX}, so it was NOT written to site.port. If it sits in ` +
              `9000–9099 it belongs to ISPConfig's PHP-FPM pools: taking it would make php-fpm fail to bind ` +
              `later and drop every PHP site on the host. install_ghost will pick a safe port.`
          : undefined,
        database: { name: s.database.name, user: s.database.user, password: mask(s.database.password) },
        ip_binding: ipBinding ?? undefined,
        ip_binding_note:
          ipBinding && ipBinding !== "*"
            ? `STOP — this site is bound to ${ipBinding} instead of "*", so it is ALREADY answering for every ` +
              `other hostname on this host: they get this site's certificate and then a 403. Run ` +
              `repair_ip_binding on this domain before anything else, then carry on. Provisioning defaults to ` +
              `the host's literal IP, so pass ip_address "*" when creating the site to avoid this entirely.`
            : undefined,
      },
      still_required: missingFields(raw),
    });
  },
);

server.registerTool(
  "repair_ip_binding",
  {
    title: "Put a site back on a wildcard IP binding",
    description:
      "Fixes a site that binds a literal IP instead of '*', cause first: sets ISPConfig's ip_address column " +
      "back to '*', then rewrites any IP-bound <VirtualHost> on disk to a wildcard and reloads Apache once " +
      "the config still parses. Apache matches an IP-bound vhost ahead of every wildcard one on the same " +
      "address, so a single such site answers for EVERY hostname on the host — wrong certificate, then 403. " +
      "Rewriting only the file is not enough: the panel regenerates the vhost from that column and the fault " +
      "returns later under a different site's name. Safe to run when nothing is wrong; it reports that nothing " +
      "needed doing.",
    inputSchema: {
      dir: z.string().optional(),
      domain: z.string().optional().describe("Overrides site.domain from the config."),
    },
  },
  async ({ dir, domain }) => {
    const { cfg, ssh } = sshFor(dir);
    const target = domain || cfg.site.domain;
    const r = await repairIpBinding(ssh, target);
    const strays = await ipBoundVhosts(ssh);
    return json({
      ok: true,
      domain: target,
      was_bound_to: r.wasBound ?? undefined,
      vhosts_rewritten: r.files.length ? r.files : undefined,
      apache_reloaded: r.reloaded,
      changed: r.wasBound !== null || r.files.length > 0,
      note:
        r.wasBound === null && r.files.length === 0
          ? "Already on a wildcard binding — nothing to do."
          : undefined,
      remaining_ip_bound_vhosts: strays.length ? strays : undefined,
      remaining_note: strays.length
        ? "Other sites on this host still bind a literal IP and will cause the same outage. Run " +
          "repair_ip_binding for each of them."
        : undefined,
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
    const portCheck = cfg.site.port ? await checkGhostPort(ssh, cfg.site.port) : undefined;
    const strays = await ipBoundVhosts(ssh);
    return json({
      ...r,
      port: portCheck
        ? { ...portCheck, range: `${GHOST_PORT_MIN}-${GHOST_PORT_MAX}` }
        : { configured: null, suggested: await suggestGhostPort(ssh), range: `${GHOST_PORT_MIN}-${GHOST_PORT_MAX}` },
      ip_bound_vhosts: strays.length ? strays : undefined,
      ip_bound_note: strays.length
        ? "These vhosts bind a literal IP. Apache matches an IP-bound vhost before any wildcard one on that " +
          "address, so each of these answers for every other hostname on the box — wrong certificate, then a " +
          "403. Fix the site's IPv4 Address to '*' in ISPConfig; editing the file does not hold."
        : undefined,
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
    const script = readFileSync(provisioningScript(), "utf8");
    const b64 = Buffer.from(script).toString("base64");
    await ssh.must(
      `echo ${shellQuote(b64)} | base64 -d > /usr/local/sbin/ghost-site-enable && chmod +x /usr/local/sbin/ghost-site-enable`,
    );

    // Never let a port outside 51000–51999 reach the host: inside ISPConfig's
    // PHP-FPM pool range it takes the whole php-fpm service down later.
    const chosen = port ?? cfg.site.port ?? (await suggestGhostPort(ssh));
    const verdict = await checkGhostPort(ssh, chosen);
    if (!verdict.ok) {
      return json({
        ok: false,
        error: "unsafe port",
        port: chosen,
        problems: verdict.problems,
        suggested_port: await suggestGhostPort(ssh),
        note:
          `Ghost runs on ${GHOST_PORT_MIN}–${GHOST_PORT_MAX} here. Set site.port to a free port in that range ` +
          `and run this again — do not reuse whatever port ISPConfig allocated, it does not know about Ghost.`,
      });
    }

    const effectivePort = chosen;
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

    // Claim the owner NOW, while Ghost is still bound to 127.0.0.1. The setup
    // endpoint is unauthenticated and one-shot, so this is the only moment it
    // can be done with nobody else able to reach it.
    let owner: Awaited<ReturnType<typeof claimOwner>> | undefined;
    let ownerError: string | undefined;
    if (up) {
      try {
        owner = await claimOwner(dir, ssh, cfg, site);
      } catch (e) {
        ownerError = (e as Error).message;
      }
    } else {
      ownerError = "Ghost did not answer on its loopback port, so the owner could not be claimed.";
    }

    return json({
      ok: true,
      ghost_version: await installedVersion(ssh, site),
      responding_on_loopback: up,
      site,
      owner: owner
        ? {
            claimed: true,
            already_existed: owner.alreadySetUp,
            name: cfg.admin.name,
            email: cfg.admin.email,
            password: owner.password,
            password_generated: owner.generated,
            blog_title: owner.blogTitle,
            admin_url: `https://${cfg.site.domain}/ghost/`,
            note: owner.generated
              ? "Generated and saved to admin.password in your ghostkit.config.json (mode 0600). Save it somewhere you trust."
              : "Taken from admin.password in your config.",
          }
        : { claimed: false, error: ownerError, retry_with: "create_admin" },
      next: owner
        ? "Run publish_site. The site is already claimed, so exposing it is safe."
        : "Fix the error above and run create_admin BEFORE publish_site — an unclaimed public site can be taken by anyone.",
      log: out.slice(-3000),
    });
  },
);

server.registerTool(
  "create_admin",
  {
    title: "Claim the owner account",
    description:
      "Create the Ghost owner through the setup endpoint, over loopback. install_ghost already does this — use " +
      "this tool to retry when that failed, or after an install that predates it. Uses admin.name / admin.email " +
      "from the config, and admin.password if set, otherwise generates one and writes it back. Idempotent: a " +
      "site that is already claimed is reported, never overwritten.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const { cfg, ssh } = sshFor(dir);
    const site = await resolveSite(ssh, cfg.site.domain);
    const owner = await claimOwner(dir, ssh, cfg, site);
    return json({
      ok: true,
      already_existed: owner.alreadySetUp,
      name: cfg.admin.name,
      email: cfg.admin.email,
      // On an already-claimed site this is whatever the config holds, which is
      // not necessarily the password that actually claimed it.
      password: owner.alreadySetUp ? undefined : owner.password,
      password_generated: owner.alreadySetUp ? undefined : owner.generated,
      blog_title: owner.blogTitle,
      admin_url: `https://${cfg.site.domain}/ghost/`,
      note: owner.alreadySetUp
        ? "This site was already claimed. Ghost's setup endpoint works once, so no password was set here — sign in with the account that claimed it, or reset it from Ghost."
        : undefined,
    });
  },
);

/** Read-modify-write the config, preserving 0600. */
function patchConfig(dir: string | undefined, mutate: (raw: Record<string, any>) => void): void {
  const path = configPath(dir);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  mutate(raw);
  writeConfigFile(path, raw);
}

server.registerTool(
  "create_admin_key",
  {
    title: "Create the Admin API key for themeseed",
    description:
      "Sign in as the owner, create (or reuse) a custom integration, and return its Admin API key as " +
      "{id}:{secret} — the form themeseed's add_site expects; it rejects Content API keys. The key is saved to " +
      "admin.api_key in the config. Uses the public Admin API rather than touching the database, so it survives " +
      "Ghost upgrades. Idempotent: an integration of the same name is reused, never duplicated.",
    inputSchema: {
      dir: z.string().optional(),
      name: z.string().optional().describe('Integration name. Default "themeseed".'),
    },
  },
  async ({ dir, name }) => {
    const { cfg, ssh } = sshFor(dir);
    const site = await resolveSite(ssh, cfg.site.domain);
    if (!cfg.admin.password) {
      return json({ ok: false, error: "admin.password is empty — run create_admin first, or fill it in." });
    }
    const key = await createAdminKey(
      ssh,
      site.port,
      cfg.site.domain,
      { email: cfg.admin.email, password: cfg.admin.password },
      name ?? "themeseed",
    );
    patchConfig(dir, (raw) => {
      raw.admin = { ...(raw.admin ?? {}), api_key: key };
    });
    return json({
      ok: true,
      integration: name ?? "themeseed",
      admin_api_key: key,
      saved_to: "admin.api_key",
      note: "This is a full admin credential. The config is 0600; treat it like the owner password.",
    });
  },
);

server.registerTool(
  "install_theme",
  {
    title: "Upload and activate a theme",
    description:
      "Install a theme from theme.source — an http(s) URL, or a path to a zip on THIS machine — and activate " +
      "it. Leave theme.source blank to keep Ghost's bundled default. Also uploads the theme's routes.yaml when " +
      "it ships one. Run this before seeding: themeseed reads the ACTIVE theme, so without it content is " +
      "generated against Casper.",
    inputSchema: {
      dir: z.string().optional(),
      source: z.string().optional().describe("Overrides theme.source. URL or local zip path."),
      activate: z.boolean().optional(),
    },
  },
  async ({ dir, source, activate }) => {
    const { cfg, ssh } = sshFor(dir);
    const src = source || cfg.theme.source;
    if (!src) {
      return json({
        ok: true,
        skipped: "No theme.source set — keeping Ghost's bundled default theme.",
      });
    }
    if (!cfg.admin.api_key) {
      return json({ ok: false, error: "admin.api_key is empty — run create_admin_key first." });
    }
    const site = await resolveSite(ssh, cfg.site.domain);
    const theme = await installTheme(
      ssh,
      site.port,
      cfg.site.domain,
      cfg.admin.api_key,
      src,
      activate ?? cfg.theme.activate,
    );

    // A theme that ships routes.yaml expects it: without it, collection URLs
    // the templates link to simply 404.
    let routes: string | undefined;
    const found = await ssh.exec(
      `ls ${shellQuote(`${site.ghostDir}/content/themes/${theme.name}/routes.yaml`)} 2>/dev/null || true`,
    );
    if (found.stdout.trim()) {
      try {
        // Owner session, not the API key: Ghost answers "API tokens do not
        // have permission to access this endpoint" to a custom integration.
        await uploadRoutesAsOwner(ssh, site.port, cfg.site.domain, cfg.admin, found.stdout.trim(), {
          remote: true,
        });
        routes = "uploaded";
      } catch (e) {
        routes = `failed: ${(e as Error).message}`;
      }
    }
    return json({
      ok: true,
      theme,
      routes_yaml: routes ?? "none shipped with this theme",
      routes_note:
        routes || !cfg.content.routes
          ? undefined
          : "This theme ships no routes.yaml, but content.routes is set — import_content will upload that one.",
    });
  },
);

server.registerTool(
  "configure_mail",
  {
    title: "Point Ghost's transactional mail at SendGrid",
    description:
      "Write the SMTP settings with ghost-cli, which handles the nested config keys itself, then restart. " +
      "Covers staff invites and member signup/login only — Ghost sends NEWSLETTERS through Mailgun " +
      "exclusively, and no SendGrid key changes that. Once mail works you can turn " +
      "security.staffDeviceVerification back on.",
    inputSchema: {
      dir: z.string().optional(),
      sendgrid_api_key: z.string().optional().describe("Overrides mail.sendgrid_api_key."),
      from: z.string().optional().describe('Sender, e.g. "Blog <noreply@example.com>".'),
    },
  },
  async ({ dir, sendgrid_api_key, from }) => {
    const { cfg, ssh } = sshFor(dir);
    const apiKey = sendgrid_api_key || cfg.mail.sendgrid_api_key;
    if (!apiKey) {
      return json({ ok: false, error: "No SendGrid API key in mail.sendgrid_api_key or arguments." });
    }
    const site = await resolveSite(ssh, cfg.site.domain);
    const sender = from || cfg.mail.from || `noreply@${cfg.site.domain}`;
    await configureMail(ssh, site, { apiKey, from: sender });
    const state = await restartGhost(ssh, site);
    patchConfig(dir, (raw) => {
      raw.mail = { ...(raw.mail ?? {}), sendgrid_api_key: apiKey, from: sender };
    });
    return json({
      ok: true,
      from: sender,
      ghost: state,
      warning: "Transactional mail only. Newsletters require Mailgun.",
      next: `Sign-in codes can be re-enabled now: set security.staffDeviceVerification to true in ${site.ghostDir}/config.production.json and restart.`,
    });
  },
);

server.registerTool(
  "import_content",
  {
    title: "Import a Ghost export (demo content) into the site",
    description:
      "Import the universal-import export at content.source — a .json export, or a .zip carrying the " +
      "json plus its content/images — and report what landed. Runs through an OWNER session: Ghost restricts importContent to " +
      "owner/admin users and does not grant it to custom integrations, so the Admin API key every other " +
      "tool here uses is refused with 'You do not have permission to importContent db'. Install and activate " +
      "the theme FIRST — a theme's demo content carries settings keyed to the theme's name, and those are " +
      "dropped if that theme is not active. Also uploads content.routes when set.",
    inputSchema: {
      dir: z.string().optional(),
      source: z
        .string()
        .optional()
        .describe('Overrides content.source. Path on THIS machine to the export — .json or .zip; a bare .json carries no images. Pass "none" to skip the import and only do routes.'),
      routes: z
        .string()
        .optional()
        .describe('Overrides content.routes. Path to routes.yaml on THIS machine. Pass "none" to skip.'),
      force: z
        .boolean()
        .optional()
        .describe("Import even when the site already has content. Ghost APPENDS, so this duplicates it."),
    },
  },
  async ({ dir, source, routes, force }) => {
    const { cfg, ssh } = sshFor(dir);
    // "none" is how you skip one half explicitly; "" falls back to the config,
    // which is what you want when the argument is simply absent.
    const src = source === "none" ? "" : source || cfg.content.source;
    const routesSrc = routes === "none" ? "" : routes || cfg.content.routes;
    if (!src && !routesSrc) {
      return json({ ok: true, skipped: "Neither content.source nor content.routes is set." });
    }
    if (!cfg.admin.email || !cfg.admin.password) {
      return json({
        ok: false,
        error:
          "admin.email and admin.password are required — the import runs as the owner, not as an API key. " +
          "Run create_admin first.",
      });
    }
    const site = await resolveSite(ssh, cfg.site.domain);

    let imported: Awaited<ReturnType<typeof importContent>> | undefined;
    if (src) {
      // Ghost's importer APPENDS. Running this twice gives you two of every
      // post, with no warning and no way to tell the copies apart afterwards.
      if (!force) {
        const existing = await contentCount(ssh, site.port, cfg.site.domain, cfg.admin);
        if (existing.posts > 0 || existing.pages > 0) {
          return json({
            ok: false,
            error: "site already has content",
            counts: existing,
            explanation:
              "Ghost's importer appends rather than replaces, so importing again would duplicate every " +
              "post and page. Pass force: true if that is genuinely what you want, or delete the existing " +
              "content first.",
          });
        }
      }
      imported = await importContent(ssh, site.port, cfg.site.domain, cfg.admin, src);
    }

    // routes.yaml ships beside a theme zip rather than inside it, so
    // install_theme never sees it and the theme's custom collections 404.
    let routesResult: string | undefined;
    if (routesSrc) {
      try {
        await uploadRoutesAsOwner(ssh, site.port, cfg.site.domain, cfg.admin, routesSrc);
        routesResult = "uploaded";
      } catch (e) {
        // Say what Ghost actually objected to; "rejected" on its own sends you
        // looking at the YAML when the problem was the credential.
        routesResult = `failed: ${(e as Error).message}`;
      }
    }

    return json({
      ok: true,
      imported: imported
        ? {
            counts: imported.counts,
            problems: imported.problems.length ? imported.problems : undefined,
            note: imported.problems.length
              ? "Ghost reported problems; the import still applied what it could."
              : undefined,
          }
        : undefined,
      routes_yaml: routesResult,
      staff_note:
        "Ghost never imports passwords. Any staff user that came in with this export must reset theirs " +
        "before they can sign in.",
      next: routesResult === "uploaded" ? "Ghost restarts after a routes change — give it ~15s." : undefined,
    });
  },
);

server.registerTool(
  "apply_branding",
  {
    title: "Generate and apply icon, logo, accent colour and navigation",
    description:
      "Generate a favicon and wordmark from the site title and accent colour, upload them, and set title, " +
      "description, accent colour and navigation. Assets are rasterised on the host using the sharp that Ghost " +
      "already bundles, so ghostkit carries no image dependencies. A theme with no navigation renders an empty " +
      "header, which reads as a broken install — this is what stops that.",
    inputSchema: {
      dir: z.string().optional(),
      title: z.string().optional().describe("Overrides site.title."),
      description: z.string().optional(),
      accent_color: z.string().optional().describe('Hex, e.g. "#2F6FED". Blank derives one from the title.'),
      generate_assets: z.boolean().optional(),
    },
  },
  async ({ dir, title, description, accent_color, generate_assets }) => {
    const { cfg, ssh } = sshFor(dir);
    if (!cfg.admin.api_key) {
      return json({ ok: false, error: "admin.api_key is empty — run create_admin_key first." });
    }
    const site = await resolveSite(ssh, cfg.site.domain);
    const r = await applyBranding(ssh, site, cfg.admin.api_key, {
      title: title || cfg.site.title || cfg.site.domain,
      description: description || cfg.branding.description,
      accentColor: accent_color || cfg.branding.accent_color,
      navigation: cfg.branding.navigation,
      generateAssets: generate_assets ?? cfg.branding.generate_assets,
    });
    return json({ ok: true, ...r });
  },
);

server.registerTool(
  "detect_editors",
  {
    title: "Which editors are installed, and is ghostkit registered in them",
    description:
      "Look for Claude Code, Codex, Cursor, Windsurf, Gemini CLI, Antigravity, Zed and VS Code, and report for " +
      "each whether it is present, whether ghostkit is already registered, and what it currently launches. " +
      "Read-only. Use this to ask the user which editors to register, then call register_editors.",
    inputSchema: {},
  },
  async () => {
    const all = await detectAll();
    return json({
      editors: all,
      launch_command: launchCommand(),
      note: "Registration uses npx with @latest, so every editor launch picks up the newest published version.",
    });
  },
);

server.registerTool(
  "register_editors",
  {
    title: "Register ghostkit as an MCP server in the chosen editors",
    description:
      "Write the ghostkit MCP entry into each named editor's config, pinned to @latest so it self-updates on " +
      "every launch. Each file is backed up first, because rewriting JSON drops any comments the user had. " +
      "Antigravity is handled through its own `agy mcp add` CLI rather than by editing its file. Ask the user " +
      "which editors they want before calling this.",
    inputSchema: {
      editors: z
        .array(z.string())
        .optional()
        .describe('Editor ids from detect_editors, e.g. ["claude","cursor"]. Omit for every detected editor.'),
      force: z.boolean().optional().describe("Rewrite even when already pointing at @latest."),
    },
  },
  async ({ editors, force }) => {
    const detected = await detectAll();
    const wanted = editors?.length
      ? EDITORS.filter((e) => editors.includes(e.id))
      : EDITORS.filter((e) => detected.find((d) => d.id === e.id)?.detected);

    if (!wanted.length) {
      return json({ ok: false, error: "No matching editors.", available: detected.map((d) => d.id) });
    }
    const results = [];
    for (const def of wanted) results.push(await registerEditor(def, { force }));
    return json({
      ok: results.every((r) => r.ok),
      results,
      restart_required: "Each editor loads MCP servers at startup — restart the ones you just changed.",
    });
  },
);

server.registerTool(
  "version",
  {
    title: "Which ghostkit is running, and is there a newer one",
    description:
      "Report the running version and the newest published version, and how to update. When registered with " +
      "npx and @latest, editors pick up new releases on their next launch, so 'update' usually just means " +
      "restarting the editor.",
    inputSchema: {},
  },
  async () => {
    const latest = await latestVersion();
    return json({
      running: VERSION,
      latest: latest ?? "could not reach the registry",
      up_to_date: latest ? latest === VERSION : undefined,
      how_to_update:
        latest && latest !== VERSION
          ? "Restart your editor: the npx @latest registration fetches it. To force now: npm i -g " +
            `${PACKAGE}@latest, or re-run register_editors with force.`
          : undefined,
      package: PACKAGE,
    });
  },
);

server.registerTool(
  "publish_site",
  {
    title: "Make the site public: write the vhost directives and reload Apache",
    description:
      "Write the Apache directive block into the domain's vhost, verify the config still parses, and reload. " +
      "Takes a backup first and restores it if Apache rejects the result, so a bad write cannot take the host " +
      "down. REFUSES to write when the domain's vhost is bound to a literal IP: Apache matches an IP-bound " +
      "<VirtualHost> before any wildcard one on that address, so such a site answers for EVERY hostname on " +
      "the box — the wrong certificate, then a 403. That is a panel setting (the site's IPv4 Address), not a " +
      "file edit, because ISPConfig regenerates the file. " +
      "Run this LAST — it is the step that exposes the site. Pass dry_run to see the block without writing.",
    inputSchema: {
      dir: z.string().optional(),
      dry_run: z.boolean().optional().describe("Return the directives without touching the server."),
      rebind: z
        .boolean()
        .optional()
        .describe(
          "Stopgap: rewrite an IP-bound <VirtualHost> to a wildcard instead of refusing. ISPConfig regenerates " +
            "the file from the panel's IP setting, so this lasts only until then — fix the site's IPv4 Address.",
        ),
      reload: z
        .boolean()
        .optional()
        .describe("Reload Apache after writing. Default true; false writes and configtests only."),
    },
  },
  async ({ dir, dry_run, reload, rebind }) => {
    const { cfg, ssh } = sshFor(dir);
    const site = await resolveSite(ssh, cfg.site.domain);
    const claimed = await setupStatus(ssh, site.port, cfg.site.domain);
    const directives = apacheDirectives(site.port);

    // Publishing an unclaimed site hands it to whoever opens /ghost/ first.
    if (!claimed) {
      return json({
        ok: false,
        error: "owner not claimed",
        port: site.port,
        apache_directives: directives,
        warning:
          `UNCLAIMED — refusing to publish. Ghost's setup endpoint is unauthenticated and one-shot, so once ` +
          `this is public ANYONE who opens https://${cfg.site.domain}/ghost/ becomes the owner. Run ` +
          `create_admin first; it claims the site over loopback where nobody else can reach it.`,
      });
    }

    if (dry_run) {
      return json({ ok: true, dry_run: true, port: site.port, apache_directives: directives });
    }

    const applied = await applyVhost(ssh, cfg.site.domain, directives, { reload, rebind });
    const strays = await ipBoundVhosts(ssh);

    return json({
      ok: true,
      port: site.port,
      owner_claimed: true,
      vhost_files: applied.files,
      backups: applied.backups,
      reloaded: applied.reloaded,
      rebound_to_wildcard: applied.rebound || undefined,
      rebound_note: applied.rebound
        ? "STOPGAP ONLY — this vhost was bound to a literal IP and has been rewritten to <VirtualHost *:…>. " +
          "ISPConfig regenerates this file from the site's IPv4 Address in the panel, so set that to '*' now; " +
          "otherwise the binding comes back and this site answers for every hostname on the box."
        : undefined,
      other_ip_bound_vhosts: strays.length ? strays : undefined,
      other_ip_bound_note: strays.length
        ? "These vhosts still bind a literal IP, so each one captures name-based matching for every other " +
          "domain on that address — wrong certificate, then 403. Set their IPv4 Address to '*' in ISPConfig."
        : undefined,
      url: `https://${cfg.site.domain}/`,
      verify: `curl -s -o /dev/null -w '%{http_code}' https://${cfg.site.domain}/   # expect 200, not 301`,
      note:
        "ISPConfig owns this file and may regenerate it. The block is fenced in ghostkit markers, so " +
        "re-running this tool replaces it rather than appending a second copy. Do not apply these " +
        "directives through sshmanager_update_domain — it returns success and renders them in its UI " +
        "without them ever reaching ISPConfig or the disk.",
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
