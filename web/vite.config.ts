import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Don't pick up PostCSS configs from parent folders; Tailwind v4 runs as a Vite plugin.
  css: { postcss: { plugins: [] } },
  build: {
    chunkSizeWarningLimit: 900,
  },
});
