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
 * Ghost's loopback ports live in 51000–51999, and nowhere else.
 *
 * ISPConfig hands out PHP-FPM pool ports from 9000–9099, one per new PHP site,
 * and it does not know Ghost exists. Put a Ghost site in that range and the next
 * PHP site created on the box is given the same port: php-fpm then cannot bind
 * its pool, systemd fails the WHOLE php-fpm service, and every PHP site on the
 * host goes down with it. This happened on server4 — a Ghost site held 9047,
 * which ISPConfig later assigned to another site's pool.
 */
export const GHOST_PORT_MIN = 51000;
export const GHOST_PORT_MAX = 51999;
export const FPM_PORT_MIN = 9000;
export const FPM_PORT_MAX = 9099;

export interface PortVerdict {
  port: number;
  ok: boolean;
  problems: string[];
  listening: boolean;
}

/** Is this port safe to hand Ghost on this host? Range, FPM range, and in-use. */
export async function checkGhostPort(ssh: Ssh, port: number): Promise<PortVerdict> {
  const problems: string[] = [];
  if (!Number.isInteger(port) || port <= 0) {
    problems.push(`'${port}' is not a port number.`);
  }
  if (port >= FPM_PORT_MIN && port <= FPM_PORT_MAX) {
    problems.push(
      `${port} is inside ISPConfig's PHP-FPM pool range ${FPM_PORT_MIN}–${FPM_PORT_MAX}. The next PHP site ` +
        `created here will be given this port, php-fpm will fail to bind it, and systemd will take the whole ` +
        `php-fpm service — every PHP site on the host — down with it.`,
    );
  }
  if (port < GHOST_PORT_MIN || port > GHOST_PORT_MAX) {
    problems.push(`${port} is outside the Ghost range ${GHOST_PORT_MIN}–${GHOST_PORT_MAX}.`);
  }
  const r = await ssh.exec(`ss -tln 2>/dev/null | grep -c ":${port} " || true`);
  const listening = Number(r.stdout.trim()) > 0;
  if (listening) problems.push(`Something is already listening on ${port}.`);
  return { port, ok: problems.length === 0, problems, listening };
}

/**
 * The next free Ghost port: one above the highest already in the range, taken
 * from the site registry and from what is actually listening.
 */
