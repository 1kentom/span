import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig(({ mode }) => ({
  plugins: [solid({ hot: mode !== "test" })],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022" },
}));
