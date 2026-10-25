import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.API_URL ?? "http://localhost:3100";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // same-origin in development too: the browser talks to :5173 and Vite forwards API calls, exactly
    // like production where the API process serves this app. (Cookie sessions need no CORS either way.)
    proxy: {
      "/v1": { target: API, changeOrigin: false },
      "/u": { target: API, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    chunkSizeWarningLimit: 600,
  },
});