export async function suggestGhostPort(ssh: Ssh): Promise<number> {
  const r = await ssh.exec(
    `{ awk -F'\\t' 'NR>1{print $1}' /etc/ghost/sites.tsv 2>/dev/null; ` +
      `ss -tln 2>/dev/null | grep -oE '127\\.0\\.0\\.1:[0-9]+' | cut -d: -f2; } | ` +
      `awk -v lo=${GHOST_PORT_MIN} -v hi=${GHOST_PORT_MAX} '$1>=lo && $1<=hi' | sort -n | tail -1`,
  );
  const highest = Number(r.stdout.trim());
  if (!Number.isFinite(highest) || highest < GHOST_PORT_MIN) return GHOST_PORT_MIN;
  return highest + 1;
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

export interface VhostResult {
  /** Files that were edited. */
  files: string[];
  /** Backups taken, same order. */
  backups: string[];
  /** The directives were already in place; nothing was written. */
  alreadyPresent: boolean;
  /** Apache was asked to reload. */
  reloaded: boolean;
  /**
   * The vhost was bound to a literal IP and has been rewritten to a wildcard.
   * An IP-bound vhost outranks every wildcard one on the same address, so the
   * site silently becomes the default for EVERY hostname on that IP.
   */
  rebound: boolean;
}

/**
 * Write the directives into the domain's Apache vhost, verify the config still
 * parses, and reload.
 *
 * ISPConfig owns this file, so ideally the panel would write it. It cannot be
 * relied on: a change pushed through SSH Manager returns success and renders in
 * its UI while never reaching ISPConfig or the disk, and saving the same edit
 * by hand in the panel fails the same silent way. Writing the file ourselves is
 * the only path that can be verified, so we take a backup and configtest before
 * reloading rather than trusting the write.
 */
export async function applyVhost(
  ssh: Ssh,
  domain: string,
  directives: string,
  opts: { reload?: boolean; rebind?: boolean } = {},
): Promise<VhostResult> {
  const q = shellQuote(domain);
  const found = await ssh.exec(
    `ls /etc/apache2/sites-available/${q}.vhost /etc/apache2/sites-available/*${q}*.vhost 2>/dev/null | sort -u`,
  );
  const files = found.stdout.trim().split("\n").filter(Boolean);
  if (files.length === 0) {
    throw new Error(
      `No Apache vhost found for '${domain}'. Create the website in ISPConfig first, then run this again.`,
    );
  }

  // An IP-literal <VirtualHost> forms its own matching set for that address, and
  // every request arriving on the IP matches that set first — so one IP-bound
  // vhost answers for every other site on the box, serving its own certificate
  // and then a 403 because the Host header does not match. On server4 this took
  // all 36 Ghost sites down at once. ISPConfig regenerates these files from the
  // site's IP setting in the panel, so editing the file here only hides it until
  // the next regeneration: refuse, and say where the real setting lives.
  const ipBound: string[] = [];
  for (const file of files) {
    const bound = await ssh.exec(
      `grep -hoE '<VirtualHost[[:space:]]+[0-9][0-9.]*:[0-9]+' ${shellQuote(file)} | sort -u || true`,
    );
    if (bound.stdout.trim()) ipBound.push(`${file}: ${bound.stdout.trim().split("\n").join(", ")}`);
  }
  if (ipBound.length > 0 && !opts.rebind) {
    throw new Error(
      `This domain's vhost is bound to a literal IP, so nothing was written:\n  ${ipBound.join("\n  ")}\n\n` +
        `Apache matches an IP-bound <VirtualHost> before any wildcard one on that address, which makes this ` +
        `site the default for EVERY hostname on the box — other sites get this certificate and a 403.\n\n` +
        `Fix it in ISPConfig: set the site's IP to "*" (Sites > the domain > IPv4 Address), which regenerates ` +
        `the vhost as <VirtualHost *:80> / <VirtualHost *:443>. Editing the file is not a fix — ISPConfig ` +
        `rewrites it. Pass rebind:true only as a stopgap until the panel setting is corrected.`,
    );
  }

  const marker = "# >>> ghostkit managed >>>";
  const endMarker = "# <<< ghostkit managed <<<";
  const block = `${marker}\n${directives}\n${endMarker}`;
  const b64 = Buffer.from(block).toString("base64");

  const backups: string[] = [];
  let wrote = false;
  let rebound = false;

  for (const file of files) {
    const f = shellQuote(file);
    const stamp = `${file}.ghostkit.${Date.now()}`;
    await ssh.must(`cp -a ${f} ${shellQuote(stamp)}`);
    backups.push(stamp);

    // Only reached with rebind:true — a stopgap that lasts until ISPConfig
    // regenerates the file from the site's IP setting in the panel.
    const bound = await ssh.exec(`grep -cE '^[[:space:]]*<VirtualHost[[:space:]]+[0-9]' ${f} || true`);
    if (Number(bound.stdout.trim()) > 0) {
      await ssh.must(
        `sed -i -E 's|^([[:space:]]*)<VirtualHost[[:space:]]+[0-9][0-9.]*:|\\1<VirtualHost *:|' ${f}`,
      );
      rebound = true;
    }

    const already = await ssh.exec(`grep -qF ${shellQuote(marker)} ${f} && echo yes || echo no`);
    if (already.stdout.trim() === "yes") {
      // Replace the previous block rather than appending a second one.
      await ssh.must(
        `perl -0pi -e 's/\\Q${marker}\\E.*?\\Q${endMarker}\\E\\n?//gs' ${f}`,
      );
    }

    // Inside every <VirtualHost> block, immediately before its close.
    await ssh.must(
      `echo ${shellQuote(b64)} | base64 -d > /tmp/ghostkit-vhost.$$ && ` +
        `awk -v blockfile=/tmp/ghostkit-vhost.$$ '` +
        `/^[[:space:]]*<\\/VirtualHost>/ { while ((getline line < blockfile) > 0) print line; close(blockfile) } ` +
        `{ print }' ${f} > ${f}.ghostkit.new && mv ${f}.ghostkit.new ${f} && rm -f /tmp/ghostkit-vhost.$$`,
    );
    wrote = true;
  }

  const test = await ssh.exec("apache2ctl configtest 2>&1 || httpd -t 2>&1");
  if (!/Syntax OK/.test(test.stdout)) {
    // Put every file back exactly as it was before claiming anything broke.
    for (let i = 0; i < files.length; i++) {
      await ssh.exec(`cp -a ${shellQuote(backups[i])} ${shellQuote(files[i])}`);
    }
    throw new Error(
      `Apache rejected the config, so nothing was changed — the vhost files were restored from backup.\n${test.stdout.slice(0, 600)}`,
    );
  }

  let reloaded = false;
  if (opts.reload !== false) {
    // reload, never restart: other sites on this host keep serving.
    await ssh.must("systemctl reload apache2 2>/dev/null || systemctl reload httpd");
    reloaded = true;
  }

  return { files, backups, alreadyPresent: !wrote, reloaded, rebound };
}

/**
 * Does any vhost on this host bind a literal IP? Such a vhost outranks every
 * wildcard one on the same address and silently becomes the default for every
 * hostname on it — the failure looks like "my other sites are serving the wrong
 * content", which is nothing like the change that caused it.
 */
export async function ipBoundVhosts(ssh: Ssh): Promise<string[]> {
  const r = await ssh.exec(
    `apache2ctl -S 2>/dev/null | awk '/^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+:[0-9]+/ {print $NF}' | sort -u || true`,
  );
  return r.stdout.trim().split("\n").filter(Boolean);
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
