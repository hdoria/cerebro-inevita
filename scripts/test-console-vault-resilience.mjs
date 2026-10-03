#!/usr/bin/env node

// Console resiliente em modo vault, testado pelo seam HTTP contra um Cérebro sintético:
// arquivo inválido vira issue na tela Saúde em vez de derrubar a API, e um vault
// declarado no layout conta como ativado. Instalação INEVITA sem vault segue igual.
import assert from 'node:assert/strict';
import { graphForLayout } from './lib/graph-read-model.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';

const vaultRoot = mkdtempSync(join(tmpdir(), 'console-vault-resilience-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'console-inevita-resilience-'));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function example(name) {
  return JSON.parse(readFileSync(new URL(`../protocol/examples/${name}`, import.meta.url), 'utf8'));
}

async function readConsole(root, path = '/api/console') {
  const instance = createConsoleServer({
    root,
    sessionToken: 'fixed-session-token',
    csrfToken: 'fixed-csrf-token',
    clock: () => new Date('2026-10-01T12:00:00.000Z'),
  });
  await new Promise((listening) => instance.server.listen(0, '127.0.0.1', listening));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    await page.text();
    const cookie = page.headers.get('set-cookie').split(';', 1)[0];
    const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
    const contentType = response.headers.get('content-type') || '';
    return {
      status: response.status,
      value: contentType.includes('application/json') ? await response.json() : await response.text(),
    };
  } finally {
    await new Promise((closed) => instance.server.close(closed));
  }
}

