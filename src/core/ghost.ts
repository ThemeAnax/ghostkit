import { createHmac } from "node:crypto";
import { Ssh, shellQuote } from "./ssh.js";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Command the user can run to fix it, when a fix exists. */
  fix?: string;
  /** A blocker stops the pipeline; a warning does not. */
  blocking: boolean;
}

export interface DbInfo {
  engine: "mysql" | "mariadb" | "unknown";
  version: string;
  /** Ghost major version this engine can safely run. */
  ghostVersion: "5" | "6";
}

/**
 * Ghost officially supports MySQL 8 only. MariaDB works for Ghost 5 (it emits a
 * notice) but Ghost 6 must never be installed onto it silently.
 */
export async function detectDatabase(ssh: Ssh): Promise<DbInfo> {
  const r = await ssh.exec("mysql --version 2>/dev/null || true");
  const out = r.stdout.trim();
  if (/mariadb/i.test(out)) {
    const version = out.match(/Distrib\s+([0-9.]+)/i)?.[1] ?? "unknown";
    return { engine: "mariadb", version, ghostVersion: "5" };
  }
  if (/mysql/i.test(out)) {
    const version = out.match(/Ver\s+([0-9.]+)/i)?.[1] ?? "unknown";
    return { engine: "mysql", version, ghostVersion: version.startsWith("8") ? "6" : "5" };
  }
  return { engine: "unknown", version: "unknown", ghostVersion: "5" };
}

/** Every check in one pass, so the user fixes the host once. */
export async function preflight(ssh: Ssh, opts: { domain: string }): Promise<{
  checks: PreflightCheck[];
  db: DbInfo;
  blocked: boolean;
}> {
  const checks: PreflightCheck[] = [];
  const db = await detectDatabase(ssh);

  const node = (await ssh.exec("node -v 2>/dev/null || true")).stdout.trim();
  const nodeMajor = Number(node.match(/^v(\d+)/)?.[1] ?? 0);
  const nodeOk = db.ghostVersion === "6" ? nodeMajor === 22 : nodeMajor >= 18;
  checks.push({
    name: "node",
    ok: nodeOk,
    detail: node || "not installed",
    fix: nodeOk ? undefined : "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
    blocking: true,
  });

  const cli = (await ssh.exec("command -v ghost 2>/dev/null || true")).stdout.trim();
  checks.push({
    name: "ghost-cli",
    ok: Boolean(cli),
    detail: cli || "not installed",
    fix: cli ? undefined : "npm install -g ghost-cli@latest",
    blocking: true,
  });

  checks.push({
    name: "database",
    ok: db.engine !== "unknown",
    detail: `${db.engine} ${db.version} -> Ghost ${db.ghostVersion}`,
    blocking: db.engine === "unknown",
  });

  const systemd = (await ssh.exec("command -v loginctl 2>/dev/null || true")).stdout.trim();
  checks.push({
    name: "systemd (for --user units)",
    ok: Boolean(systemd),
    detail: systemd || "loginctl not found",
    blocking: true,
  });

  // Jailkit and systemd --user are mutually exclusive: a chroot has no
  // XDG_RUNTIME_DIR, so the tenant could never control their own service.
  const jailed = await ssh.exec(
    `mysql -N -B -e "SELECT chroot FROM dbispconfig.shell_user su JOIN dbispconfig.web_domain wd ON wd.domain_id=su.parent_domain_id WHERE wd.domain=${shellQuote(opts.domain)} LIMIT 1;" 2>/dev/null || true`,
  );
  const chroot = jailed.stdout.trim();
  checks.push({
    name: "shell user not jailed",
    ok: chroot !== "jailkit",
    detail: chroot ? `chroot=${chroot}` : "not an ISPConfig host, or no shell user yet",
    fix: chroot === "jailkit" ? "Set Chroot = None on this shell user in ISPConfig" : undefined,
    blocking: chroot === "jailkit",
  });

  const smtp = await ssh.exec(
    `timeout 8 bash -c 'cat < /dev/null > /dev/tcp/smtp.sendgrid.net/587' 2>/dev/null && echo open || echo blocked`,
  );
  checks.push({
    name: "outbound SMTP 587",
    ok: smtp.stdout.includes("open"),
    detail: smtp.stdout.trim(),
    blocking: false,
  });

  return { checks, db, blocked: checks.some((c) => !c.ok && c.blocking) };
}

