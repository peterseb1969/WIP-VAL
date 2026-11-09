import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The app is served at the root of its own origin (https://wip-val.<host>/),
// so Vite keeps its default base '/'. Client code still prefixes every fetch
// with import.meta.env.BASE_URL, which is '/' here.
export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 lets Vite accept connections from outside the container
    // (wip-deploy --target dev with --app-source). Harmless on host.
    host: '0.0.0.0',
    // 5181: WIP-VAL's assigned Vite port (5173=wip-kb, 5174=react-console,
    // 5180=wip-aa). Express is on 3015.
    port: 5181,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3015',
      '/wip': 'http://localhost:3015',
    },
  },
})
