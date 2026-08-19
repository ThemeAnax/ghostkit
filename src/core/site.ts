import { Ssh, shellQuote } from "./ssh.js";

export interface SiteLayout {
  domain: string;
  port: number;
  ghostDir: string;
  docroot: string;
  sysUser: string;
  sysGroup: string;
  shellUser: string;
  unitPath: string;
}

/**
 * Resolve where a site lives. Reads the port registry written by
 * ghost-site-enable, and ISPConfig for the rest. Kept separate from the Ghost
 * API layer so a non-ISPConfig host can grow its own resolver later.
 */
export async function resolveSite(ssh: Ssh, domain: string): Promise<SiteLayout> {
  const q = shellQuote(domain);

  const reg = await ssh.exec(`awk -F'\\t' -v d=${q} '$3==d{print $1"\\t"$4}' /etc/ghost/sites.tsv 2>/dev/null`);
  const [portStr, ghostDirFromReg] = reg.stdout.trim().split("\t");

  const isp = await ssh.exec(
    `mysql -N -B -e "SELECT document_root,system_user,system_group FROM dbispconfig.web_domain WHERE domain=${q} LIMIT 1;" 2>/dev/null`,
  );
  const [docroot, sysUser, sysGroup] = isp.stdout.trim().split("\t");
  if (!docroot) {
    throw new Error(
      `Could not resolve '${domain}' on this host. ` +
        `Provision it first (sshmanager_provision_domain, or create it in ISPConfig).`,
    );
  }

  const shell = await ssh.exec(
    `mysql -N -B -e "SELECT su.username FROM dbispconfig.shell_user su JOIN dbispconfig.web_domain wd ON wd.domain_id=su.parent_domain_id WHERE wd.domain=${q} AND su.active='y' LIMIT 1;" 2>/dev/null`,
  );
  const shellUser = shell.stdout.trim();
  if (!shellUser) {
    throw new Error(`No active shell user for '${domain}'. Create one in ISPConfig with Chroot = None.`);
  }

  const ghostDir = ghostDirFromReg || `${docroot}/web/ghost`;
  return {
    domain,
    port: Number(portStr) || 0,
    ghostDir,
    docroot,
    sysUser,
    sysGroup,
    shellUser,
    unitPath: `${docroot}/.config/systemd/user/ghost.service`,
  };
}

/** The proxy block for the vhost. sshmanager re-injects ACME on its own. */
export function apacheDirectives(port: number): string {
  return [
    "# Let's Encrypt ACME must not be proxied, or renewals break",
    "ProxyPass /.well-known/ !",
    "",
    "ProxyRequests Off",
    "ProxyPreserveHost On",
    `ProxyPass        / http://127.0.0.1:${port}/ retry=0 timeout=120`,
    `ProxyPassReverse / http://127.0.0.1:${port}/`,
    'RequestHeader set X-Forwarded-Proto "https"',
    "",
    '<FilesMatch "^config\\.(production|development)\\.json$">',
    "    Require all denied",
    "</FilesMatch>",
  ].join("\n");
}

/** Restart Ghost through the tenant's own systemd user manager — never root. */
export async function restartGhost(ssh: Ssh, site: SiteLayout): Promise<string> {
  await ssh.must(
    `su - ${shellQuote(site.shellUser)} -c 'systemctl --user daemon-reload && systemctl --user restart ghost'`,
  );
  const r = await ssh.exec(`su - ${shellQuote(site.shellUser)} -c 'systemctl --user is-active ghost'`);
  return r.stdout.trim();
}
