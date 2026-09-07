import { execFile, spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { promisify } from "node:util";
import type { Config } from "./config.js";

const run = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Two transports, deliberately:
 *  - an sshcon alias, when the user already manages the host that way
 *  - a plain ssh invocation, for anyone else
 *
 * Both shell out rather than using an SSH library so key handling, agents and
 * jump hosts stay the user's existing configuration rather than ours.
 */
export class Ssh {
  constructor(private readonly server: Config["server"]) {
    if (!server.sshcon_alias && !server.exec_alias && !server.host) {
      throw new Error("server.sshcon_alias or server.host must be set");
    }
  }

  private argv(command: string): [string, string[]] {
    // exec_alias wins: provisioning needs root, and the domain's own alias is
    // an unprivileged tenant login on the same box.
    const alias = this.server.exec_alias || this.server.sshcon_alias;
    if (alias) {
      return ["sshcon", ["exec", alias, "--no-cd", "--", command]];
    }
    const args: string[] = [];
    if (this.server.ssh_key_path) args.push("-i", this.server.ssh_key_path);
    if (this.server.port && this.server.port !== 22) args.push("-p", String(this.server.port));
    args.push(
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      `${this.server.user}@${this.server.host}`,
      command,
    );
    return ["ssh", args];
  }

  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const [bin, args] = this.argv(command);
    try {
      const { stdout, stderr } = await run(bin, args, {
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "",
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
  }

  /** Throws on non-zero exit. Use where a failure must stop the pipeline. */
  async must(command: string, opts: { timeoutMs?: number } = {}): Promise<string> {
    const r = await this.exec(command, opts);
    if (r.code !== 0) {
      throw new Error(`Remote command failed (${r.code}): ${command}\n${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  /**
   * Stream a local file to the host over the same transport exec() uses.
   * Piping through stdin rather than scp keeps one code path for an sshcon
   * alias and a plain ssh target alike, and never extracts a private key.
   */
  async upload(localPath: string, remotePath: string, opts: { timeoutMs?: number } = {}): Promise<number> {
    const size = statSync(localPath).size;
    const [bin, args] = this.argv(`cat > ${shellQuote(remotePath)}`);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 900_000);
      const fail = (e: Error) => { clearTimeout(timer); child.kill("SIGKILL"); reject(e); };

      child.stderr.on("data", (d) => { stderr += String(d); });
      child.on("error", fail);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`upload of ${localPath} failed (${code}): ${stderr}`));
      });

      const src = createReadStream(localPath);
      src.on("error", fail);
      src.pipe(child.stdin);
    });

    // A truncated stream is otherwise silent: cat exits 0 having written less.
    const check = await this.exec(`stat -c %s ${shellQuote(remotePath)} 2>/dev/null || echo 0`);
    const remoteSize = Number(check.stdout.trim());
    if (remoteSize !== size) {
      throw new Error(`upload size mismatch for ${remotePath}: local ${size}, remote ${remoteSize}`);
    }
    return size;
  }

  /**
   * Run something on the host against Ghost's loopback port. Used to claim
   * ownership before the site is publicly reachable — see the hijack window
   * note in MCP-SPEC.md.
   */
  async curlLoopback(
    port: number,
    host: string,
    path: string,
    init: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: string }> {
    const method = init.method ?? "GET";
    // Without X-Forwarded-Proto Ghost 301s every admin call back to https and
    // refuses to issue its Secure session cookie. In production the vhost sets
    // this header; over loopback we have to supply it ourselves.
    const headers = {
      "Content-Type": "application/json",
      Host: host,
      "X-Forwarded-Proto": "https",
      ...(init.headers ?? {}),
    };
    const headerArgs = Object.entries(headers)
      .map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`)
      .join(" ");
    const data = init.json !== undefined ? `--data ${shellQuote(JSON.stringify(init.json))}` : "";
    const url = `http://127.0.0.1:${port}${path}`;
    const cmd = `curl -sS -X ${method} ${headerArgs} ${data} -w '\\n%{http_code}' ${shellQuote(url)}`;
    const r = await this.exec(cmd);
    const out = r.stdout.trimEnd();
    const idx = out.lastIndexOf("\n");
    const status = Number(out.slice(idx + 1));
    return { status: Number.isFinite(status) ? status : 0, body: out.slice(0, Math.max(0, idx)) };
  }
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
