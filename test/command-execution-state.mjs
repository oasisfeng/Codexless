import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createCommandExecutionState } from "../src/command-execution-state.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

{
  const calls = [];
  const executor = {
    exec(input) {
      const gate = deferred();
      calls.push({ input, gate });
      return gate.promise;
    },
  };
  const state = createCommandExecutionState({ executor, maxConcurrent: 2, maxTerminalCommands: 10 });

  const synchronous = state.exec({ command: ["sync"], access: "readOnly", timeoutMs: 100 });
  const started = state.start({ command: ["async"], access: "inherit", timeoutMs: 200, cwd: "/project" });
  assert.match(started.commandRef, /^cmd_[0-9a-f-]{36}$/);
  const running = state.poll(started.commandRef);
  assert.equal(running.status, "running");
  assert.deepEqual(running.input.command, ["async"]);
  assert.throws(
    () => state.start({ command: ["overflow"], access: "readOnly", timeoutMs: 100 }),
    /concurrency limit reached \(2\)/
  );

  await delay(0);
  assert.equal(calls.length, 2);
  calls[1].gate.resolve({ exitCode: 0, stdout: "ASYNC_OK", stderr: "" });
  await delay(0);
  const completed = state.poll(started.commandRef);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.stdout, "ASYNC_OK");
  assert.deepEqual(completed.input, { access: "inherit", cwd: "/project" }, "terminal state must drop argv/timeout and retain only result-projection metadata");
  assert.equal(state.poll(started.commandRef).status, "completed", "poll must be repeatable and non-destructive");

  calls[0].gate.resolve({ exitCode: 0, stdout: "SYNC_OK", stderr: "" });
  assert.equal((await synchronous).stdout, "SYNC_OK");
  await state.drain();
  assert.throws(
    () => state.start({ command: ["after-drain"], access: "readOnly", timeoutMs: 100 }),
    /draining/
  );
}

{
  const gate = deferred();
  const executor = { exec: () => gate.promise };
  const state = createCommandExecutionState({ executor, maxConcurrent: 1, maxTerminalCommands: 10 });
  const started = state.start({ command: ["failing"], access: "readOnly", timeoutMs: 100 });
  gate.reject(Object.assign(new Error("FAIL_VISIBLE"), { code: "PROBE_FAILURE", nextActions: ["inspect"] }));
  await delay(0);
  const failed = state.poll(started.commandRef);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.error, "FAIL_VISIBLE");
  assert.equal(failed.error.errorCode, "PROBE_FAILURE");
  assert.deepEqual(failed.error.nextActions, ["inspect"]);
  assert.deepEqual(failed.input, { access: "readOnly" }, "failed terminal state must also drop argv/timeout");
  await state.drain();
}

{
  const gate = deferred();
  const executor = { exec: () => gate.promise };
  const state = createCommandExecutionState({ executor, maxConcurrent: 1, maxTerminalCommands: 10 });
  const started = state.start({ command: ["drain"], access: "readOnly", timeoutMs: 100 });
  const draining = state.drain();
  let drained = false;
  draining.then(() => { drained = true; });
  await delay(0);
  assert.equal(drained, false, "drain must wait for the active execution");
  assert.throws(
    () => state.start({ command: ["new"], access: "readOnly", timeoutMs: 100 }),
    /draining/
  );
  gate.resolve({ exitCode: 0, stdout: "DONE", stderr: "" });
  await draining;
  assert.equal(drained, true);
  assert.throws(() => state.poll(started.commandRef), /unknown or retired commandRef/);
}


{
  let sequence = 0;
  const executor = { exec: async () => ({ exitCode: 0, stdout: `R${++sequence}`, stderr: "" }) };
  const state = createCommandExecutionState({ executor, maxConcurrent: 1, maxTerminalCommands: 1 });
  const first = state.start({ command: ["first"], access: "readOnly", timeoutMs: 100 });
  await delay(0);
  const second = state.start({ command: ["second"], access: "readOnly", timeoutMs: 100 });
  await delay(0);
  assert.throws(() => state.poll(first.commandRef), /unknown or retired commandRef/, "terminal count cap must retire the oldest terminal job");
  assert.equal(state.poll(second.commandRef).status, "completed");
  await state.drain();
}

{
  const executor = { exec: async () => ({ exitCode: 0, stdout: "RETAINED", stderr: "" }) };
  const state = createCommandExecutionState({ executor, maxConcurrent: 1, maxTerminalCommands: 10, terminalTtlMs: 1 });
  const started = state.start({ command: ["retained"], access: "readOnly", timeoutMs: 100 });
  await delay(0);
  assert.equal(state.poll(started.commandRef).status, "completed");
  await delay(30);
  assert.equal(state.poll(started.commandRef).status, "completed", "legacy terminalTtlMs input must not reintroduce wall-clock expiry");
  await state.drain();
}


console.log("command execution state tests passed");
