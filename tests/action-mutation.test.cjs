const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function harness() {
  let owner = "account-a";
  let mutation;
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/ui/action-mutation.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require(name) {
    if (name === "@tanstack/react-query") return { useMutation: options => { mutation = options; return options; } };
    if (name === "./feedback") return { useFeedback: () => ({ capture() { const expected = owner; return { isCurrent: () => owner === expected }; } }) };
    throw new Error(`Unexpected import: ${name}`);
  } });
  return { mount: exports.useActionMutation, mutation: () => mutation, switchAccount: () => { owner = "account-b"; } };
}

test("customer action callbacks retain the caller's original context and server result", async () => {
  const h = harness();
  const events = [];
  const original = { userId: "account-a" };
  h.mount({ onMutate: () => original, onSuccess: (...args) => events.push(args) });
  const variables = { listingId: "listing" };
  const runtime = { client: "query-client" };
  const context = await h.mutation().onMutate(variables, runtime);
  const result = { isFollowing: false };
  await h.mutation().onSuccess(result, variables, context, runtime);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], [result, variables, original, runtime]);
});

test("late success and error callbacks from another account cannot update the current UI", async () => {
  const h = harness();
  const events = [];
  h.mount({ onSuccess: () => events.push("success"), onError: () => events.push("error"), onSettled: () => events.push("settled") });
  const context = await h.mutation().onMutate(undefined, {});
  h.switchAccount();
  await h.mutation().onSuccess({}, undefined, context, {});
  await h.mutation().onError(new Error("network"), undefined, context, {});
  await h.mutation().onSettled({}, null, undefined, context, {});
  assert.deepEqual(events, []);
});

test("an ordinary failed action reaches its error handler without a success notification", async () => {
  const h = harness();
  const events = [];
  h.mount({ onSuccess: () => events.push("success"), onError: error => events.push(error.message) });
  const context = await h.mutation().onMutate(undefined, {});
  await h.mutation().onError(new Error("not saved"), undefined, context, {});
  assert.deepEqual(events, ["not saved"]);
});
