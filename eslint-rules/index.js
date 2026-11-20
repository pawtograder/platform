/**
 * Local ESLint plugin (`pii/*`), loaded by eslint.pii.config.mjs. See each rule for what it checks.
 */
"use strict";

module.exports = {
  meta: { name: "eslint-plugin-pawtograder-pii" },
  rules: {
    "pii-render": require("./pii-render")
  }
};
