import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// In production the Memory Lane server serves `dist/` itself, so every request is same-origin.
// For `npm run dev`, pass API and media requests through to the server on its usual port.
const server = process.env.ML_SERVER || "http://localhost:8787";

export default defineConfig({
  server: {
    proxy: {
      "/api": server,
      "/media": server,
    },
  },
  build: {
    target: "es2020",
    rollupOptions: {
      // The family app, and the full-screen lane the phone app opens.
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        lane: fileURLToPath(new URL("lane.html", import.meta.url)),
      },
    },
  },
});
