import { execSync } from "child_process";
import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const rendererPort = Number(process.env.HERMES_DESKTOP_RENDERER_PORT || 0);

// Short hash of the commit being built (empty when git is unavailable, e.g.
// builds from an exported tree). Appended to the displayed version so local
// fork builds are distinguishable: "0.7.7 (520eaf2)".
function gitCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const commitHash = gitCommitHash();

export default defineConfig({
  main: {
    define: {
      __HERMES_COMMIT_HASH__: JSON.stringify(commitHash),
    },
    build: {
      rollupOptions: {
        external: ["better-sqlite3"],
      },
    },
  },
  preload: {
    define: {
      __HERMES_COMMIT_HASH__: JSON.stringify(commitHash),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          askpass: resolve("src/preload/askpass.ts"),
        },
      },
    },
  },
  renderer: {
    ...(rendererPort > 0
      ? {
          server: {
            port: rendererPort,
            strictPort: false,
          },
        }
      : {}),
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
      // Ensure a single Three.js instance across our code, @react-three/fiber,
      // drei and troika — multiple copies break `instanceof THREE.*` checks in
      // the ported office agent renderer.
      dedupe: ["three"],
    },
    plugins: [tailwindcss(), react()],
  },
});
