const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/", "vendor/", "tests/ui-screenshots/"] },
  js.configs.recommended,
  {
    files: ["app.js", "solver.js", "hungarian.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...globals.node, XLSX: "readonly", RosterSolver: "readonly", Hungarian: "readonly" }
    }
  },
  {
    files: ["tests/**/*.js", "eslint.config.js"],
    // `document` etc. are referenced inside page.evaluate() callbacks, which run in the browser.
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node, ...globals.browser } }
  }
];
