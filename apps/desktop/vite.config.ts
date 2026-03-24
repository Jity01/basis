import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  root: "ui",
  server: { port: 5173, host: "127.0.0.1" },
  build: {
    outDir: "../dist-renderer",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "ui"),
    },
  },
});
