import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
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
 * A password Ghost will accept and a human can still retype. Excludes the
 * characters that get misread out loud or mangled in a shell — 0/O, 1/l/I,
 * and quotes — and takes randomness from crypto, never Math.random.
 */
export function generatePassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  if (length < 10) throw new Error("Ghost requires a password of at least 10 characters");
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // Reject above the largest whole multiple of the alphabet, so every
    // character stays equally likely rather than slightly favouring the front.
    const max = 256 - (256 % alphabet.length);
    if (bytes[i] < max) out += alphabet[bytes[i] % alphabet.length];
  }
  return out.length === length ? out : out + generatePassword(length - out.length);
}

export interface SetupResult {
  alreadySetUp: boolean;
  name: string;
  email: string;
  blogTitle: string;
}

/**
 * Claim the owner account through Ghost's setup endpoint, over loopback,
 * BEFORE the site is public.
 *
 * That endpoint is unauthenticated and works exactly once: whoever calls it
 * first owns the publication. Doing it here — while Ghost is still bound to
 * 127.0.0.1 — is what makes the site safe to expose afterwards. Idempotent:
 * a site that is already claimed is reported, not overwritten.
 */
export async function setupOwner(
  ssh: Ssh,
  port: number,
  domain: string,
  owner: { name: string; email: string; password: string; blogTitle?: string },
): Promise<SetupResult> {
  const blogTitle = owner.blogTitle?.trim() || domain;

  if (await setupStatus(ssh, port, domain)) {
    return { alreadySetUp: true, name: owner.name, email: owner.email, blogTitle };
  }
  if (owner.password.length < 10) {
    throw new Error("Ghost requires a password of at least 10 characters");
  }

  const r = await ssh.curlLoopback(port, domain, "/ghost/api/admin/authentication/setup/", {
    method: "POST",
    json: {
      setup: [{ name: owner.name, email: owner.email, password: owner.password, blogTitle }],
    },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`owner setup failed (${r.status}): ${r.body.slice(0, 400)}`);
  }
  return { alreadySetUp: false, name: owner.name, email: owner.email, blogTitle };
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

/** Ghost Admin API auth: HS256 JWT, kid = key id, secret is hex. */
export function adminJwt(adminApiKey: string): string {
  const [id, secret] = adminApiKey.split(":");
  if (!id || !secret) throw new Error("admin API key must be in the form {id}:{secret}");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT", kid: id });
  const body = b64({ iat: now, exp: now + 300, aud: "/admin/" });
  const sig = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${sig}`;
}

/**
 * The headers every loopback admin call needs. X-Forwarded-Proto is not
 * optional: Ghost's session cookie is Secure, and express-session refuses to
 * ISSUE a Secure cookie on a connection it believes is plain http — which
 * every loopback call is. In production the vhost sets it; here we must.
 */
function adminHeaders(domain: string): string {
  return (
    `-H ${shellQuote("Content-Type: application/json")} ` +
    `-H ${shellQuote(`Host: ${domain}`)} ` +
    `-H ${shellQuote("Origin: https://" + domain)} ` +
    `-H ${shellQuote("X-Forwarded-Proto: https")} `
  );
}

/** Sign in as the owner and hand back the session cookie, replayed by hand. */
async function ownerCookie(
  ssh: Ssh,
  port: number,
  domain: string,
  owner: { email: string; password: string },
): Promise<string> {
  const hdr = "/tmp/ghostkit-session-headers.txt";
  const body = JSON.stringify({ username: owner.email, password: owner.password });
  const login = await ssh.exec(
    `rm -f ${hdr}; curl -sS -D ${hdr} -X POST ${adminHeaders(domain)}` +
      `--data ${shellQuote(body)} ` +
      `-w '\\n%{http_code}' ${shellQuote(`http://127.0.0.1:${port}/ghost/api/admin/session/`)}`,
  );
  const code = login.stdout.trim().split("\n").pop();
  if (code !== "201" && code !== "200") {
    throw new Error(`session login failed (${code}): ${login.stdout.slice(0, 300)}`);
  }
  // curl will not SEND a Secure cookie over http either, so a cookie jar
  // silently yields an unauthenticated request. Replay it explicitly.
  const cookie = (
    await ssh.must(
      `sed -n 's/^[Ss]et-[Cc]ookie: *\\(ghost-admin-api-session=[^;]*\\).*/\\1/p' ${hdr} | head -1`,
    )
  ).trim();
  await ssh.exec(`rm -f ${hdr}`);
  if (!cookie) throw new Error("Ghost accepted the login but issued no session cookie.");
  return cookie;
}

type Integration = { name?: string; api_keys?: Array<{ id: string; secret: string; type: string }> };

/**
 * Create (or reuse) a custom integration and return its Admin API key as
 * {id}:{secret} — the form themeseed expects. Uses the public Admin API rather
 * than inserting rows, so it survives Ghost upgrades.
 */
export async function createAdminKey(
  ssh: Ssh,
  port: number,
  domain: string,
  owner: { email: string; password: string },
  integrationName = "themeseed",
): Promise<string> {
  const cookie = await ownerCookie(ssh, port, domain, owner);
  const auth = `${adminHeaders(domain)}-H ${shellQuote(`Cookie: ${cookie}`)} `;

  /**
   * Ghost returns an ADMIN key's secret already as {id}:{secret} (89 chars).
   * Composing it again would double the id and produce a key that
   * authenticates nowhere. Content keys are a bare secret, hence the fallback.
   */
  const adminKeyOf = (i?: Integration): string | null => {
    const k = i?.api_keys?.find((x) => x.type === "admin");
    if (!k) return null;
    return k.secret.includes(":") ? k.secret : `${k.id}:${k.secret}`;
  };

  // Re-running must not pile up duplicate integrations.
  const listed = await ssh.exec(
    `curl -sS ${auth}${shellQuote(`http://127.0.0.1:${port}/ghost/api/admin/integrations/?include=api_keys`)}`,
  );
  try {
    const found = (JSON.parse(listed.stdout).integrations as Integration[] | undefined)?.find(
      (i) => i.name === integrationName,
    );
    const existing = adminKeyOf(found);
    if (existing) return existing;
  } catch {
    // Not listable — fall through and create one.
  }

  const created = await ssh.exec(
    `curl -sS -X POST ${auth}` +
      `--data ${shellQuote(JSON.stringify({ integrations: [{ name: integrationName }] }))} ` +
      `${shellQuote(`http://127.0.0.1:${port}/ghost/api/admin/integrations/`)}`,
  );
  const key = adminKeyOf((JSON.parse(created.stdout) as { integrations?: Integration[] }).integrations?.[0]);
  if (!key) throw new Error(`could not read admin key: ${created.stdout.slice(0, 300)}`);
  return key;
}

/** Upload a file to a multipart admin endpoint and return the parsed body. */
async function multipart(
  ssh: Ssh,
  port: number,
  domain: string,
  adminApiKey: string,
  path: string,
  remoteFile: string,
  field = "file",
): Promise<string> {
  const r = await ssh.exec(
    `curl -sS -X POST ` +
      `-H ${shellQuote(`Authorization: Ghost ${adminJwt(adminApiKey)}`)} ` +
      `-H ${shellQuote(`Host: ${domain}`)} ` +
      `-H ${shellQuote("X-Forwarded-Proto: https")} ` +
      `-F ${shellQuote(`${field}=@${remoteFile}`)} ` +
      `${shellQuote(`http://127.0.0.1:${port}${path}`)}`,
    { timeoutMs: 180_000 },
  );
  return r.stdout;
}

/**
 * Download or upload a theme zip, install it, and activate it.
 * `source` is an http(s) URL or a path on the machine running ghostkit.
 */
export async function installTheme(
  ssh: Ssh,
  port: number,
  domain: string,
  adminApiKey: string,
  source: string,
  activate = true,
): Promise<{ name: string; active: boolean }> {
  // Ghost names the installed theme after the uploaded FILE, so the zip's own
  // basename has to survive the trip — uploading as "ghostkit-theme.zip"
  // installs a theme called "ghostkit-theme".
  const isUrl = /^https?:\/\//i.test(source);
  const rawName = (isUrl ? new URL(source).pathname : source).split("/").pop() || "";
  const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, "") || "theme.zip";
  const tmpDir = "/tmp/ghostkit-theme";
  const tmp = `${tmpDir}/${safeName}`;
  await ssh.must(`rm -rf ${tmpDir} && mkdir -p ${tmpDir}`);

  if (isUrl) {
    await ssh.must(`curl -fsSL -o ${tmp} ${shellQuote(source)}`, { timeoutMs: 180_000 });
  } else {
    const bare = source.replace(/^file:\/\//, "");
    const local = resolvePath(bare.startsWith("~/") ? bare.replace("~", homedir()) : bare);
    if (!existsSync(local)) {
      throw new Error(`theme zip not found: ${local} (give a local path or an http(s) URL)`);
    }
    await ssh.upload(local, tmp);
  }

  const body = await multipart(ssh, port, domain, adminApiKey, "/ghost/api/admin/themes/upload/", tmp);
  await ssh.exec(`rm -rf ${tmpDir}`);

  const theme = (JSON.parse(body) as { themes?: Array<{ name: string; active: boolean }> }).themes?.[0];
  if (!theme) throw new Error(`theme upload failed: ${body.slice(0, 400)}`);
  if (!activate) return { name: theme.name, active: theme.active };

  // A fresh JWT: the upload can outlive the 5 minute token.
  const act = await ssh.curlLoopback(port, domain, `/ghost/api/admin/themes/${theme.name}/activate/`, {
    method: "PUT",
    headers: { Authorization: `Ghost ${adminJwt(adminApiKey)}` },
  });
  if (act.status < 200 || act.status >= 300) {
    throw new Error(`theme activate failed (${act.status}): ${act.body.slice(0, 300)}`);
  }
  return { name: theme.name, active: true };
}

/** Upload an image already sitting on the host; returns the URL Ghost stores. */
export async function uploadImage(
  ssh: Ssh,
  port: number,
  domain: string,
  adminApiKey: string,
  remoteFile: string,
): Promise<string> {
  const body = await multipart(ssh, port, domain, adminApiKey, "/ghost/api/admin/images/upload/", remoteFile);
  const url = (JSON.parse(body) as { images?: Array<{ url: string }> }).images?.[0]?.url;
  if (!url) throw new Error(`image upload failed: ${body.slice(0, 300)}`);
  return url;
}

/** PUT site settings. Values are strings; navigation is a JSON string. */
export async function updateSettings(
  ssh: Ssh,
  port: number,
  domain: string,
  adminApiKey: string,
  values: Record<string, string>,
): Promise<string[]> {
  const settings = Object.entries(values).map(([key, value]) => ({ key, value }));
  const r = await ssh.curlLoopback(port, domain, "/ghost/api/admin/settings/", {
    method: "PUT",
    headers: { Authorization: `Ghost ${adminJwt(adminApiKey)}` },
    json: { settings },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`settings update failed (${r.status}): ${r.body.slice(0, 300)}`);
  }
  return Object.keys(values);
}

/** Upload a theme's routes.yaml, when it ships one. */
export async function uploadRoutes(
  ssh: Ssh,
  port: number,
  domain: string,
  adminApiKey: string,
  remoteFile: string,
): Promise<boolean> {
  const body = await multipart(
    ssh,
    port,
    domain,
    adminApiKey,
    "/ghost/api/admin/settings/routes/yaml/",
    remoteFile,
    "routes",
  );
  return !/"errors"/.test(body);
}

/**
 * Point Ghost's transactional mail at SendGrid using ghost-cli, which writes
 * the nested config keys itself — no JSON editing, and it survives upgrades.
 * Covers staff invites and member signup/login only: Ghost sends newsletters
 * through Mailgun exclusively.
 */
export async function configureMail(
  ssh: Ssh,
  site: SiteLayout,
  opts: { apiKey: string; from: string },
): Promise<void> {
  const cfg = [
    "mail.transport SMTP",
    "mail.options.host smtp.sendgrid.net",
    "mail.options.port 587",
    "mail.options.auth.user apikey",
    `mail.options.auth.pass ${shellQuote(opts.apiKey)}`,
    `mail.from ${shellQuote(opts.from)}`,
  ]
    .map((c) => `ghost config ${c}`)
    .join(" && ");
  await ssh.must(`su - ${shellQuote(site.shellUser)} -c ${shellQuote(`cd ${site.ghostDir} && ${cfg}`)}`);
  // ghost-cli rewrites the file, so re-assert the mode: ISPConfig puts the web
  // server user in the client group and 640 would leak the database password.
  await ssh.must(`chmod 600 ${shellQuote(`${site.ghostDir}/config.production.json`)}`);
}

/** The Ghost version actually installed, read from the live symlink. */
export async function installedVersion(ssh: Ssh, site: SiteLayout): Promise<string> {
  const r = await ssh.exec(
    `readlink -f ${shellQuote(`${site.ghostDir}/current`)} 2>/dev/null | xargs -r basename`,
  );
  return r.stdout.trim() || "unknown";
}
