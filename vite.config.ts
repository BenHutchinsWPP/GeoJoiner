import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/GeoJoiner/",
  plugins: [react()],
  test: {
    environment: "happy-dom",
  },
});