try {
  // Cérebro em modo vault: marcador legado + layout com a chave `vault`.
  write(join(vaultRoot, 'AGENTS.md'), '# Vault sintético\n');
  write(join(vaultRoot, '.git', 'info', 'exclude'), '# local excludes\n');
  assert.equal(bootstrapLegacyConsole(vaultRoot, { confirm: true }).status, 'created');
  const layoutPath = join(vaultRoot, '.cerebro', 'layout.json');
  write(layoutPath, {
    ...JSON.parse(readFileSync(layoutPath, 'utf8')),
    vault: { focus: ['hot.md'], daily: 'journal', inbox: 'inbox', projects: 'projects', areas: 'areas' },
  });
  write(join(vaultRoot, 'hot.md'), '# Hot\n\n- Fechar o ticket\n');

  // Um contrato, um recibo e um experimento válidos ao lado de arquivos corrompidos.
  const contract = example('routine-contract.v1.json');
  const receipt = example('routine-run-receipt.v1.json');
  write(join(vaultRoot, '.cerebro', 'contracts', 'routines', `${contract.routine_id}.json`), contract);
  write(join(vaultRoot, '.cerebro', 'contracts', 'routines', 'quebrado.json'), '{quebrado');
  write(join(vaultRoot, '.cerebro', 'runtime', 'receipts', 'routines', `${receipt.receipt_id}.json`), receipt);
  write(join(vaultRoot, '.cerebro', 'runtime', 'receipts', 'routines', 'quebrado.json'), '{quebrado');
  write(join(vaultRoot, '.cerebro', 'contracts', 'experiments', 'quebrado.json'), '{quebrado');
  // Rotina válida cuja migração está ilegível: o motivo precisa apontar o artefato que
  // caiu, não o estado da rotina, que está inteiro.
  const migrated = { ...contract, routine_id: 'rotina-com-migracao-quebrada' };
  write(join(vaultRoot, '.cerebro', 'contracts', 'routines', `${migrated.routine_id}.json`), migrated);
  write(join(vaultRoot, '.cerebro', 'runtime', 'migrations', 'routines', `${migrated.routine_id}.json`), '{quebrado');

  const vaultConsole = await readConsole(vaultRoot);
  assert.equal(vaultConsole.status, 200, 'arquivo inválido não pode derrubar /api/console');
  const reasons = vaultConsole.value.issues.map((issue) => issue.reason_code);
  assert(reasons.includes('routine-receipt-invalid'), 'recibo inválido vira issue em Saúde');
  assert(reasons.includes('routine-contract-invalid'), 'contrato inválido vira issue em Saúde');
  assert(reasons.includes('experiment-contract-invalid'), 'experimento inválido vira issue em Saúde');
  for (const reason of ['routine-receipt-invalid', 'routine-contract-invalid', 'experiment-contract-invalid']) {
    const issue = vaultConsole.value.issues.find((item) => item.reason_code === reason);
    assert(issue.ref.includes('quebrado'), `${reason} aponta o arquivo culpado: ${issue.ref}`);
  }
  assert.equal(reasons.filter((reason) => reason === 'routine-receipt-invalid').length, 1,
    'o mesmo arquivo ruim não se repete na lista de issues');

  // O motivo nomeia o artefato culpado: migração ilegível não se disfarça de estado inválido.
  const migrationIssue = vaultConsole.value.issues.find((item) => item.reason_code === 'routine-migration-invalid');
  assert.ok(migrationIssue, `migração ilegível vira issue própria: ${JSON.stringify(reasons)}`);
  assert.equal(migrationIssue.ref, '.cerebro/runtime/migrations/routines/rotina-com-migracao-quebrada.json',
    'a issue aponta o arquivo que não abriu');
  assert.equal(reasons.includes('routine-state-invalid'), false,
    'o estado da rotina está inteiro e não pode ser acusado no lugar da migração');

  // A falha é isolada por arquivo: o que é válido continua sendo dado.
  assert.deepEqual(vaultConsole.value.routines.map((routine) => routine.routine_id), [contract.routine_id],
    'o contrato válido sobrevive ao arquivo corrompido vizinho');
  assert.deepEqual(vaultConsole.value.routines[0].receipts.map((item) => item.receipt_id), [receipt.receipt_id],
    'o recibo válido sobrevive ao arquivo corrompido vizinho');
  assert.deepEqual(vaultConsole.value.judgments.map((item) => item.receipt_id), [receipt.receipt_id],
    'a caixa de julgamentos lê os recibos válidos');

  // Vault declarado conta como ativado, sem recibo de primeira missão inventado.
  assert.equal(vaultConsole.value.activation.complete, true, 'vault declarado abre no Hoje');
  assert.equal(vaultConsole.value.activation.reason_code, 'vault-declared');
  assert.equal(vaultConsole.value.activation.run_id, null, 'nenhuma ativação falsa foi gravada');
  assert.equal(vaultConsole.value.activation.receipt_ref, null);

  const anatomy = await readConsole(vaultRoot, '/api/anatomy');
  assert.equal(anatomy.status, 200, 'arquivo inválido não pode derrubar /api/anatomy');
  assert.equal(anatomy.value.activation.complete, true);

  // Execuções e Canvas da execução válida também sobrevivem ao recibo quebrado.
  const runs = await readConsole(vaultRoot, '/api/runs');
  assert.equal(runs.status, 200, 'arquivo inválido não pode derrubar /api/runs');
  assert.ok(runs.value.runs.some((item) => item.run_id === receipt.run_id), 'a execução válida continua listada em Runs');
  assert.ok(runs.value.issues.some((issue) => issue.reason_code === 'routine-receipt-invalid' && issue.ref.endsWith('quebrado.json')),
    'Runs aponta o recibo ilegível pelo arquivo, sem esconder os bons');
  // A busca da execução para o Canvas não pode quebrar pelo recibo ilegível: ela acha
  // a execução válida e só para adiante, porque esta fixture não tem contrato de Sistema.
  assert.throws(() => graphForLayout(vaultRoot, `run-${receipt.run_id}`), /graph-system-not-found/,
    'o recibo ilegível não impede achar a execução válida para o Canvas');

  // Instalação INEVITA sem vault: a Primeira Missão continua valendo.
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3 });
  const inevitaConsole = await readConsole(inevitaRoot);
  assert.equal(inevitaConsole.status, 200);
  assert.equal(inevitaConsole.value.activation.complete, false, 'sem vault, a ativação depende da primeira missão');
  assert.equal(inevitaConsole.value.activation.status, 'not-started');
  assert.equal(inevitaConsole.value.activation.reason_code, null);

  console.log('✓ console isola arquivo inválido em Saúde e abre no Hoje quando o vault está declarado');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
