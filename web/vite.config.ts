import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Don't pick up PostCSS configs from parent folders; Tailwind v4 runs as a Vite plugin.
  css: { postcss: { plugins: [] } },
  // Local development talks to the deployed API (set VITE_API_PROXY to override).
  server: { proxy: { "/api": { target: process.env.VITE_API_PROXY || "https://halaqa-notes-c1ca.netlify.app", changeOrigin: true } } },
  build: {
    chunkSizeWarningLimit: 900,
  },
});
