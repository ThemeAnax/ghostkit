<div align="center">

# 👻 ghostkit

**Get a real Ghost site running on your server. Then get out of the way.**

Installs the latest Ghost on any SSH-reachable ISPConfig host — database, loopback port,
`systemd --user` unit, vhost directives — and claims the owner account before the site is
ever public. You pick the theme and wire up email yourself, in Ghost, where those choices
belong.

Ships as an **MCP server** and a **CLI**.

</div>

---

## What it does, and what it deliberately doesn't

| ghostkit does | left to you |
|---|---|
| Create the database and user | Write the articles — that's [themeseed](https://github.com/ThemeAnax/themeseed) |
| Allocate a free loopback port | |
| Install the **latest** Ghost | |
| **Claim the owner account, over loopback** | |
| Create the Admin API key for themeseed | |
| Upload and activate your theme, plus its `routes.yaml` | |
| Generate a favicon, wordmark, accent colour and navigation | |
| Wire SendGrid for transactional mail | |
| Run it under `systemd --user`, no sudo for the tenant | |
| Emit the vhost directives | |

Claiming the owner is automated because it is not really a choice — it is a race. Ghost's
setup endpoint is unauthenticated and fires exactly once, so the only safe moment to call
it is while Ghost is still bound to `127.0.0.1` and nobody else can reach it.

## Installing it into your editors

ghostkit registers itself. Ask your agent to run `detect_editors`, pick the ones you want,
and it calls `register_editors`:

| Editor | Config it writes |
|---|---|
| Claude Code | `~/.claude.json` |
| Codex | `~/.codex/config.toml` (TOML section, rest of the file untouched) |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |
| Antigravity | via its own `agy mcp add` |
| Zed | `~/.config/zed/settings.json` (`context_servers`) |
| VS Code | `~/Library/.../Code/User/mcp.json` |

Every file is backed up first, because rewriting JSON drops comments.

**Updates take care of themselves.** Registration uses
`npx -y --package @indianic/ghostkit@latest ghostkit-mcp`, which re-resolves the registry
on every launch — so restarting your editor is the update. `version` shows what is running
against what is published. The server never rewrites its own code mid-session; that would
change tool behaviour under a running agent and break every editor at once on a bad
release.

## Quick start

```bash
npx @indianic/ghostkit init      # writes a blank ghostkit.config.json
$EDITOR ghostkit.config.json     # set site.domain + server.sshcon_alias
npx @indianic/ghostkit preflight # is the host actually ready?
```

As an MCP server:

```jsonc
// ~/.claude.json  →  mcpServers
{
  "ghostkit": {
    "command": "npx",
    "args": ["-y", "--package", "@indianic/ghostkit", "ghostkit-mcp"]
  }
}
```

Then:

> *"Use ghostkit with dir `~/sites/blog.example.com` — resolve_server, preflight,
> install_ghost, publish_site."*

## Configuration

The whole file, when you use sshcon:

```json
{
  "site":     { "domain": "blog.example.com", "title": "My Blog", "port": null },
  "admin":    { "name": "Jane Doe", "email": "jane@example.com", "password": "", "api_key": "" },
  "theme":    { "source": "~/themes/bastian.zip", "activate": true },
  "branding": { "description": "", "accent_color": "", "generate_assets": true, "navigation": [] },
  "mail":     { "sendgrid_api_key": "", "from": "" },
  "author":   { "name": "", "email": "" },
  "server":   { "sshcon_alias": "blog-example" },
  "database": { "name": "", "user": "", "password": "" }
}
```

Everything except `site.domain`, `admin.name` and `admin.email` is optional:

- `theme.source` — a local zip path or an http(s) URL. Blank keeps Ghost's default theme.
- `branding.accent_color` — blank derives a stable colour from the title.
- `author` — byline for generated content; themeseed asks per blog without it.
- `admin.api_key` and `admin.password` are **written by** ghostkit, not filled in by you.

Leave `admin.password` blank and ghostkit generates a 20-character one, writes it back to
this file, and returns it in the tool result. Give it one instead if you'd rather; Ghost
requires at least 10 characters. `site.title` falls back to the domain.

The file holds the database password and the admin password, so it is written `0600` — and
a config left `0644` by an older version is corrected on the next write.

`resolve_server` runs `sshcon list <alias> all` and fills in the rest — the root exec
alias, host, SSH port, the database the panel provisioned, and the allocated application
port. **Without sshcon**, fill `server.host`, `server.user`, `server.ssh_key_path` and the
whole `database` block by hand; nothing can discover them for you.

Note the `server` block has one field. Nothing is pre-answered: a value in this file is a
decision you made, never one ghostkit guessed for you.

## Tools

| Tool | Does |
|---|---|
| `init_config` | Write a blank config; list what still needs filling |
| `resolve_server` | Fill server + database from an sshcon alias |
| `config_status` | Report remaining blank fields |
| `preflight` | Host readiness matrix + fix commands |
| `install_ghost` | Install the latest Ghost, then claim the owner over loopback |
| `create_admin` | Claim the owner on its own — retry, or an older install |
| `create_admin_key` | Admin API key as `{id}:{secret}`, saved to `admin.api_key` |
| `install_theme` | Upload + activate a theme, and its `routes.yaml` |
| `apply_branding` | Favicon, wordmark, accent colour, navigation |
| `configure_mail` | SendGrid for transactional mail |
| `publish_site` | Return the vhost directives; you apply them |
| `status` | Is it up, and **has anyone claimed it yet?** |
| `next_steps` | The hand-off instructions |
| `detect_editors` / `register_editors` | Install ghostkit into your editors |
| `version` | Running vs published |

