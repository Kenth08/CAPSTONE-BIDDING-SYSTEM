import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Scripts are split per page, but styles stay in one file. Page stylesheets
    // share class names and rely on the order they load in (see main.jsx), so
    // loading them page by page would change how the app looks.
    cssCodeSplit: false,
  },
  server: {
    port: 3000,
    strictPort: true, // fail loudly if 3000 is taken instead of silently using 3001 (keeps CORS valid)
  },
})
