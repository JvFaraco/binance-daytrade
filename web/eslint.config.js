import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "tests/.fixtures", "shots"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.worker } },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // A cena three.js é imperativa por natureza: os buffers e uniforms dos objetos WebGL são
    // atualizados no lugar (a cada resultado do worker e a cada quadro), sem recriar geometria.
    // As regras do React Compiler tratam isso como mutação indevida; aqui é o comportamento desejado.
    files: ["src/sphere/SphereScene.tsx"],
    rules: { "react-hooks/immutability": "off", "react-hooks/preserve-manual-memoization": "off" },
  },
  { files: ["tests/**/*.ts", "vite.config.ts", "vitest.setup.ts", "tools/**/*.{js,ts,mjs}"], languageOptions: { globals: { ...globals.node } } },
);
