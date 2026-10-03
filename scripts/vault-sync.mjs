#!/usr/bin/env node

// `npm run vault:sync` — compila as notas tipadas do vault em contratos e, em seguida,
// importa o histórico de sessões como Run Records v2.
//
// É só o encadeamento das duas CLIs, com os mesmos argumentos: o compilador continua em
// `vault-compile.mjs` e o importador em `vault-import-history.mjs`. Se o compilador sair
// com erro, o importador ainda roda: Sistema com nota quebrada simplesmente não tem
// contrato, e o relatório do importador diz quantas sessões ficaram sem contrato.
//
// uso: node scripts/vault-sync.mjs [--root=<vault>] [--confirm]
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const STEPS = [
  ['contratos', 'vault-compile.mjs'],
  ['histórico', 'vault-import-history.mjs'],
];

function main() {
  if (process.argv.includes('--help')) {
    console.log('uso: node scripts/vault-sync.mjs [--root=<vault>] [--confirm]');
    return 0;
  }
  const flags = process.argv.slice(2);
  let status = 0;
  for (const [label, script] of STEPS) {
    console.log(`— ${label}`);
    const run = spawnSync(process.execPath, [resolve(here, script), ...flags], { stdio: 'inherit' });
    if (run.status !== 0) status = 1;
  }
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
