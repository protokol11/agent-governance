# pi-ext-paste

F4 paste-screenshot: clipboard image -> tmp/paste placeholder -> attachment

Pi extension for Windows that wires screenshot pasting from the clipboard into
the pi coding agent prompt.

## Why

The author's environment is Windows Terminal, and there is an unfixed bug: you
cannot paste a screenshot from the clipboard to the agent directly, even though
pi itself accepts image attachments. This extension is the wire around that
bug.

Pressing F4 while the prompt editor is open does three things:

1. PowerShell reads the clipboard; if it holds an image, the image is saved to
   `tmp/paste/paste_<timestamp>_<rand>.png` under the current working
   directory.
2. A placeholder like `[paste_1735689600000_1234.png]` is appended to the
   prompt text.
3. On send, the `input` hook matches placeholders with
   `PASTE_PLACEHOLDER_REGEX`, reads each file as base64, attaches it as a real
   image to the message, and strips the placeholder text from the sent text.

Scope: clipboard images only (`.png` is produced; `.jpg`/`.jpeg`/`.webp` in
`tmp/paste` are also attachable). Non-scope: plain text or file-drop clipboard
content — F4 reports what it found instead of pasting. Old files in
`tmp/paste` are deleted after 60 minutes on each F4 press.

There are no tests; the extension is exercised by hand on the author's
machine.

## Prerequisites

- Windows with PowerShell (clipboard access uses
  `System.Windows.Forms.Clipboard` via `powershell -NoProfile`).
- Pi coding agent (`@earendil-works/pi-coding-agent`) installed and running.

## Install

Copy this directory into the pi extensions folder:

```powershell
Copy-Item -Recurse .\extras\paste ~\.pi\agent\extensions\paste
```

Expected result: `~/.pi/agent/extensions/paste/index.ts` and `paste.ts` exist.
Pi loads extensions from that folder on the next start; the status bar shows
`F4` next to the `paste` label when the extension is active.

## Usage

1. Take a screenshot so it sits on the clipboard (for example `Win+Shift+S`).
2. Press `F4` in the pi prompt. The editor gains a placeholder such as
   `[paste_1735689600000_1234.png]`; the file lands in `tmp/paste/` in the
   session working directory.
3. Send the message. The placeholder disappears from the text and the image
   arrives as an attachment the model can see.

If the clipboard holds no image, a warning notification names what was found
(`text`, `file_drop`, `empty`, …). If a placeholder file is missing at send
time, the send proceeds without that image and a warning lists the missing
file and the directory that was searched.

## Configuration

No configuration surface; `tmp/paste` and the 60-minute file TTL are
hardcoded in `index.ts` and `paste.ts`.

## Contributing

File issues in the `agent-governance` monorepo
(`repos/protokol11/agent-governance`). There is no test suite — see the note
in Why; changes are validated by the F4 flow above.

## License

[MIT](../../LICENSE)
