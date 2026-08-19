#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { initConfig, loadConfig } from "../core/config.js";
import { Ssh } from "../core/ssh.js";
import { preflight } from "../core/ghost.js";
import { resolveSite, apacheDirectives } from "../core/site.js";

const program = new Command();
program.name("ghostkit").description("Provision Ghost with a theme on any SSH-reachable host").version("0.1.0");

program
  .command("init")
  .description("Write a blank ghostkit.config.json")
  .action(() => {
    const r = initConfig();
    console.log(r.created ? pc.green(`created ${r.path}`) : pc.yellow(`exists ${r.path}`));
    if (r.needsFilling.length) {
      console.log(pc.dim("still required:"));
      for (const f of r.needsFilling) console.log(`  - ${f}`);
    }
  });

program
  .command("preflight")
  .description("Check the host is ready")
  .action(async () => {
    const cfg = loadConfig();
    const ssh = new Ssh(cfg.server);
    const r = await preflight(ssh, { domain: cfg.site.domain });
    for (const c of r.checks) {
      const mark = c.ok ? pc.green("PASS") : c.blocking ? pc.red("FAIL") : pc.yellow("WARN");
      console.log(`${mark}  ${c.name.padEnd(28)} ${c.detail}`);
      if (!c.ok && c.fix) console.log(pc.dim(`      fix: ${c.fix}`));
    }
    console.log(`\nGhost ${r.db.ghostVersion} on ${r.db.engine} ${r.db.version}`);
    if (r.blocked) process.exitCode = 1;
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
