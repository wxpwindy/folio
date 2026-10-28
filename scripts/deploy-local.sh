#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v node >/dev/null || { printf '%s\n' 'Node.js 24+ is required.' >&2; exit 1; }
command -v npm >/dev/null || { printf '%s\n' 'npm is required.' >&2; exit 1; }
node --input-type=module -e '
import { createServer } from "node:net";
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("Node.js 24+ is required.");
  process.exit(1);
}
const probe = createServer();
probe.once("error", error => {
  console.error(`Cannot start Folio on 127.0.0.1:3001 (${error.code}). Stop any existing Folio development or production server first.`);
  process.exitCode = 1;
});
probe.listen(3001, "127.0.0.1", () => probe.close());
'

npm install --include=dev
npm run ci:local -- --deploy
printf '%s\n' 'Starting Folio at http://127.0.0.1:3001 (Ctrl+C to stop).'
exec npm start