// Run: node --test test/propose.test.mjs
// The proposal writer is the only writer: it lands under .scratch/ and nothing else.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { writeProposal } from "../propose.ts";

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "frontmatter block is present");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(": ");
    fields[key] = rest.join(": ");
  }
  return fields;
}

test("writeProposal lands in .scratch/rule-lifecycle with parseable frontmatter", () => {
  const root = mkdtempSync(join(tmpdir(), "rule-lifecycle-"));
  try {
    const path = writeProposal(
      {
        kind: "promotion",
        rule_id: "CP-50",
        provenance: ["j1", "j2"],
        replay: { accuracy: 0.75, n: 4, mismatches: ["j9"] },
      },
      { root }
    );
    assert.equal(
      relative(root, path).replaceAll("\\", "/"),
      ".scratch/rule-lifecycle/promotion-CP-50.md"
    );
    const markdown = readFileSync(path, "utf8");
    const fields = parseFrontmatter(markdown);
    assert.equal(fields.kind, "promotion");
    assert.equal(fields.rule_id, '"CP-50"');
    assert.equal(fields.provenance, '["j1", "j2"]');
    assert.equal(fields.replay, "{heldOutAccuracy: 0.75, n: 4}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeProposal never writes outside .scratch/rule-lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "rule-lifecycle-"));
  try {
    const path = writeProposal(
      { kind: "demotion", rule_id: "../../escaped", provenance: ["j1"], replay: null },
      { root }
    );
    assert.ok(path.startsWith(join(root, ".scratch", "rule-lifecycle")), "path stays under .scratch");
    assert.ok(!existsSync(join(root, "escaped.md")), "no file is written at the traversal target");
    assert.deepEqual(
      readdirSync(join(root, ".scratch", "rule-lifecycle")).filter((f) => !f.endsWith(".md")),
      [],
      "only markdown proposals"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeProposal renders replay: null when there is no report", () => {
  const root = mkdtempSync(join(tmpdir(), "rule-lifecycle-"));
  try {
    const path = writeProposal(
      { kind: "candidate", rule_id: "CP-13", provenance: [], replay: null },
      { root }
    );
    assert.match(readFileSync(path, "utf8"), /replay: null/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
