import pc from "picocolors";
import fs from "node:fs";
import { getPidFilePath } from "../config/index.js";

// ── CLI Utilities ───────────────────────────────────────────────────────

export function log(msg: string): void {
  console.log(msg);
}

export function info(msg: string): void {
  console.log(pc.blue("ℹ") + " " + msg);
}

export function success(msg: string): void {
  console.log(pc.green("✓") + " " + msg);
}

export function warn(msg: string): void {
  console.log(pc.yellow("⚠") + " " + msg);
}

export function error(msg: string): void {
  console.error(pc.red("✗") + " " + msg);
}

export function header(title: string): void {
  console.log();
  console.log(pc.bold(`  🧠 OpenClaw Memory — ${title}`));
  console.log();
}

export function bullet(label: string, value: string, status?: "ok" | "error" | "disabled" | "degraded"): void {
  const dot = status === "ok" ? pc.green("●")
    : status === "error" ? pc.red("●")
    : status === "degraded" ? pc.yellow("●")
    : status === "disabled" ? pc.dim("○")
    : " ";
  console.log(`  ${dot} ${pc.bold(label)}  ${value}`);
}

// ── Server Detection ────────────────────────────────────────────────────

export function getServerPid(): number | null {
  const pidPath = getPidFilePath();
  if (!fs.existsSync(pidPath)) return null;

  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;

    // Check if process is alive
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process not running, clean up stale PID file
      fs.unlinkSync(pidPath);
      return null;
    }
  } catch {
    return null;
  }
}

export async function isServerRunning(baseUrl: string = "http://localhost:7777"): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function getBaseUrl(port?: number): string {
  return `http://localhost:${port || 7777}`;
}

// ── HTTP Client ─────────────────────────────────────────────────────────

export async function apiGet(baseUrl: string, path: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export async function apiPost(baseUrl: string, path: string, body: unknown, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export async function apiDelete(baseUrl: string, path: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Output Formatting ───────────────────────────────────────────────────

export function output(data: unknown, format: "json" | "text" = "json"): void {
  if (format === "text") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data));
  }
}

// ── Stdin Reading ───────────────────────────────────────────────────────

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}
