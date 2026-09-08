#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { initConfig, loadConfig } from "../core/config.js";
import { Ssh } from "../core/ssh.js";
import { preflight, setupStatus, installedVersion } from "../core/ghost.js";
import { resolveSite, apacheDirectives, serviceState } from "../core/site.js";

const program = new Command();
program.name("ghostkit").description("Install Ghost on any SSH-reachable ISPConfig host").version("0.4.0");

program
  .command("init")
  .description("Write a blank ghostkit.config.json")
  .action(() => {
    const r = initConfig();
    console.log(r.created ? pc.green(`created ${r.path}`) : pc.yellow(`exists ${r.path}`));
    for (const f of r.needsFilling) console.log(pc.dim(`  still required: ${f}`));
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
    console.log(`claimed   ${claimed ? pc.green("yes") : pc.red("NO — anyone can claim this site")}`);
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
