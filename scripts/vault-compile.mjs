#!/usr/bin/env node

// `npm run vault:sync` — compila as notas tipadas do vault em contratos do protocolo.
//
// Simula por padrão: mostra o que cada nota viraria e não escreve nada. Com --confirm,
// grava os contratos no caminho declarado pelo layout, cria `.cerebro/runtime/` se
// faltar e atualiza `.cerebro/compiled.json`, removendo só os órfãos que ele mesmo
// gerou.
//
// uso: node scripts/vault-compile.mjs [--root=<vault>] [--confirm]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileVaultContracts } from './lib/vault-contracts.mjs';

function option(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : '';
  return next && !next.startsWith('--') ? next : '';
}

function main() {
  if (process.argv.includes('--help')) {
    console.log('uso: node scripts/vault-compile.mjs [--root=<vault>] [--confirm]');
    return 0;
  }
  const confirm = process.argv.includes('--confirm');
  const root = resolve(option('root') || process.env.CEREBRO_INSTALL_ROOT || process.cwd());

  let result;
  try {
    result = compileVaultContracts(root, { confirm });
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  for (const note of result.notes) {
    if (note.status === 'ok') {
      const state = confirm
        ? (note.changed ? 'gravado' : 'sem mudança')
        : (note.changed ? 'gravaria' : 'sem mudança');
      console.log(`ok · ${note.path} · ${note.label} ${note.id} → ${note.contract_ref} (${state})`);
      continue;
    }
    for (const error of note.errors) console.log(`${note.path} · ${error.field} · ${error.reason}`);
  }

  for (const path of result.removed) {
    console.log(`${confirm ? 'removido' : 'removeria'} · ${path} · nota de origem não existe mais`);
  }

  const ok = result.notes.filter((note) => note.status === 'ok').length;
  if (!result.notes.length) console.log('nenhuma nota compilável encontrada neste vault');
  const changes = result.written.length || result.removed.length || result.registry_changed;
  console.log(confirm
    ? `${ok} contrato(s) válido(s) · ${result.errors} nota(s) com erro · ${result.written.length} arquivo(s) gravado(s) · ${result.removed.length} órfão(s) removido(s)`
    : `simulação: ${ok} contrato(s) válido(s) · ${result.errors} nota(s) com erro · ${changes ? 'há mudança a gravar' : 'nada a gravar'}. Use --confirm para gravar.`);

  return result.errors ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
