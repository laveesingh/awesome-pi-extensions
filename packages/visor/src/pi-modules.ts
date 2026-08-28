import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
// ── Pi module resolution — no hard-coded nvm paths ──────────────────────────

export function debugLog(msg: string): void {
  if (process.env.PI_DEBUG !== "1") return;
  try {
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync("/tmp/pi-visor.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

export function findPiDistDir(): string | null {
  try {
    const piBin = execSync("which pi", { encoding: "utf8" }).trim();
    debugLog(`findPiDistDir piBin=${piBin}`);
    if (!piBin) return null;
    let real = piBin;
    try {
      real = readlinkSync(piBin);
      if (!real.startsWith("/")) {
        real = resolve(dirname(piBin), real);
      }
    } catch {}
    debugLog(`findPiDistDir real=${real}`);
    let dir = dirname(real);
    for (let i = 0; i < 6; i++) {
      const pkg = `${dir}/package.json`;
      try {
        if (existsSync(pkg)) {
          const content = readFileSync(pkg, "utf8");
          if (content.includes('"@earendil-works/pi-coding-agent"')) {
            return `${dir}/dist`;
          }
        }
      } catch {}
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // Fallback: derive from known layout pi/dist/bundle/cli.js -> pi/dist
    if (real.includes("/dist/")) {
      return real.split("/dist/")[0] + "/dist";
    }
  } catch {}
  return null;
}

export function loadPiModule(cacheSuffix: string, distSuffix: string): Record<string, unknown> | null {
  // 1) Scan require.cache for already-loaded module (most reliable)
  try {
    const req = createRequire(import.meta.url) as unknown as { cache?: Record<string, { exports: unknown }> };
    const cache = req.cache;
    if (cache) {
      for (const key of Object.keys(cache)) {
        if (key.endsWith(cacheSuffix) || key.endsWith(distSuffix)) {
          const mod = cache[key]?.exports as Record<string, unknown> | undefined;
          if (mod && typeof mod === "object") {
            debugLog(`loadPiModule cache hit ${key}`);
            return mod;
          }
        }
      }
      // Fallback: scan all cached modules for AssistantMessageComponent export (bundled case)
      for (const key of Object.keys(cache)) {
        const mod = cache[key]?.exports as Record<string, unknown> | undefined;
        if (mod && typeof mod === "object" && (mod as Record<string, unknown>).AssistantMessageComponent) {
          debugLog(`loadPiModule found AssistantMessageComponent in ${key}`);
          return mod;
        }
      }
      // second pass: loose match
      for (const key of Object.keys(cache)) {
        if (key.includes("assistant-message") && cacheSuffix.includes("assistant-message")) {
          const mod = cache[key]?.exports as Record<string, unknown> | undefined;
          if (mod?.AssistantMessageComponent) return mod;
        }
        if (key.includes("agent-session") && cacheSuffix.includes("agent-session")) {
          const mod = cache[key]?.exports as Record<string, unknown> | undefined;
          if (mod?.AgentSession) return mod;
        }
        if (key.includes("theme/theme") && cacheSuffix.includes("theme")) {
          const mod = cache[key]?.exports as Record<string, unknown> | undefined;
          if (mod?.theme) return mod;
        }
      }
    }
  } catch {}

  // 2) Try via pi dist dir derived from `which pi`
  try {
    const distDir = findPiDistDir();
    if (distDir) {
      const req = createRequire(import.meta.url);
      const candidates = [
        `${distDir}/${distSuffix}`,
        `${distDir}/${cacheSuffix}`,
      ];
      for (const p of candidates) {
        try {
          if (existsSync(p)) {
            const mod = req(p) as Record<string, unknown>;
            if (mod) return mod;
          }
        } catch {}
      }
    }
  } catch {}

  // 3) Try common global locations
  try {
    const req = createRequire(import.meta.url);
    const globalCandidates = [
      `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/${distSuffix}`,
      `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/${distSuffix}`,
      `${process.env.HOME}/.nvm/versions/node/${process.versions.node}/lib/node_modules/@earendil-works/pi-coding-agent/dist/${distSuffix}`,
    ];
    for (const p of globalCandidates) {
      try {
        if (existsSync(p)) {
          const mod = req(p) as Record<string, unknown>;
          if (mod) return mod;
        }
      } catch {}
    }
  } catch {}

  return null;
}

export function loadAssistantMessageModule(): Record<string, unknown> | null {
  // The static ESM import is the live class — see the note on the import itself.
  // It is also available before the first assistant message exists, which the
  // old object-graph walk was not: that walk needs an INSTANCE to reach a
  // prototype, so on a fresh session ctrl+O had nothing patched to talk to.
  if (typeof AssistantMessageComponent === "function") {
    return { AssistantMessageComponent } as Record<string, unknown>;
  }
  // Try direct scan for AssistantMessageComponent first (handles bundled cli.js)
  try {
    const req = createRequire(import.meta.url) as unknown as { cache?: Record<string, { exports: unknown }> };
    const cache = req.cache;
    if (cache) {
      for (const key of Object.keys(cache)) {
        const mod = cache[key]?.exports as Record<string, unknown> | undefined;
        if (mod && (mod as Record<string, unknown>).AssistantMessageComponent) {
          debugLog(`loadAssistantMessageModule found via direct scan ${key}`);
          return mod;
        }
      }
    }
  } catch {}
  return (
    loadPiModule("assistant-message.js", "modes/interactive/components/assistant-message.js") ||
    loadPiModule("assistant-message", "modes/interactive/components/assistant-message.js")
  );
}

export function loadThemeModule(): Record<string, unknown> | null {
  return (
    loadPiModule("theme/theme.js", "modes/interactive/theme/theme.js") ||
    loadPiModule("theme.js", "modes/interactive/theme/theme.js")
  );
}
