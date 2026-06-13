import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true, // fail loudly if 3000 is taken instead of silently using 3001 (keeps CORS valid)
  },
})
