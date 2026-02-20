import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3333,
    strictPort: false,
    open: false
  },
  preview: {
    port: 4444,
    strictPort: false,
    open: false
  }
})
