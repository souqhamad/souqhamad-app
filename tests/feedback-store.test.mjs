import assert from "node:assert/strict";
import test from "node:test";
import { createFeedbackStore } from "../src/ui/feedback-store.ts";

test("one visible message, bounded pending feedback and duplicate suppression", () => {
  const store = createFeedbackStore();
  store.enqueue("success", "saved");
  const first = store.getSnapshot().message;
  store.enqueue("success", "saved");
  for (const message of ["a", "b", "c", "d"]) store.enqueue("info", message);
  store.dismiss(first.id);
  assert.equal(store.getSnapshot().message.message, "b");
  store.dismiss(first.id); // A timer from a previous message cannot hide this one.
  assert.equal(store.getSnapshot().message.message, "b");
  for (const message of ["c", "d", null]) {
    store.dismiss(store.getSnapshot().message.id);
    assert.equal(store.getSnapshot().message?.message ?? null, message);
  }
});

test("errors immediately replace routine feedback and stale timers cannot dismiss them", () => {
  const store = createFeedbackStore();
  store.enqueue("success", "saved");
  const old = store.getSnapshot().message.id;
  store.enqueue("info", "queued");
  store.enqueue("error", "failed");
  store.dismiss(old);
  assert.equal(store.getSnapshot().message.message, "failed");
  store.dismiss(store.getSnapshot().message.id);
  assert.equal(store.getSnapshot().message, null);
});

test("an identity change clears dialogs, messages, queues and late account completions", () => {
  const store = createFeedbackStore();
  store.setIdentity("account-a", false);
  const oldScope = store.scope();
  let calls = 0;
  store.enqueue("success", "saved");
  store.enqueue("success", "queued");
  store.openDialog("delete", "confirm", [{ onPress: () => calls++ }]);
  const dialog = store.getSnapshot().dialog;
  store.setIdentity("account-b", false);
  store.enqueue("success", "late", oldScope);
  store.closeDialog(dialog.id, dialog.buttons[0]);
  assert.equal(store.isCurrent(oldScope), false);
  assert.equal(store.getSnapshot().message, null);
  assert.equal(store.getSnapshot().dialog, null);
  assert.equal(calls, 0);
});

test("confirm and cancel callbacks run at most once and preserve the selected action", () => {
  const store = createFeedbackStore();
  const actions = [];
  const cancel = { text: "cancel", style: "cancel", onPress: () => actions.push("cancel") };
  const confirm = { text: "delete", style: "destructive", onPress: () => actions.push("delete") };
  store.openDialog("delete", "confirm", [cancel, confirm]);
  const id = store.getSnapshot().dialog.id;
  store.closeDialog(id, cancel);
  store.closeDialog(id, confirm);
  assert.deepEqual(actions, ["cancel"]);
  store.openDialog("delete", "confirm", [cancel, confirm]);
  store.closeDialog(store.getSnapshot().dialog.id, confirm);
  assert.deepEqual(actions, ["cancel", "delete"]);
});

test("modal feedback has one owner and returns to the active screen after dismissal", () => {
  const store = createFeedbackStore();
  const modal = store.registerHost(2);
  const screen = store.registerHost(1); // Parent effects may register after modal effects.
  assert.equal(store.getSnapshot().host, modal.id);
  store.enqueue("error", "upload failed");
  modal.remove();
  assert.equal(store.getSnapshot().host, screen.id);
  assert.equal(store.getSnapshot().message.message, "upload failed");
  screen.remove();
  assert.equal(store.getSnapshot().host, null);
});

test("explicit logout result crosses only the expected transition to a guest", () => {
  const store = createFeedbackStore();
  store.setIdentity("account-a", false);
  store.expectSignOut("signed out");
  store.setIdentity("guest", true);
  assert.equal(store.getSnapshot().message.message, "signed out");
  store.setIdentity("account-a", false);
  store.expectSignOut("deleted");
  store.setIdentity("account-b", false);
  assert.equal(store.getSnapshot().message, null);
  store.setIdentity("guest", true);
  assert.equal(store.getSnapshot().message, null);
});
