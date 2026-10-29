// Standalone paste-screenshot extension (extracted from archived
// session-navigator). F4 saves the clipboard image and inserts a placeholder;
// the input hook swaps placeholders for real image attachments on send.
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PASTE_PLACEHOLDER_REGEX,
  extractPastePlaceholders,
  registerPasteShortcut,
} from "./paste.ts";

const TEMP_DIR = "tmp/paste";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    registerPasteShortcut(pi, ctx);
    if (ctx.hasUI) ctx.ui.setStatus("paste", "F4");
  });

  pi.on("input", async (_event, _ctx: ExtensionContext): Promise<InputEventResult> => {
    const event = _event as InputEvent;
    if (event.streamingBehavior) return { action: "continue" };
    const placeholders = extractPastePlaceholders(event.text);
    if (placeholders.length === 0) return { action: "continue" };

    const pasteDir = join(_ctx.cwd, TEMP_DIR);
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    const missing: string[] = [];
    for (const fileName of placeholders) {
      const filePath = join(pasteDir, fileName);
      try {
        const data = await readFile(filePath, { encoding: "base64" });
        const mimeType = fileName.endsWith(".png")
          ? "image/png"
          : fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")
            ? "image/jpeg"
            : "image/webp";
        images.push({ type: "image", data, mimeType });
      } catch (err) {
        missing.push(fileName);
        console.error(`[paste] failed to read paste file ${filePath}:`, err);
      }
    }

    if (missing.length > 0 && _ctx.hasUI) {
      _ctx.ui.notify(`Paste: could not attach ${missing.join(", ")} (tried ${pasteDir})`, "warning");
    }

    const newText = event.text.replace(PASTE_PLACEHOLDER_REGEX, "").trim() || " ";
    return { action: "transform", text: newText, images };
  });
}