## Why the order matters

`POST /ghost/api/admin/authentication/setup/` is **unauthenticated and works exactly
once**. Whoever calls it first owns the publication — no login required, no way to undo it.

That makes the obvious install order dangerous: point DNS and a reverse proxy at a fresh
Ghost, then set up the owner, and there is a window — minutes, or days — in which any
stranger who finds the URL can claim your client's blog.

ghostkit closes it by construction:

| Step | Reachable from | Why |
|---|---|---|
| `install_ghost` | `127.0.0.1` only | nothing public exists yet |
| ↳ owner claimed | `127.0.0.1` only | claimed where nobody else can reach it |
| `publish_site` | the internet | the site is already owned |

`status` will tell you the truth at any point:

```
owner_claimed   true
```

If it ever says `false` on a published site, run `create_admin` immediately — though at
that point you are in a race you may already have lost.

## Requirements

`preflight` checks all of this and prints fix commands:

| Requirement | Notes |
|---|---|
| The website + an active shell user in ISPConfig | **Chroot = None** |
| Node `^22.23.1` | Ghost 6's own requirement |
| `ghost-cli` | `npm i -g ghost-cli` |
| MySQL 8 or MariaDB | see below |
| systemd (`loginctl`) | for `--user` units + linger |

Node and ghost-cli are checked **as the tenant**, not as root. Root's `PATH` says nothing
about the shell user's, and that mismatch is a genuinely confusing way for an install to
fail: preflight goes green, then `ghost install` cannot find `ghost`.

### Jailkit is a hard blocker

A jailkit chroot has no `XDG_RUNTIME_DIR` and no dbus socket, so `systemctl --user` cannot
work inside one — the owner could never restart their own site. Set **Chroot = None**.

### MariaDB

Ghost's official position is that MySQL 8 is the only supported database. In practice
Ghost 6.62 installs and runs on MariaDB 10.11; there is no version check in ghost-cli or
Ghost that blocks it. ghostkit installs the latest Ghost either way and tells you which
engine it found.

## Gotchas worth knowing

<details>
<summary><strong>The vhost needs <code>X-Forwarded-Proto</code>, or nobody can sign in</strong></summary>

Ghost issues its admin session cookie with `Secure`, and express-session will not *issue*
a Secure cookie on a connection it believes is plain http. `mod_proxy` does not set
`X-Forwarded-Proto` itself. Without that header `POST /ghost/api/admin/session/` returns
**201 with no `Set-Cookie`** and the admin UI simply spins — a success status and a
completely broken login.

This is why `publish_site` tells you to use `sshmanager_update_domain` and **not**
`sshmanager_set_domain_port`: the latter regenerates its own proxy block and drops the
header.
</details>

<details>
<summary><strong>Ghost emails a sign-in code, and that locks you out</strong></summary>

Ghost 5.9x+ defaults `security.staffDeviceVerification` to true and emails a code on every
staff sign-in. On a site with no mail configured the session endpoint fails outright — you
cannot log in to the site you just created.

ghostkit sets it to `false` at install. Once SendGrid works, set it back to `true`.
`next_steps` spells this out.
</details>

<details>
<summary><strong>Never proxy <code>/.well-known/</code></strong></summary>

Proxy it and Let's Encrypt renewals fail silently about 60 days later. The emitted
directives exclude it, and the installer moves `.well-known` aside and restores it around
the install, because `ghost install` refuses any non-empty directory.
</details>

<details>
<summary><strong><code>--process local</code> is mandatory</strong></summary>

`--no-setup-systemd` only skips *creating* the unit; it leaves `"process": "systemd"` in
the config. Every later `ghost` command then shells out to `sudo systemctl …`, which hangs
forever on a password prompt the tenant cannot answer.
</details>

<details>
<summary><strong><code>ghost ls</code> will say "stopped" — ignore it</strong></summary>

Ghost-CLI's `local` process manager cannot see the `systemd --user` unit. Trust
`systemctl --user is-active ghost`.
</details>

<details>
<summary><strong>The web folder gets cleared</strong></summary>

Ghost installs into the domain's own web folder, and `ghost install` requires it empty.
ISPConfig defaults (`standard_index.html`, `favicon.ico`, `robots.txt`) and a previous
Ghost are removed without ceremony; `.well-known` and `error/` are preserved. Anything
else stops the install until you pass `wipe: true`.
</details>

## Development

```bash
npm install
npm run build
```

Probe the MCP server directly:

```bash
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | node dist/mcp/index.js
```

## Related

- [themeseed](https://github.com/ThemeAnax/themeseed) — reads the active theme and
  generates content that fits it. Give it the Admin API key you create in Ghost.
- [Ghost](https://ghost.org) · [Ghost-CLI docs](https://ghost.org/docs/ghost-cli/)
- [Model Context Protocol](https://modelcontextprotocol.io)

## License

MIT © [ThemeAnax](https://github.com/ThemeAnax)