/** Ghost Admin API auth: HS256 JWT, kid = key id, secret is hex. */
export function adminJwt(adminApiKey: string): string {
  const [id, secret] = adminApiKey.split(":");
  if (!id || !secret) throw new Error("admin API key must be in the form {id}:{secret}");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT", kid: id });
  const body = b64({ iat: now, exp: now + 300, aud: "/admin/" });
  const sig = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${sig}`;
}

export async function setupStatus(ssh: Ssh, port: number, domain: string): Promise<boolean> {
  const r = await ssh.curlLoopback(port, domain, "/ghost/api/admin/authentication/setup/");
  try {
    return Boolean(JSON.parse(r.body)?.setup?.[0]?.status);
  } catch {
    return false;
  }
}

/**
 * Claim ownership. Ghost ships a fixture Owner row that this UPDATEs — never
 * insert a user directly or you end up with two owners.
 *
 * Runs over loopback so it happens before the site is publicly reachable.
 */
export async function setupOwner(
  ssh: Ssh,
  port: number,
  domain: string,
  owner: { name: string; email: string; password: string; blogTitle: string },
): Promise<{ alreadySetUp: boolean; email: string }> {
  if (await setupStatus(ssh, port, domain)) {
    return { alreadySetUp: true, email: owner.email };
  }
  const r = await ssh.curlLoopback(port, domain, "/ghost/api/admin/authentication/setup/", {
    method: "POST",
    json: {
      setup: [
        {
          name: owner.name,
          email: owner.email,
          password: owner.password,
          blogTitle: owner.blogTitle || domain,
        },
      ],
    },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`setup failed (${r.status}): ${r.body}`);
  }
  return { alreadySetUp: false, email: owner.email };
}

/**
 * Session login, then create a custom integration. Uses the public Admin API
 * rather than inserting rows, so it survives Ghost schema changes.
 */
export async function createAdminKey(
  ssh: Ssh,
  port: number,
  domain: string,
  owner: { email: string; password: string },
  integrationName = "ghostkit",
): Promise<string> {
  const jar = "/tmp/ghostkit-session.txt";
  const loginBody = JSON.stringify({ username: owner.email, password: owner.password });
  const login = await ssh.exec(
    `curl -sS -c ${jar} -X POST ` +
      `-H ${shellQuote("Content-Type: application/json")} ` +
      `-H ${shellQuote(`Host: ${domain}`)} ` +
      `-H ${shellQuote("Origin: https://" + domain)} ` +
      `--data ${shellQuote(loginBody)} ` +
      `-w '\\n%{http_code}' ${shellQuote(`http://127.0.0.1:${port}/ghost/api/admin/session/`)}`,
  );
  const loginCode = login.stdout.trim().split("\n").pop();
  if (loginCode !== "201" && loginCode !== "200") {
    throw new Error(`session login failed (${loginCode}): ${login.stdout}`);
  }

  const create = await ssh.exec(
    `curl -sS -b ${jar} -X POST ` +
      `-H ${shellQuote("Content-Type: application/json")} ` +
      `-H ${shellQuote(`Host: ${domain}`)} ` +
      `-H ${shellQuote("Origin: https://" + domain)} ` +
      `--data ${shellQuote(JSON.stringify({ integrations: [{ name: integrationName }] }))} ` +
      `${shellQuote(`http://127.0.0.1:${port}/ghost/api/admin/integrations/`)}`,
  );
  await ssh.exec(`rm -f ${jar}`);

  const parsed = JSON.parse(create.stdout) as {
    integrations?: Array<{ api_keys?: Array<{ id: string; secret: string; type: string }> }>;
  };
  const key = parsed.integrations?.[0]?.api_keys?.find((k) => k.type === "admin");
  if (!key) throw new Error(`could not read admin key from response: ${create.stdout.slice(0, 400)}`);
  return `${key.id}:${key.secret}`;
}

/**
 * Download the zip on the host and upload it through the Admin API, then
 * activate. themeseed reads the ACTIVE theme, so activation must precede seeding.
 */
export async function installTheme(
  ssh: Ssh,
  port: number,
  domain: string,
  adminApiKey: string,
  zipUrl: string,
  activate = true,
): Promise<{ name: string; active: boolean }> {
  const tmp = "/tmp/ghostkit-theme.zip";
  await ssh.must(`curl -fsSL -o ${tmp} ${shellQuote(zipUrl)}`, { timeoutMs: 180_000 });

  const token = adminJwt(adminApiKey);
  const upload = await ssh.exec(
    `curl -sS -X POST ` +
      `-H ${shellQuote(`Authorization: Ghost ${token}`)} ` +
      `-H ${shellQuote(`Host: ${domain}`)} ` +
      `-F ${shellQuote(`file=@${tmp}`)} ` +
      `${shellQuote(`http://127.0.0.1:${port}/ghost/api/admin/themes/upload/`)}`,
    { timeoutMs: 180_000 },
  );
  await ssh.exec(`rm -f ${tmp}`);

  const parsed = JSON.parse(upload.stdout) as { themes?: Array<{ name: string; active: boolean }> };
  const theme = parsed.themes?.[0];
  if (!theme) throw new Error(`theme upload failed: ${upload.stdout.slice(0, 400)}`);
  if (!activate) return { name: theme.name, active: theme.active };

  // A fresh JWT: the upload can outlive the 5 minute token.
  const activateToken = adminJwt(adminApiKey);
  const act = await ssh.curlLoopback(port, domain, `/ghost/api/admin/themes/${theme.name}/activate/`, {
    method: "PUT",
    headers: { Authorization: `Ghost ${activateToken}` },
  });
  if (act.status < 200 || act.status >= 300) {
    throw new Error(`theme activate failed (${act.status}): ${act.body}`);
  }
  return { name: theme.name, active: true };
}
