import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// base fixo: o painel é publicado em https://<usuário>.github.io/binance-daytrade/
export default defineConfig({
  base: "/binance-daytrade/",
  plugins: [react()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: false,
    // o pedaço da esfera (three.js + postprocessing) é carregado sob demanda, depois da primeira pintura
    chunkSizeWarningLimit: 1100,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./vitest.setup.ts"],
    testTimeout: 60000,
  },
});
