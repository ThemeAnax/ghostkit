import { Ssh, shellQuote } from "./ssh.js";

export interface SiteLayout {
  domain: string;
  port: number;
  /** Where Ghost lives — the domain's own web folder. */
  ghostDir: string;
  docroot: string;
  sysUser: string;
  sysGroup: string;
  shellUser: string;
  unitPath: string;
}

/**
 * Resolve where a site lives: the port registry written by ghost-site-enable,
 * and ISPConfig for the rest.
 */
export async function resolveSite(ssh: Ssh, domain: string): Promise<SiteLayout> {
  const q = shellQuote(domain);

  const reg = await ssh.exec(`awk -F'\\t' -v d=${q} '$3==d{print $1"\\t"$4}' /etc/ghost/sites.tsv 2>/dev/null`);
  const [portStr, dirFromReg] = reg.stdout.trim().split("\t");

  const isp = await ssh.exec(
    `mysql -N -B -e "SELECT document_root,system_user,system_group FROM dbispconfig.web_domain WHERE domain=${q} LIMIT 1;" 2>/dev/null`,
  );
  const [docroot, sysUser, sysGroup] = isp.stdout.trim().split("\t");
  if (!docroot) {
    throw new Error(
      `Could not resolve '${domain}' on this host. Create the website in ISPConfig first ` +
        `(or with sshmanager_provision_domain).`,
    );
  }

  const shell = await ssh.exec(
    `mysql -N -B -e "SELECT su.username FROM dbispconfig.shell_user su JOIN dbispconfig.web_domain wd ON wd.domain_id=su.parent_domain_id WHERE wd.domain=${q} AND su.active='y' LIMIT 1;" 2>/dev/null`,
  );
  const shellUser = shell.stdout.trim();
  if (!shellUser) {
    throw new Error(`No active shell user for '${domain}'. Create one in ISPConfig with Chroot = None.`);
  }

  return {
    domain,
    port: Number(portStr) || 0,
    ghostDir: dirFromReg || `${docroot}/web`,
    docroot,
    sysUser,
    sysGroup,
    shellUser,
    unitPath: `${docroot}/.config/systemd/user/ghost.service`,
  };
}

/**
 * The vhost block. Every line here is load-bearing — see the comments; each
 * one corresponds to a way the site breaks without it.
 */
export function apacheDirectives(port: number): string {
  return [
    "ProxyRequests Off",
    "ProxyPreserveHost On",
    "",
    "# Let's Encrypt ACME must never be proxied, or renewal fails silently ~60 days later",
    "ProxyPass /.well-known/ !",
    "",
    `ProxyPass        / http://127.0.0.1:${port}/ retry=0 timeout=120`,
    `ProxyPassReverse / http://127.0.0.1:${port}/`,
    "",
    "# Ghost only issues its Secure admin session cookie when it believes the request",
    "# arrived over https, and mod_proxy does not set this header itself. Without it",
    "# POST /ghost/api/admin/session/ returns 201 with no Set-Cookie and nobody can sign in.",
    'RequestHeader set X-Forwarded-Proto "https"',
    "",
    "RewriteEngine On",
    "RewriteCond %{HTTP:Upgrade} websocket [NC]",
    "RewriteCond %{HTTP:Connection} upgrade [NC]",
    `RewriteRule ^/?(.*) ws://127.0.0.1:${port}/$1 [P,L]`,
    "",
    '<FilesMatch "^config\\.(production|development)\\.json$">',
    "    Require all denied",
    "</FilesMatch>",
  ].join("\n");
}

/** Restart Ghost through the tenant's own systemd user manager — never root. */
export async function restartGhost(ssh: Ssh, site: SiteLayout): Promise<string> {
  const uid = (await ssh.exec(`id -u ${shellQuote(site.sysUser)}`)).stdout.trim();
  const env = `export XDG_RUNTIME_DIR=/run/user/${uid}; export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus;`;
  await ssh.must(`su - ${shellQuote(site.shellUser)} -c ${shellQuote(`${env} systemctl --user daemon-reload && systemctl --user restart ghost`)}`);
  const r = await ssh.exec(
    `su - ${shellQuote(site.shellUser)} -c ${shellQuote(`${env} systemctl --user is-active ghost`)}`,
  );
  return r.stdout.trim();
}

/** Is the unit up? */
export async function serviceState(ssh: Ssh, site: SiteLayout): Promise<string> {
  const uid = (await ssh.exec(`id -u ${shellQuote(site.sysUser)}`)).stdout.trim();
  const r = await ssh.exec(
    `su - ${shellQuote(site.shellUser)} -c ${shellQuote(`export XDG_RUNTIME_DIR=/run/user/${uid}; systemctl --user is-active ghost`)}`,
  );
  return r.stdout.trim() || "unknown";
}
