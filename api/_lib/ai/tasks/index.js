// Explicit allowlist of registered Duitful AI+ tasks.
// Any task name not listed here returns 400 ("unknown task") and uses no quota.

const TASKS = Object.freeze({
  "receipt-read": require("./receipt-read"),
  "statement-read": require("./statement-read"),
  "ea-read": require("./ea-read"),
  "loan-read": require("./loan-read"),
  "voice-entry": require("./voice-entry"),
  "split-match": require("./split-match"),
  "split-items": require("./split-items"),
  "payee-clean": require("./payee-clean"),
});

function getTask(name) {
  if (typeof name !== "string") return null;
  return Object.prototype.hasOwnProperty.call(TASKS, name) ? TASKS[name] : null;
}

module.exports = { TASKS, getTask };
