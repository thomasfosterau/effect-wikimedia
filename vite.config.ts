import { defineConfig } from "vite-plus";
import { packageTest } from "@thomasfosterau/test-config";

export default defineConfig({
  test: packageTest({
    thresholds: { statements: 91, branches: 77, functions: 85, lines: 97 },
    needsMocks: true,
  }),
});
