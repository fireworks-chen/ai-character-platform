import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Ant Design X's syntax highlighter imports this legacy language path
    // without an extension; Rolldown (Vite 8) needs the concrete ESM file.
    alias: {
      'highlight.js/lib/languages/sql_more': fileURLToPath(
        new URL('./node_modules/highlight.js/lib/languages/sql_more.js', import.meta.url),
      ),
    },
  },
  server: { port: 4173 },
})
