import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Configuración de Vite: plugin de React y proxy de la API al backend en :8000
// para evitar problemas de CORS durante el desarrollo.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Todas las llamadas a /api/* se redirigen al backend, quitando el prefijo.
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
