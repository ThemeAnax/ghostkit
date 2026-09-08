#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import pc from "picocolors";
import { initConfig, loadConfig } from "../core/config.js";
import { Ssh } from "../core/ssh.js";
import { preflight, setupStatus, installedVersion } from "../core/ghost.js";
import { resolveSite, apacheDirectives, serviceState } from "../core/site.js";
import { EDITORS, detectAll, registerEditor, latestVersion, launchCommand, PACKAGE } from "../core/editors.js";

const VERSION = "0.4.1";

const program = new Command();
program.name("ghostkit").description("Install Ghost on any SSH-reachable ISPConfig host").version(VERSION);

function statusLine(e: { detected: boolean; registered: boolean; usesLatest?: boolean }): string {
  if (!e.detected) return pc.dim("not installed");
  if (!e.registered) return pc.yellow("not registered");
  return e.usesLatest ? pc.green("registered (latest)") : pc.yellow("registered (local build)");
}

program
  .command("editors")
  .description("Show which editors are installed and whether ghostkit is registered")
  .action(async () => {
    for (const e of await detectAll()) {
      console.log(`  ${e.label.padEnd(13)} ${statusLine(e)}`);
      if (e.current) console.log(pc.dim(`      -> ${e.current}`));
    }
    const { command, args } = launchCommand();
    console.log(pc.dim(`\n  'ghostkit install' registers: ${command} ${args.join(" ")}`));
  });

program
  .command("install")
  .alias("setup")
  .description("Register ghostkit as an MCP server in your editors")
  .option("--editors <ids>", "Comma-separated ids, e.g. claude,cursor")
  .option("--all", "Every detected editor, no prompt")
  .option("-y, --yes", "Assume yes; same as --all")
  .option("--force", "Rewrite even when already pointing at @latest")
  .action(async (opts: { editors?: string; all?: boolean; yes?: boolean; force?: boolean }) => {
    const detected = await detectAll();
    const available = detected.filter((d) => d.detected);

    if (!available.length) {
      console.log(pc.yellow("No supported editors found."));
      console.log(pc.dim(`Looked for: ${EDITORS.map((e) => e.label).join(", ")}`));
      return;
    }

    let chosen: string[];
    if (opts.editors) {
      chosen = opts.editors.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (opts.all || opts.yes || !process.stdin.isTTY) {
      // Non-interactive (a pipe, or CI) must not hang waiting on a prompt.
      chosen = available.map((e) => e.id);
    } else {
      console.log(pc.bold("\nEditors found:\n"));
      available.forEach((e, i) => {
        console.log(`  ${String(i + 1).padStart(2)}. ${e.label.padEnd(13)} ${statusLine(e)}`);
      });
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (
        await rl.question(pc.bold("\nRegister which? [numbers, 'a' for all, Enter to cancel] "))
      ).trim();
      rl.close();
      if (!answer) {
        console.log(pc.dim("Cancelled; nothing was changed."));
        return;
      }
      chosen =
        answer.toLowerCase() === "a"
          ? available.map((e) => e.id)
          : answer
              .split(/[\s,]+/)
              .map((n) => available[Number(n) - 1]?.id)
              .filter((x): x is string => Boolean(x));
    }

    const defs = EDITORS.filter((e) => chosen.includes(e.id));
    if (!defs.length) {
      console.log(pc.red("Nothing matched."));
      return;
    }

    console.log("");
    let changed = false;
    for (const def of defs) {
      const r = await registerEditor(def, { force: opts.force });
      const mark = r.ok ? (r.action === "unchanged" ? pc.dim("=") : pc.green("OK")) : pc.red("!!");
      console.log(`  ${mark}  ${r.label.padEnd(13)} ${r.action}${r.error ? pc.red(" - " + r.error) : ""}`);
      if (r.backup) console.log(pc.dim(`      backup: ${r.backup}`));
      if (r.ok && r.action !== "unchanged") changed = true;
    }

    if (changed) console.log(pc.bold("\nRestart those editors - MCP servers are loaded at startup."));
    console.log(pc.dim("Updates: the registration pins @latest, so restarting an editor picks up new releases."));
  });

program
  .command("version-check")
  .description("Show the running version and the newest published one")
  .action(async () => {
    const latest = await latestVersion();
    console.log(`  running   ${VERSION}`);
    console.log(`  latest    ${latest ?? pc.dim("could not reach the registry")}`);
    if (latest && latest !== VERSION) {
      console.log(pc.yellow(`\n  A newer ${PACKAGE} is published.`));
      console.log(pc.dim("  Restart your editor - the npx @latest registration fetches it."));
    } else if (latest) {
      console.log(pc.green("\n  Up to date."));
    }
  });

program
  .command("init")
  .description("Write a blank ghostkit.config.json")
  .action(() => {
    const r = initConfig();
    console.log(r.created ? pc.green(`created ${r.path}`) : pc.yellow(`exists ${r.path}`));
    for (const f of r.needsFilling) console.log(pc.dim(`  still required: ${f}`));
    console.log(pc.dim("\nNext: fill those in, then run 'ghostkit preflight'."));
    console.log(pc.dim("To drive ghostkit from your editor, run 'ghostkit install'."));
  });

program
  .command("preflight")
  .description("Check the host is ready")
  .action(async () => {
    const cfg = loadConfig();
    const r = await preflight(new Ssh(cfg.server), { domain: cfg.site.domain });
    for (const c of r.checks) {
      const mark = c.ok ? pc.green("PASS") : c.blocking ? pc.red("FAIL") : pc.yellow("WARN");
      console.log(`${mark}  ${c.name.padEnd(24)} ${c.detail}`);
      if (!c.ok && c.fix) console.log(pc.dim(`      fix: ${c.fix}`));
    }
    console.log(`\n${r.db.engine} ${r.db.version}`);
    if (r.blocked) process.exitCode = 1;
  });

program
  .command("status")
  .description("Is the site up, and has anyone claimed it?")
  .action(async () => {
    const cfg = loadConfig();
    const ssh = new Ssh(cfg.server);
    const site = await resolveSite(ssh, cfg.site.domain);
    const claimed = await setupStatus(ssh, site.port, cfg.site.domain);
    console.log(`domain    ${site.domain}`);
    console.log(`ghost     ${await installedVersion(ssh, site)}`);
    console.log(`service   ${await serviceState(ssh, site)}`);
    console.log(`port      ${site.port}`);
    console.log(`claimed   ${claimed ? pc.green("yes") : pc.red("NO - anyone can claim this site")}`);
    console.log(`admin     https://${site.domain}/ghost/`);
  });

program
  .command("directives")
  .description("Print the Apache directive block for the configured site")
  .action(async () => {
    const cfg = loadConfig();
    const site = await resolveSite(new Ssh(cfg.server), cfg.site.domain);
    console.log(apacheDirectives(site.port));
  });

await program.parseAsync();
