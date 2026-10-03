#!/usr/bin/env node

// `npm run vault:import` — importa o histórico de sessões de IA do vault como Run
// Records v2 no ledger de runs.
//
// Simula por padrão: mostra o relatório (importadas por Sistema, sem classificação, sem
// fonte, verificadas) e não escreve nada. Com --confirm, grava no ledger declarado pelo
// layout. É idempotente: o `run_id` sai do caminho da nota, então reimportar não duplica.
//
// uso: node scripts/vault-import-history.mjs [--root=<vault>] [--confirm] [--detalhe]
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importVaultSessionHistory } from './lib/vault-history.mjs';

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
    console.log('uso: node scripts/vault-import-history.mjs [--root=<vault>] [--confirm] [--detalhe]');
    return 0;
  }
  const confirm = process.argv.includes('--confirm');
  const detail = process.argv.includes('--detalhe');
  const root = resolve(option('root') || process.env.CEREBRO_INSTALL_ROOT || process.cwd());

  let report;
  try {
    report = importVaultSessionHistory(root, { confirm });
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (report.mode === 'no-vault') {
    console.log('este Cérebro não declara vault no layout; nada a importar');
    return 0;
  }

  console.log(`sessões lidas em ${report.sessions_ref} · Log de agentes em ${report.daily_ref}`);
  const systems = Object.keys(report.per_system).sort();
  for (const systemId of systems) {
    console.log(`por sistema · ${systemId} · ${report.per_system[systemId]} sessão(ões)`);
  }
  if (!systems.length) console.log('por sistema · nenhuma sessão classificada');
  console.log(`sem classificação · ${report.free_sessions.length} sessão(ões) no balde sessao-livre (não importadas)`);
  for (const ref of report.free_sessions.slice(0, 5)) console.log(`sem classificação · exemplo · ${ref}`);
  for (const [reason, count] of Object.entries(report.reasons).sort((left, right) => right[1] - left[1]
    || left[0].localeCompare(right[0]))) {
    console.log(`motivo · ${reason} · ${count}`);
  }
  for (const correction of report.corrected) {
    console.log(`corrigida · ${correction.ref} · ${correction.from} → ${correction.to} · ${correction.reason}`);
  }
  for (const withdrawal of report.withdrawn) {
    console.log(`retirada · ${withdrawal.ref} · era run de ${withdrawal.from} e não tem mais classificação`);
  }
  for (const [systemId, count] of Object.entries(report.missing_contract).sort()) {
    console.log(`sem contrato · ${systemId} · ${count} sessão(ões) classificadas sem System Contract compilado`);
  }
  console.log(`sem fonte · ${report.with_gap} run(s) com lacuna declarada e fonte vault como evidência`);
  console.log(`verificadas · ${report.verified} run(s) com seção Verificação; ${report.records.length - report.verified} marcada(s) legacy-unverified`);
  for (const refused of report.pii_refused) {
    console.log(`recusada por PII · ${refused.ref} · ${refused.matches.join(' · ')}`);
  }
  for (const invalid of report.invalid) {
    console.log(`recusada pelo validador · ${invalid.ref} · ${invalid.errors.join(' · ')}`);
  }
  if (detail) {
    for (const ref of report.free_sessions) console.log(`sessao-livre · ${ref}`);
  }

  const total = report.records.length;
  const changes = `${report.corrected.length ? ` · ${report.corrected.length} corrigida(s)` : ''}${
    report.withdrawn.length ? ` · ${report.withdrawn.length} retirada(s)` : ''}${
    report.reemitted ? ` · ${report.reemitted} reemitida(s)` : ''}`;
  console.log(confirm
    ? `${total} run record(s) v2 · ${report.appended.length} novo(s)${changes} · ${report.already_imported} já no ledger${report.written_to ? ` · ${relative(root, report.written_to) || report.written_to}` : ''}`
    : `simulação: ${total} run record(s) v2 · ${report.appended.length} novo(s)${changes} · ${report.already_imported} já no ledger. Use --confirm para gravar.`);
  if (confirm && !report.changed) console.log('o bloco deste importador no ledger já estava em dia; nada reescrito');

  return report.pii_refused.length || report.invalid.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
