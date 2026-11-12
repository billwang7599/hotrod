import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { frameLibraries } from './frame-libraries.ts'

export default defineConfig({
  plugins: [react(), tailwindcss(), frameLibraries()],
  server: { port: Number(process.env.KOTHAR_UI_PORT ?? process.env.HOTROD_UI_PORT ?? 4318), strictPort: true },
})
