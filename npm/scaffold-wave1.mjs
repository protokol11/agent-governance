// Scaffold package.json for npm wave 1 packages (one-off, run from npm/).
import { writeFileSync } from "node:fs";

const pkgs = {
  "pi-session-transfer": {
    desc: "Lossy context compaction replaced with a typed handoff document and session rotation for pi agents.",
    keywords: ["session-transfer", "handoff", "context-window"],
    entry: "./extensions/index.ts",
  },
  "pi-session-manager": {
    desc: "Verb-led kebab-slug session names plus a Windows-Explorer-style browser over the pi session store.",
    keywords: ["session-manager", "session-browser"],
    entry: "./extensions/index.ts",
  },
  "pi-memory-gov": {
    desc: "Memory capture and recall for pi agents, where trust comes from calibrated judgments, not model self-assessment.",
    keywords: ["memory-gov", "memory", "calibration"],
    entry: "./extensions/index.ts",
  },
  "pi-todo-state": {
    desc: "Append-only, concurrency-safe todo board for pi sessions: event log plus deterministic fold.",
    keywords: ["todo-state", "todo", "event-log"],
    entry: "./extensions/index.ts",
  },
};

for (const [name, p] of Object.entries(pkgs)) {
  const pkg = {
    name: `@protokol11/${name}`,
    version: "0.1.0",
    description: p.desc,
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/protokol11/agent-governance.git",
      directory: `npm/${name}`,
    },
    type: "module",
    keywords: ["pi-package", "pi", "pi-extension", "agent-governance", ...p.keywords],
    pi: { extensions: [p.entry] },
    files: ["extensions", "README.md", "LICENSE"],
    scripts: { test: "node --test extensions/test/*.test.mjs" },
    peerDependencies: { "@earendil-works/pi-coding-agent": "*", typebox: "*" },
    devDependencies: { "@types/node": "^26.4.1", tsx: "^4.19.0", typescript: "^7.0.2" },
  };
  writeFileSync(`${name}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${name} ok`);
}
