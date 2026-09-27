import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { createCodexToolboxServerFactory } from "../src/mcp-server-factory.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/client");
const { InMemoryTransport } = require("@modelcontextprotocol/server");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const pending = new Map();
let execCalls = 0;
const executor = {
  exec(input) {
    execCalls += 1;
    if (input.command[0] === "fail") {
      return Promise.reject(Object.assign(new Error("EXEC_FAILED"), { code: "EXEC_PROBE" }));
    }
    const gate = deferred();
    pending.set(input.command[0], gate);
    return gate.promise;
  },
};

const toolAllowlist = ["codex.command_exec", "codex.command_start", "codex.command_poll"];
const createServer = createCodexToolboxServerFactory({
  executor,
  maxConcurrent: 2,
  maxTimeoutMs: 30_000,
  maxAsyncTimeoutMs: 120_000,
  version: "async-command-test",
  exposeCwd: true,
  accessModes: ["inherit", "readOnly"],
  defaultAccess: "readOnly",
  surfaceVersion: "async-command-test-v1",
  toolAllowlist,
  publicPreview: true,
  guardDirectFormalCodex: true,
});

const server = createServer();
const client = new Client({ name: "async-command-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

try {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), toolAllowlist);
  const startTool = listed.tools.find((tool) => tool.name === "codex.command_start");
  assert.deepEqual(startTool.inputSchema.required.sort(), ["command", "timeoutMs"]);
  assert.equal(startTool.inputSchema.properties.timeoutMs.maximum, 120_000);
  const execTool = listed.tools.find((tool) => tool.name === "codex.command_exec");
  assert.equal(execTool.inputSchema.properties.timeoutMs.maximum, 30_000);
  const pollTool = listed.tools.find((tool) => tool.name === "codex.command_poll");
  assert.deepEqual(pollTool.inputSchema.required, ["commandRef"]);
  assert.equal(pollTool.annotations.readOnlyHint, true);
  assert.equal(pollTool.annotations.idempotentHint, true);

  const syncOverLimit = await client.callTool({
    name: "codex.command_exec",
    arguments: { command: ["must-not-dispatch"], access: "readOnly", timeoutMs: 30_001 },
  });
  assert.equal(syncOverLimit.isError, true, "server validation must enforce the synchronous 30s ceiling");
  assert.equal(execCalls, 0, "an over-limit synchronous request must fail before executor dispatch");

  const asyncMissingTimeout = await client.callTool({
    name: "codex.command_start",
    arguments: { command: ["must-not-dispatch"], access: "readOnly" },
  });
  assert.equal(asyncMissingTimeout.isError, true, "asynchronous execution must require an explicit finite timeout");
  assert.equal(execCalls, 0, "a start without timeout must fail before executor dispatch");

  const started = await client.callTool({
    name: "codex.command_start",
    arguments: { command: ["async-one"], cwd: "/tmp", access: "inherit", timeoutMs: 90_000 },
  });
  assert.notEqual(started.isError, true);
  assert.equal(started.structuredContent.status, "running");
  assert.match(started.structuredContent.commandRef, /^cmd_[0-9a-f-]{36}$/);
  const commandRef = started.structuredContent.commandRef;

  const running = await client.callTool({ name: "codex.command_poll", arguments: { commandRef } });
  assert.equal(running.structuredContent.status, "running");

  const syncPromise = client.callTool({
    name: "codex.command_exec",
    arguments: { command: ["sync-two"], cwd: "/tmp", access: "readOnly", timeoutMs: 20_000 },
  });
  await delay(0);
  const overflow = await client.callTool({
    name: "codex.command_start",
    arguments: { command: ["overflow"], cwd: "/tmp", access: "readOnly", timeoutMs: 90_000 },
  });
  assert.equal(overflow.isError, true);
  assert.match(overflow.structuredContent.error, /concurrency limit reached \(2\)/);

  pending.get("async-one").resolve({
    exitCode: 0,
    stdout: "ASYNC_OK",
    stderr: "",
    permissionProfile: "probe-profile",
    permissionCeiling: "probe-ceiling",
    effectiveCwd: "/tmp",
    authoritySource: "probe-authority",
    trustedAncestor: "/tmp",
  });
  await delay(0);
  const completed = await client.callTool({ name: "codex.command_poll", arguments: { commandRef } });
  assert.notEqual(completed.isError, true);
  assert.equal(completed.structuredContent.status, "completed");
  assert.equal(completed.structuredContent.stdout, "ASYNC_OK");
  assert.equal(completed.structuredContent.permissionProfile, "probe-profile");
  assert.equal(completed.structuredContent.access, "inherit");
  assert.equal(completed.structuredContent.cwd, "/tmp");
  assert.equal(completed.structuredContent.surfaceVersion, "async-command-test-v1");

  pending.get("sync-two").resolve({ exitCode: 0, stdout: "SYNC_OK", stderr: "" });
  const sync = await syncPromise;
  assert.equal(sync.structuredContent.stdout, "SYNC_OK");

  const nonzeroStart = await client.callTool({
    name: "codex.command_start",
    arguments: { command: ["nonzero"], access: "readOnly", timeoutMs: 90_000 },
  });
  await delay(0);
  pending.get("nonzero").resolve({ exitCode: 7, stdout: "COMMAND_FAILED", stderr: "expected" });
  await delay(0);
  const nonzero = await client.callTool({ name: "codex.command_poll", arguments: { commandRef: nonzeroStart.structuredContent.commandRef } });
  assert.equal(nonzero.structuredContent.status, "completed", "a subprocess nonzero exit is a completed command result, not an execution-layer failure");
  assert.equal(nonzero.structuredContent.exitCode, 7);

  const failedStart = await client.callTool({
    name: "codex.command_start",
    arguments: { command: ["fail"], access: "readOnly", timeoutMs: 90_000 },
  });
  await delay(0);
  const failed = await client.callTool({ name: "codex.command_poll", arguments: { commandRef: failedStart.structuredContent.commandRef } });
  assert.notEqual(failed.isError, true, "poll itself succeeds when retrieving an execution-layer failure");
  assert.equal(failed.structuredContent.status, "failed");
  assert.equal(failed.structuredContent.error, "EXEC_FAILED");
  assert.equal(failed.structuredContent.errorCode, "EXEC_PROBE");

  const beforeBlocked = execCalls;
  const blocked = await client.callTool({
    name: "codex.command_start",
    arguments: { command: ["codex", "--version"], access: "readOnly", timeoutMs: 90_000 },
  });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.errorCode, "FORMAL_CODEX_AGENT_REQUIRED");
  assert.equal(execCalls, beforeBlocked, "direct Codex guard must run before executor dispatch");

  const drainingStart = await client.callTool({
    name: "codex.command_start",
    arguments: { command: ["drain-me"], access: "readOnly", timeoutMs: 90_000 },
  });
  const draining = createServer.drainCommands();
  let drained = false;
  draining.then(() => { drained = true; });
  await delay(0);
  assert.equal(drained, false);
  const rejectedDuringDrain = await client.callTool({
    name: "codex.command_start",
    arguments: { command: ["too-late"], access: "readOnly", timeoutMs: 90_000 },
  });
  assert.equal(rejectedDuringDrain.isError, true);
  assert.match(rejectedDuringDrain.structuredContent.error, /draining/);
  pending.get("drain-me").resolve({ exitCode: 0, stdout: "DRAINED", stderr: "" });
  await draining;
  assert.equal(drained, true);
  const oldRefAfterDrain = await client.callTool({
    name: "codex.command_poll",
    arguments: { commandRef: drainingStart.structuredContent.commandRef },
  });
  assert.equal(oldRefAfterDrain.isError, true);
  assert.match(oldRefAfterDrain.structuredContent.error, /unknown or retired commandRef/);
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
}

console.log("async command surface tests passed");
