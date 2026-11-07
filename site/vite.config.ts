import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { prerender, productMetadata } from "./prerender.ts";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: "./",
  plugins: [react(), tailwindcss(), productMetadata(), prerender(root)],
  build: {
    rolldownOptions: {
      input: {
        main: path.resolve(root, "index.html"),
        analytics: path.resolve(root, "analytics/index.html"),
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(root, "../src") },
  },
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4180,
    strictPort: true,
  },
});
