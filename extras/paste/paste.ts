// F4 → save clipboard image to <cwd>/tmp/paste/paste_<ts>_<rand>.png and insert
// a [paste_....png] placeholder into the editor; on send, the placeholder is
// replaced by the actual image attachment. Extracted from the archived
// session-navigator extension (paste.ts/index.ts) as a standalone extension.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface PasteResult {
  attached: boolean;
  filePath?: string;
  placeholder?: string;
  reason?: string;
}

export interface PasteDependencies {
  execFile: typeof execFile;
  mkdir: typeof mkdir;
  readdir: typeof readdir;
  stat: typeof stat;
  unlink: typeof unlink;
  join: typeof join;
}

export const PASTE_PLACEHOLDER_REGEX = /\[(paste_\d+_\d+\.png)\]/g;

export function makePastePlaceholder(fileName: string): string {
  return `[${fileName}]`;
}

export function extractPastePlaceholders(text: string): string[] {
  return [...text.matchAll(PASTE_PLACEHOLDER_REGEX)].map((m) => m[1]);
}

const DEFAULT_DEPS: PasteDependencies = { execFile, mkdir, readdir, stat, unlink, join };

function powershellImageScript(outPath: string): string {
  return (
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$img = [System.Windows.Forms.Clipboard]::GetImage(); ` +
    `if ($img -eq $null) { Write-Output 'NO_IMAGE'; exit 1 }; ` +
    `$img.Save('${outPath.replace(/'/g, "''")}'); ` +
    `Write-Output 'OK'`
  );
}

function powershellDetectScript(): string {
  return (
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$data = [System.Windows.Forms.Clipboard]::GetDataObject(); ` +
    `if ($data -eq $null) { Write-Output 'empty'; exit 0 }; ` +
    `$formats = $data.GetFormats(); ` +
    `if ($formats -contains 'Bitmap') { Write-Output 'image'; exit 0 }; ` +
    `if ($formats -contains 'Text') { Write-Output 'text'; exit 0 }; ` +
    `if ($formats -contains 'FileDrop') { Write-Output 'file_drop'; exit 0 }; ` +
    `Write-Output ($formats -join ','); exit 0`
  );
}

function runPowershell(
  script: string,
  deps: Pick<PasteDependencies, "execFile">,
  timeoutMs = 15000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = deps.execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error && !stdout && !stderr) {
          reject(error);
          return;
        }
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code: error?.code ? (typeof error.code === "number" ? error.code : 1) : 0,
        });
      },
    );
    child.on("error", reject);
  });
}

async function detectClipboardType(deps: Pick<PasteDependencies, "execFile">): Promise<string> {
  try {
    const result = await runPowershell(powershellDetectScript(), deps, 5000);
    const type = result.stdout.trim();
    return type || "unknown";
  } catch {
    return "unknown";
  }
}

async function cleanupOldFiles(
  tempDir: string,
  ttlMinutes: number,
  deps: Pick<PasteDependencies, "readdir" | "stat" | "unlink" | "join">,
): Promise<void> {
  const now = Date.now();
  const maxAge = ttlMinutes * 60 * 1000;
  try {
    const entries = await deps.readdir(tempDir);
    for (const entry of entries) {
      if (entry === ".gitkeep") continue;
      const fullPath = deps.join(tempDir, entry);
      try {
        const s = await deps.stat(fullPath);
        if (s.isFile() && now - s.mtime.getTime() > maxAge) {
          await deps.unlink(fullPath);
        }
      } catch {
        // ignore per-file errors
      }
    }
  } catch {
    // ignore directory read errors
  }
}

function generateFileName(): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 10000);
  return `paste_${ts}_${rand}.png`;
}

function dirOf(p: string): string {
  const sep = p.includes("/") ? "/" : "\\";
  const idx = p.lastIndexOf(sep);
  return idx >= 0 ? p.slice(0, idx) : ".";
}

async function saveClipboardImage(
  outPath: string,
  deps: Pick<PasteDependencies, "execFile" | "mkdir">,
): Promise<{ saved: boolean; reason?: string }> {
  try {
    await deps.mkdir(dirOf(outPath), { recursive: true });
    const result = await runPowershell(powershellImageScript(outPath), deps, 15000);
    if (result.stdout === "NO_IMAGE" || result.code !== 0) {
      return { saved: false, reason: result.stdout || result.stderr || "Clipboard image save failed" };
    }
    return { saved: true };
  } catch (err) {
    return { saved: false, reason: `PowerShell error: ${String(err)}` };
  }
}

export async function pasteClipboardImage(
  ctx: ExtensionContext,
  tempDirRelative: string,
  ttlMinutes: number,
  deps: PasteDependencies = DEFAULT_DEPS,
): Promise<PasteResult> {
  const tempDir = deps.join(ctx.cwd, tempDirRelative);
  await cleanupOldFiles(tempDir, ttlMinutes, deps);

  const clipType = await detectClipboardType(deps);
  if (clipType !== "image") {
    return { attached: false, reason: `Clipboard contains no image (detected: ${clipType}).` };
  }

  const fileName = generateFileName();
  const outPath = deps.join(tempDir, fileName);
  const saveResult = await saveClipboardImage(outPath, deps);
  if (!saveResult.saved) {
    return { attached: false, reason: saveResult.reason };
  }

  return { attached: false, filePath: outPath, placeholder: makePastePlaceholder(fileName) };
}

interface ShortcutAPI {
  registerShortcut: (shortcut: string, options: { description: string; handler: () => unknown }) => void;
}

/** Register the F4 hotkey: clipboard image -> tmp/paste file + [placeholder]. */
export function registerPasteShortcut(
  pi: ShortcutAPI,
  ctx: ExtensionContext,
  deps: PasteDependencies = DEFAULT_DEPS,
): void {
  pi.registerShortcut("f4", {
    description: "Paste clipboard image as a placeholder",
    handler: async () => {
      const result = await pasteClipboardImage(ctx, "tmp/paste", 60, deps);
      if (result.placeholder && ctx.hasUI) {
        const current = ctx.ui.getEditorText();
        const sep = current && !current.endsWith(" ") ? " " : "";
        ctx.ui.setEditorText(current + sep + result.placeholder);
      } else if (result.reason && ctx.hasUI) {
        ctx.ui.notify(result.reason, "warning");
      }
    },
  });
}
