#!/usr/bin/env node

// `npm run vault:import-journal` — importa as dailies e as weekly reviews do journal do
// vault como execuções das Rotinas compiladas.
//
// Simula por padrão: mostra o relatório (dailies, weeklies, ignoradas com motivo) e não
// escreve nada. Com --confirm, grava recibo, ponteiro de saída e trace no runtime
// declarado pelo layout. É idempotente: o `receipt_id` e o `run_id` saem do caminho da
// nota, então reimportar não duplica.
//
// uso: node scripts/vault-import-journal.mjs [--root=<vault>] [--confirm] [--detalhe]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importVaultJournalRuns } from './lib/vault-journal-runs.mjs';

const KIND_LABELS = [
  ['daily', 'dailies', 'diária'],
  ['weekly-review', 'weeklies', 'semanal'],
];

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
    console.log('uso: node scripts/vault-import-journal.mjs [--root=<vault>] [--confirm] [--detalhe]');
    return 0;
  }
  const confirm = process.argv.includes('--confirm');
  const detail = process.argv.includes('--detalhe');
  const root = resolve(option('root') || process.env.CEREBRO_INSTALL_ROOT || process.cwd());

  let report;
  try {
    report = importVaultJournalRuns(root, { confirm });
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (report.mode === 'no-vault') {
    console.log('este Cérebro não declara vault no layout; nada a importar');
    return 0;
  }

  console.log(`journal lido em ${report.journal_ref}`);
  for (const [kindId, plural, cadence] of KIND_LABELS) {
    const routine = report.routines[kindId];
    if (routine) {
      console.log(`${plural} · ${routine.routine_id} ${routine.version} · ${report.per_kind[kindId]} execução(ões)`);
    } else {
      console.log(`${plural} · sem Rotina compilada com cadência ${cadence} e destino ${report.journal_ref} · ${report.missing_routine[kindId]} nota(s) fora do histórico`);
    }
  }
  for (const item of report.ambiguous) {
    console.log(`rotina ambígua · ${item.routine_id} · já existe outra Rotina ${item.kind} escrevendo em ${report.journal_ref}`);
  }
  for (const item of report.invalid_routines) {
    console.log(`contrato de rotina ilegível · ${item.ref} · ${item.reason_code}`);
  }

  // Motivos agrupados: 88 dailies não precisam de 88 linhas iguais, mas cada caso raro
  // precisa aparecer com o caminho.
  const byReason = new Map();
  for (const item of report.skipped) {
    const current = byReason.get(item.reason) || [];
    current.push(item.ref);
    byReason.set(item.reason, current);
  }
  for (const [reason, refs] of [...byReason].sort()) {
    if (refs.length <= 5 || detail) {
      for (const ref of refs) console.log(`ignorada · ${ref} · ${reason}`);
    } else {
      console.log(`ignoradas · ${refs.length} nota(s) · ${reason} (use --detalhe para listar)`);
    }
  }
  for (const refused of report.pii_refused) {
    console.log(`recusada por PII · ${refused.ref} · ${refused.matches.join(' · ')}`);
  }
  for (const invalid of report.invalid) {
    console.log(`recusada pelo validador · ${invalid.ref} · ${invalid.errors.join(' · ')}`);
  }
  if (report.refreshed) {
    console.log(`ponteiro atualizado · ${report.refreshed} nota(s) mudaram no vault desde a importação`);
  }

  const total = report.items.length;
  console.log(confirm
    ? `${total} execução(ões) · ${report.created} gravada(s) · ${report.already_imported} já no runtime`
    : `simulação: ${total} execução(ões) · ${report.created} a gravar · ${report.already_imported} já no runtime. Use --confirm para gravar.`);

  return report.pii_refused.length || report.invalid.length || report.ambiguous.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
