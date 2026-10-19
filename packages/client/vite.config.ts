import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The existing assets/ tree at the repo root is served as-is rather than
// copied into packages/client/public. One copy, no sync step, and the C++
// build keeps working off the same files.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  publicDir: `${repoRoot}assets`,
  server: {
    // Vite refuses to serve files outside the project root by default, and
    // @fgp/shared lives one level up in the workspace.
    fs: { allow: [repoRoot] },
  },
  build: {
    target: "esnext", // top-level await, for the Jolt WASM init at M7
    sourcemap: true,
  },
});
