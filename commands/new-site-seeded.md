---
description: Stand up a Ghost site end to end and fill it with themeseed-generated articles
argument-hint: <theme-name> [server-name]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Stand up one Ghost site for the theme **$1** and fill it with generated articles from
themeseed. Run the steps yourself, stopping where this runbook says to stop.

## Parameters

Theme name: `$1`. Server: `$2` when given.

Derive everything you can from the theme name, and show the derived values before
using them:

| | |
|---|---|
| site domain | `$1.ghost.preview.themeanax.com` |
| site title | `$1` in Title Case |
| sshcon alias / connection_name | `$1-ghost` |
| package dir | `~/Documents/ghost-theme/$1` |
| theme zip | `<package dir>/$1.zip` |
| routes file | `<package dir>/routes.yaml` |
| config dir | `~/ghost-sites/$1` |
| themeseed sites file | `~/.themeseed/sites.json` |
| seed site key | `$1-ghost` |

Ask me, in ONE question, only for what you cannot derive and do not already have:

- the ISPConfig server to install on, unless `$2` was given (never guess this —
  `sshmanager_provision_domain` needs `server_name`, and names do not match ids)
- admin email, author name, author email
- how many posts, and the topics to write about
- the SendGrid API key, if transactional mail is wanted
- a different base domain or package dir, if the derived ones do not exist

Then confirm ghostkit is at least 0.8.0 (`version` tool). Older versions allow ports
inside ISPConfig's FPM range. If it is older, say so and stop.

## Step 0 — resolve the files

List the package dir. Confirm the theme zip and `routes.yaml` exist. Theme packages
do not all use the same filenames: if a derived path is missing, show me what IS in
the package and ask which file to use. Never invent a path. If there is no
`routes.yaml`, leave `content.routes` blank and tell me.

## Step 1 — provision the host

`sshmanager_provision_domain` with `server_name`, `domain`, `connection_name =
$1-ghost`, `create_shell`, `create_db` (MySQL) and `ssl` all true. Let ISPConfig
derive the shell user, db name and db user from the domain. Read `connection_name`,
the FINAL prefixed database name and user, and the db password back out of the
response and show them to me.

**The application port is not ISPConfig's to choose.** ISPConfig allocates PHP-FPM
pools from 9000–9099, one per new site, and knows nothing about Ghost. A Ghost site
in that range collides the next time a PHP site is created; php-fpm then cannot bind
its pool and systemd fails the whole service, taking every PHP site on the box down.
This has already happened on server4 — one site held 9047, which ISPConfig later
gave to another site's pool.

Pick the port yourself from the Ghost range 51000–51999:

```
sshcon exec <server> -- 'ss -tlnp | grep node | grep -oE "127.0.0.1:[0-9]+" | cut -d: -f2 | sort -n | tail -1'
```

Take the highest Ghost port + 1, then verify it is between 51000 and 51999, is NOT
in 9000–9099, and that `ss -tln | grep ":<port> "` returns nothing. If any check
fails, stop and tell me — do not silently pick another port, and never continue with
a port ISPConfig suggested. Show me the port and the checks that passed.

## Step 2 — write the config

Write `<config dir>/ghostkit.config.json`: domain, title, the port you chose,
`server.sshcon_alias`, the database block from the provision response, admin name
and email, `theme.source`, `content.routes`, the SendGrid key and `mail.from`, and
the author block.

Leave `content.source` blank — there is no demo export in this run. Leave
`admin.password` and `admin.api_key` blank; ghostkit writes those.

## Step 3 — install

Run these ghostkit tools against the config dir, stopping at the first failure:

1. `resolve_server` — fills host, exec alias, SSH port and database from the alias.
   If it returns an `application_port_note`, read it to me; never let the panel's
   port replace the one from step 1.
2. `config_status` — tell me what you found and what is missing, and ask me **only**
   about the missing fields before going on.
3. `preflight` — show any fixes and stop. If it lists `ip_bound_vhosts`, stop and
   show me that list first.
4. `install_ghost`
5. `create_admin_key` — writes the key into `admin.api_key`
6. `install_theme` with `activate: true` — **before** seeding: themeseed reads the
   ACTIVE theme, and without this it generates against Casper
7. If `content.routes` is set, upload it: `import_content` with `source: "none"`
8. `apply_branding`, `configure_mail`
9. `publish_site` — show me the directives

### 9a. Verify the vhost is not bound to an IP

```
sshcon exec <server> -- 'grep -ho "VirtualHost [^>]*" /etc/apache2/sites-enabled/*<domain>*.vhost'
```

Both blocks must read `*:80` and `*:443`. If either shows an IP address, **stop and
tell me**. In Apache a vhost bound to a specific IP forms its own matching set for
that IP, and every request arriving there matches that set first — so one IP-bound
vhost captures traffic meant for every other site on the box, serving its own
certificate and then a 403 because the Host does not match. On server4 this took all
36 Ghost sites down at once.

Do not fix it by editing the file; ISPConfig regenerates these. Tell me, and I will
correct the site's IPv4 Address in the panel.

10. `status` — confirm the site is up and the owner is claimed

## Step 4 — seed the content

Add this to `~/.themeseed/sites.json`, keeping every existing entry intact:

```json
"$1-ghost": {
  "platform": "ghost",
  "url": "https://$1.ghost.preview.themeanax.com",
  "credentials": { "adminApiKey": "<the admin.api_key ghostkit just wrote>" }
}
```

Then seed the agreed number of published posts across the agreed topics, mixing news
and opinion, every post with a stock feature image, bylined to the author from the
config, shaped to the active theme's design. Report how many actually published and
whether any came out without an image.

Do not import a demo-content export here — the content comes from themeseed.

## Step 5 — verify and report

Open the live site. Every route the theme's `routes.yaml` defines should load, and
the seeded posts should show their feature images. Tell me any that 404.

Finally, draft a session summary with the mailman MCP: site URL, Ghost admin URL,
admin email and generated password, Admin API key, sshcon alias and host, database
name/user/password, and the chosen port. Show me the draft and send it only after I
confirm.
