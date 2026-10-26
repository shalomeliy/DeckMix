import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as {
  version: string
}

// v0.9.40 (26/10, Shalom): the version number alone did not tell him whether his copy was updated — most commits on main
// do not change package.json. The commit and its date do. A build outside git (a zip) says so on screen instead of guessing.
function buildId(): string {
  try {
    return execSync('git log -1 --format="%h %cd" --date=format:%d/%m', { encoding: 'utf8' }).trim().replace(/^"|"$/g, '')
  } catch {
    return 'build unknown'
  }
}

// The two headers below make the page "cross-origin isolated", which is what
// lets @huggingface/transformers' WASM backend actually use more than one
// CPU thread (it silently runs single-threaded without this — the .wasm file
// it loads is literally named ...-threaded.asyncify, but the thread pool
// needs `SharedArrayBuffer`, which browsers only expose in this mode). This
// is the real lever for v0.5.5 phase 2's CPU-only speed (09/09, after
// device:'wasm' replaced device:'auto' — see HANDOFF.md) — not a stronger
// GPU, which this project deliberately stopped using after it hung a real
// GPU driver. `credentialless`, not the stricter `require-corp`: the model
// download is a real cross-origin fetch (huggingface.co), and `require-corp`
// would block any such response that doesn't send back its own
// Cross-Origin-Resource-Policy header — not something this project
// controls. `credentialless` gets the same isolation without requiring that,
// at the cost of such a fetch going out without cookies (fine — a public
// model file needs none). Not verified end to end: this container's network
// policy blocks the model host either way (see HANDOFF.md), so whether Hugging
// Face's CDN plays nicely under this mode is Shalom's machine to confirm, not
// this session's.
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { headers: CROSS_ORIGIN_ISOLATION_HEADERS },
  preview: { headers: CROSS_ORIGIN_ISOLATION_HEADERS },
  resolve: {
    // Layer-addressed imports. A file's import path now says which layer it is
    // reaching into, instead of a count of ../ that changes when anything moves.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    // The client's only source for its own version number — read from
    // package.json at build time, never typed a second time. See
    // tests/repo/client-version.test.ts, which fails on a second hard-coded copy.
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(buildId()),
  },
})
