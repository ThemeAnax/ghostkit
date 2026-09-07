import { Ssh, shellQuote } from "./ssh.js";
import type { SiteLayout } from "./site.js";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Command that fixes it, when a fix exists. */
  fix?: string;
  /** A blocker stops the pipeline; a warning does not. */
  blocking: boolean;
}

export interface DbInfo {
  engine: "mysql" | "mariadb" | "unknown";
  version: string;
}

export async function detectDatabase(ssh: Ssh): Promise<DbInfo> {
  const out = (await ssh.exec("mysql --version 2>/dev/null || true")).stdout.trim();
  if (/mariadb/i.test(out)) {
    return { engine: "mariadb", version: out.match(/Distrib\s+([0-9.]+)/i)?.[1] ?? "unknown" };
  }
  if (/mysql/i.test(out)) {
    return { engine: "mysql", version: out.match(/Ver\s+([0-9.]+)/i)?.[1] ?? "unknown" };
  }
  return { engine: "unknown", version: "unknown" };
}

/**
 * Every host check in one pass, so the host gets fixed once rather than one
 * error at a time. Node and ghost-cli are checked as the TENANT: they are used
 * by the shell user, and root's PATH proves nothing about theirs.
 */
export async function preflight(
  ssh: Ssh,
  opts: { domain: string },
): Promise<{ checks: PreflightCheck[]; db: DbInfo; shellUser: string; blocked: boolean }> {
  const checks: PreflightCheck[] = [];
  const db = await detectDatabase(ssh);
  const q = shellQuote(opts.domain);

  const shellUser = (
    await ssh.exec(
      `mysql -N -B -e "SELECT su.username FROM dbispconfig.shell_user su ` +
        `JOIN dbispconfig.web_domain wd ON wd.domain_id=su.parent_domain_id ` +
        `WHERE wd.domain=${q} AND su.active='y' LIMIT 1;" 2>/dev/null || true`,
    )
  ).stdout.trim();

  checks.push({
    name: "domain + shell user",
    ok: Boolean(shellUser),
    detail: shellUser || `no active shell user for ${opts.domain}`,
    fix: shellUser ? undefined : "Create the website and a shell user in ISPConfig, with Chroot = None",
    blocking: true,
  });

  const asTenant = async (cmd: string) =>
    shellUser ? (await ssh.exec(`su - ${shellQuote(shellUser)} -c ${shellQuote(cmd)} 2>/dev/null`)).stdout.trim() : "";

  const node = await asTenant("node -v");
  // Ghost 6 declares node ^22.23.1.
  const [maj, min, pat] = (node.replace(/^v/, "").split(".").map(Number) ?? []) as number[];
  const nodeOk = maj === 22 && (min > 23 || (min === 23 && pat >= 1));
  checks.push({
    name: "node (as tenant)",
    ok: nodeOk,
    detail: node || "not on the tenant's PATH",
    fix: nodeOk ? undefined : "Ghost 6 needs Node ^22.23.1 — install it so the shell user can see it",
    blocking: true,
  });

  const cli = await asTenant("command -v ghost");
  checks.push({
    name: "ghost-cli (as tenant)",
    ok: Boolean(cli),
    detail: cli || "not on the tenant's PATH",
    fix: cli ? undefined : "npm install -g ghost-cli@latest",
    blocking: true,
  });

  checks.push({
    name: "database",
    ok: db.engine !== "unknown",
    detail: `${db.engine} ${db.version}`,
    blocking: db.engine === "unknown",
  });

  const systemd = (await ssh.exec("command -v loginctl 2>/dev/null || true")).stdout.trim();
  checks.push({
    name: "systemd (for --user units)",
    ok: Boolean(systemd),
    detail: systemd || "loginctl not found",
    blocking: true,
  });

  // A jailkit chroot has no XDG_RUNTIME_DIR, so `systemctl --user` can never
  // work inside one and the owner could not restart their own site.
  const chroot = (
    await ssh.exec(
      `mysql -N -B -e "SELECT su.chroot FROM dbispconfig.shell_user su ` +
        `JOIN dbispconfig.web_domain wd ON wd.domain_id=su.parent_domain_id ` +
        `WHERE wd.domain=${q} LIMIT 1;" 2>/dev/null || true`,
    )
  ).stdout.trim();
  checks.push({
    name: "shell user not jailed",
    ok: chroot !== "jailkit",
    detail: chroot ? `chroot=${chroot}` : "unknown",
    fix: chroot === "jailkit" ? "Set Chroot = None on this shell user in ISPConfig" : undefined,
    blocking: chroot === "jailkit",
  });

  return { checks, db, shellUser, blocked: checks.some((c) => !c.ok && c.blocking) };
}

/**
 * Has anyone claimed the site yet? Ghost's setup endpoint is unauthenticated
 * and one-shot, so this is the difference between "waiting for you" and
 * "somebody else owns your blog".
 */
export async function setupStatus(ssh: Ssh, port: number, domain: string): Promise<boolean> {
  const r = await ssh.curlLoopback(port, domain, "/ghost/api/admin/authentication/setup/");
  try {
    return JSON.parse(r.body).setup?.[0]?.status === true;
  } catch {
    return false;
  }
}

/**
 * Ghost emails a verification code on every staff sign-in
 * (security:staffDeviceVerification, default true). With no mail configured
 * that makes sign-in fail outright and locks the owner out of their own site.
 */
export async function setStaffDeviceVerification(
  ssh: Ssh,
  site: SiteLayout,
  enabled: boolean,
): Promise<void> {
  const cfgPath = `${site.ghostDir}/config.production.json`;
  const py =
    `import json,io;p=${JSON.stringify(cfgPath)};` +
    `d=json.load(io.open(p));` +
    `d.setdefault('security',{})['staffDeviceVerification']=${enabled ? "True" : "False"};` +
    `io.open(p,'w').write(json.dumps(d,indent=2))`;
  await ssh.must(`python3 -c ${shellQuote(py)}`);
  // 600, not 640: ISPConfig puts the web server user in the client group.
  await ssh.must(
    `chown ${shellQuote(`${site.sysUser}:${site.sysGroup}`)} ${shellQuote(cfgPath)} && chmod 600 ${shellQuote(cfgPath)}`,
  );
}

/** Poll the loopback port until Ghost answers. */
export async function waitForGhost(
  ssh: Ssh,
  port: number,
  domain: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await ssh.curlLoopback(port, domain, "/ghost/api/admin/site/");
    if (r.status > 0 && r.status < 500) return true;
    await new Promise((done) => setTimeout(done, 3000));
  }
  return false;
}

/** The Ghost version actually installed, read from the live symlink. */
export async function installedVersion(ssh: Ssh, site: SiteLayout): Promise<string> {
  const r = await ssh.exec(
    `readlink -f ${shellQuote(`${site.ghostDir}/current`)} 2>/dev/null | xargs -r basename`,
  );
  return r.stdout.trim() || "unknown";
}
