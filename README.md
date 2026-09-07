<div align="center">

# 👻 ghostkit

**Get a real Ghost site running on your server. Then get out of the way.**

Installs the latest Ghost on any SSH-reachable ISPConfig host — database, loopback port,
`systemd --user` unit, vhost directives — and stops there. You create the admin account,
pick the theme, and wire up email yourself, in Ghost, where those choices belong.

Ships as an **MCP server** and a **CLI**.

</div>

---

## What it does, and what it deliberately doesn't

| ghostkit does | you do, in Ghost |
|---|---|
| Create the database and user | Create the owner account at `/ghost/` |
| Allocate a free loopback port | Upload your theme |
| Install the **latest** Ghost | Configure SendGrid |
| Run it under `systemd --user`, no sudo for the tenant | Create the Admin API key |
| Emit the vhost directives | |

Earlier versions of this tool created the owner, uploaded a theme and configured mail.
All three were one-time choices that belong to whoever owns the publication, and each one
added a way for the install to fail. Now it installs Ghost and hands you a link.

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
  "site":   { "domain": "blog.example.com", "port": null },
  "server": { "sshcon_alias": "blog-example" },
  "database": { "name": "", "user": "", "password": "" }
}
```

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
| `install_ghost` | Install the latest Ghost into the domain's web folder |
| `publish_site` | Return the vhost directives; you apply them |
| `status` | Is it up, and **has anyone claimed it yet?** |
| `next_steps` | The hand-off instructions |

## The one thing to be careful about

`POST /ghost/api/admin/authentication/setup/` is **unauthenticated and one-shot**.
Whoever opens `/ghost/` first owns the site.

ghostkit installs Ghost bound to `127.0.0.1` only. Nothing is reachable until you apply
the directives from `publish_site`. From that moment the site is claimable by anyone who
finds the URL, so **claim it immediately** and confirm with `status`:

```
claimed   NO — anyone can claim this site
```

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
