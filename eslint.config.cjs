const tseslint = require("typescript-eslint");

module.exports = tseslint.config(...tseslint.configs.recommended, {
  files: ["src/**/*.ts", "tests/**/*.ts"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", {
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    }],
  },
});
