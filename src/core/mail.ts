import { Ssh, shellQuote } from "./ssh.js";

/**
 * Ghost's transactional mail, supplied as environment variables rather than
 * written into config.production.json — that file lives under the web-served
 * directory, so the fewer secrets in it the better. Ghost reads any config key
 * from the environment using `__` to separate nested properties.
 *
 * IMPORTANT: the env file is read by the *user* systemd manager, which runs as
 * the site user. A root-owned 0600 file would be unreadable and Ghost would
 * start with no mail config. It is therefore owned by the site user.
 */
export async function configureGhostMail(
  ssh: Ssh,
  opts: {
    domain: string;
    sysUser: string;
    sysGroup: string;
    unitPath: string;
    sendgridApiKey: string;
    from: string;
  },
): Promise<{ envPath: string }> {
  const envPath = `/etc/ghost/${opts.domain}.env`;
  const body = [
    "mail__transport=SMTP",
    "mail__options__host=smtp.sendgrid.net",
    "mail__options__port=587",
    // SendGrid's SMTP username is the literal string "apikey".
    "mail__options__auth__user=apikey",
    `mail__options__auth__pass=${opts.sendgridApiKey}`,
    `mail__from=${opts.from || `noreply@${opts.domain}`}`,
    "",
  ].join("\n");

  await ssh.must(`mkdir -p /etc/ghost && cat > ${shellQuote(envPath)} <<'GHOSTKIT_ENV'
${body}GHOSTKIT_ENV`);
  await ssh.must(`chown ${shellQuote(`${opts.sysUser}:${opts.sysGroup}`)} ${shellQuote(envPath)}`);
  await ssh.must(`chmod 600 ${shellQuote(envPath)}`);

  // Wire it into the unit if it is not already referenced.
  const line = `EnvironmentFile=-${envPath}`;
  await ssh.must(
    `grep -qF ${shellQuote(line)} ${shellQuote(opts.unitPath)} || ` +
      `sed -i ${shellQuote(`/^\\[Service\\]/a ${line}`)} ${shellQuote(opts.unitPath)}`,
  );
  return { envPath };
}

/**
 * The completion notification goes through the SendGrid API directly rather
 * than through Ghost: it is independent of tenant mail config and still works
 * while Ghost is restarting.
 */
export async function sendNotification(opts: {
  apiKey: string;
  to: string;
  from: string;
  subject: string;
  text: string;
}): Promise<{ sent: boolean; status: number; detail?: string }> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: opts.to }] }],
      from: { email: opts.from },
      subject: opts.subject,
      content: [{ type: "text/plain", value: opts.text }],
    }),
  });
  if (res.status === 202) return { sent: true, status: res.status };
  return { sent: false, status: res.status, detail: (await res.text()).slice(0, 500) };
}
