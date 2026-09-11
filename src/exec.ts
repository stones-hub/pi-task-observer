import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface ExecArgvOptions {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
}

export function execArgv(command: string, args: string[], options: ExecArgvOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ stdout: "", stderr: "aborted", code: null, killed: true, stdoutTruncated: false, stderrTruncated: false });
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const maxBytes = options.maxStdoutBytes ?? 1024 * 1024;
    const maxStderrBytes = 64 * 1024;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killed = false;
    let settled = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const onAbort = (): void => {
      killed = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk, maxBytes);
      stdout = next.buffer;
      if (next.truncated) stdoutTruncated = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, maxStderrBytes);
      stderr = next.buffer;
      if (next.truncated) stderrTruncated = true;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        code,
        killed,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

function appendBounded(current: Buffer, chunk: Buffer, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  if (current.length >= maxBytes) return { buffer: current, truncated: true };
  const next: Buffer = Buffer.concat([current, chunk]);
  if (next.length <= maxBytes) return { buffer: next, truncated: false };
  return { buffer: next.subarray(0, maxBytes), truncated: true };
}
