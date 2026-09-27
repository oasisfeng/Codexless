import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chatGptBundledCodexCandidates } from "../src/codex-bin.mjs";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-chatgpt-bundle-"));
try {
  const resourcesRoot = path.join(fixtureRoot, "Resources");
  const packageRoot = path.join(resourcesRoot, "codex-cli");
  const currentEntrypoint = path.join(packageRoot, "bin", "codex");
  const legacyEntrypoint = path.join(resourcesRoot, "codex");
  const manifestPath = path.join(packageRoot, "codex-package.json");
  await mkdir(path.dirname(currentEntrypoint), { recursive: true });

  let bundled = await chatGptBundledCodexCandidates({ resourcesRoot });
  assert.deepEqual(
    bundled.map(({ path: candidatePath, source }) => ({ path: candidatePath, source })),
    [
      { path: currentEntrypoint, source: "chatgpt-app-bundled" },
      { path: legacyEntrypoint, source: "chatgpt-app-bundled" },
    ],
    "known current and legacy layouts must remain available when no manifest exists"
  );

  await writeFile(manifestPath, `${JSON.stringify({ layoutVersion: 1, entrypoint: "bin/codex" }, null, 2)}\n`, "utf8");
  bundled = await chatGptBundledCodexCandidates({ resourcesRoot });
  assert.deepEqual(bundled, [
    {
      path: currentEntrypoint,
      source: "chatgpt-app-bundled-manifest",
      label: "ChatGPT.app:codex-package-entrypoint",
    },
    {
      path: legacyEntrypoint,
      source: "chatgpt-app-bundled",
      label: "ChatGPT.app:legacy-bundled-codex",
    },
  ], "manifest entrypoint should be authoritative without duplicating the known current layout");

  await writeFile(manifestPath, `${JSON.stringify({ layoutVersion: 2, entrypoint: "runtime/codex" }, null, 2)}\n`, "utf8");
  bundled = await chatGptBundledCodexCandidates({ resourcesRoot });
  assert.deepEqual(
    bundled.map(({ path: candidatePath, source }) => ({ path: candidatePath, source })),
    [
      { path: path.join(packageRoot, "runtime", "codex"), source: "chatgpt-app-bundled-manifest" },
      { path: currentEntrypoint, source: "chatgpt-app-bundled" },
      { path: legacyEntrypoint, source: "chatgpt-app-bundled" },
    ],
    "manifest discovery should follow entrypoint rather than hard-code one layoutVersion"
  );

  await writeFile(manifestPath, `${JSON.stringify({ entrypoint: "../outside/codex" }, null, 2)}\n`, "utf8");
  bundled = await chatGptBundledCodexCandidates({ resourcesRoot });
  assert.deepEqual(bundled.map((candidate) => candidate.path), [currentEntrypoint, legacyEntrypoint], "manifest entrypoint must not escape codex-cli package root");

  await writeFile(manifestPath, "{ malformed", "utf8");
  bundled = await chatGptBundledCodexCandidates({ resourcesRoot });
  assert.deepEqual(bundled.map((candidate) => candidate.path), [currentEntrypoint, legacyEntrypoint], "malformed manifest must fall back to known layouts");

  await unlink(manifestPath);
  bundled = await chatGptBundledCodexCandidates({ resourcesRoot });
  assert.deepEqual(bundled.map((candidate) => candidate.path), [currentEntrypoint, legacyEntrypoint]);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("ChatGPT bundled Codex discovery PASS");
