#!/usr/bin/env node

// Seam único do ticket 09: vault sintético (uma Área, duas Fontes, um Sistema, duas
// Rotinas) → `vault:sync` (CLI) → API HTTP do Console. Verifica comportamento externo: o
// que a CLI imprime, o que fica gravado e o que o Console devolve para Julgamento ›
// Rotinas e para Confiança › Governança.
//
// Cobre: Routine Contract, Access Grant e executor binding válidos pelos validadores do
// protocolo; a rotina aparece em Rotinas com agenda e sistema; a governança mostra os
// grants e as fontes declaradas; nota inválida sai como `<nota> · <campo> · <motivo>`;
// recompilar não muda nada; instalação INEVITA sem vault continua igual.
//
// Nada aqui executa modelo: a rotina é declaração, e o Console só lê o que foi declarado.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';
import { validateAccessGrant } from './lib/system-protocol.mjs';
import { validateExecutorBinding, validateRoutineContract } from './lib/routine-protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'vault-compile.mjs');
const ROUTINES = join('.cerebro', 'contracts', 'routines');
const GRANTS = join('.cerebro', 'contracts', 'access-grants');
const EXECUTORS = join('.cerebro', 'runtime', 'executors');
const vaultRoot = mkdtempSync(join(tmpdir(), 'vault-routines-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'vault-routines-inevita-'));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function sync(root, ...flags) {
  const run = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...flags], { encoding: 'utf8' });
  assert.equal(run.stderr, '', `vault-compile não deve falhar em stderr: ${run.stderr}`);
  return { out: run.stdout, code: run.status, lines: run.stdout.split('\n').filter(Boolean) };
}

function dir(root, relative) {
  const path = join(root, relative);
  return existsSync(path) ? readdirSync(path).sort() : [];
}

function json(root, ...parts) {
  return JSON.parse(readFileSync(join(root, ...parts), 'utf8'));
}

async function readApi(root, paths) {
  const instance = createConsoleServer({
    root,
    sessionToken: 'fixed-session-token',
    csrfToken: 'fixed-csrf-token',
    clock: () => new Date('2026-10-03T12:00:00.000Z'),
  });
  await new Promise((listening) => instance.server.listen(0, '127.0.0.1', listening));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    await page.text();
    const cookie = page.headers.get('set-cookie').split(';', 1)[0];
    const values = {};
    for (const [name, path] of Object.entries(paths)) {
      const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, `${path} precisa responder 200`);
      values[name] = await response.json();
    }
    return values;
  } finally {
    await new Promise((closed) => instance.server.close(closed));
  }
}

function dataSource(id, name, access = 'leitura') {
  return `---
type: DataSource
source_id: ${id}
nome: ${name}
kind: mcp
dono: "[[hugo-doria]]"
casa_da_verdade: servico ${name}
finalidade: alimentar a daily do dia
sensibilidade: media
pii: indireto
frescor: 1 dia
retencao: so referencia no recibo
acesso: ${access}
consumidores:
  - "[[daily]]"
status: Ativo
updated: 2026-10-01
---

# ${name}
`;
}

const DAILY_SYSTEM = `---
type: System
system_id: daily
nome: Daily do dia
versao: 0.1.0
status: Ativo
area: "[[hugo-os]]"
resultado: a daily note do dia com prioridades, agenda e loops abertos
nao_sucesso: listar o dia em vez de escolher o dia
entrega: daily-note
pronto_quando: a daily de hoje existe com no maximo cinco prioridades
dono: "[[hugo-doria]]"
gate_humano: o dono confirma as prioridades do dia
gatilho: agendado
quando: rotina de nuvem todo dia as 6h53
fontes:
  - papel: agenda
    fonte: "[[google-calendar]]"
    obrigatoria: nao
    acesso: leitura
    frescor: 1 dia
    finalidade: montar a secao de agenda
  - papel: notas
    fonte: "[[vault]]"
    obrigatoria: sim
    acesso: escrita-com-aprovacao
    frescor: 1 dia
    finalidade: ler e escrever a daily do dia
etapas:
  - estado: escrito
    entrada: contexto do dia
    saida: daily note do dia
    gate: no maximo cinco prioridades
gates:
  - a secao Prioridades tem no maximo cinco itens
perguntas_humanas:
  - as prioridades sao as do dia?
medida: daily-aprovada
paradas:
  - parar se a daily de hoje ja existir
updated: 2026-10-03
---

# Daily do dia
`;

const DAILY_ROUTINE = `---
type: Routine
routine_id: daily-nuvem
nome: HUGO OS, Daily
versao: 0.1.0
status: Aprovada
sistema: "[[daily]]"
host: nuvem
espaco: hugo-os
gatilho: agendado
cadencia: diaria
hora: "06:53"
fuso: America/Maceio
vigente_desde: 2026-07-06
se_perder: rodar-ao-acordar
gatilho_externo: trig_01EkF6Lv8ypHtr6QCSYdMGCk
instrucao: .claude/skills/daily/SKILL.md
permissao: escrita-no-espaco
destino_tipo: arquivo-local
destino: journal
tempo_limite_segundos: 1800
motivo_do_acesso: montar a daily do dia com agenda real e gravar a nota no vault
acessos:
  - fonte: "[[google-calendar]]"
    acao: ler-eventos
    modo: leitura
  - fonte: "[[vault]]"
    acao: escrever-daily
    modo: escrita-com-aprovacao
aprovado_por: "[[hugo-doria]]"
aprovado_em: 2026-07-06
updated: 2026-10-03
---

# HUGO OS, Daily
`;

// Nota inválida de propósito: Sistema que não existe, hora fora do formato de relógio e
// tempo limite acima do teto do protocolo.
const BROKEN_ROUTINE = `---
type: Routine
routine_id: rotina-quebrada
nome: Rotina quebrada
status: Aprovada
sistema: "[[sistema-fantasma]]"
host: nuvem
espaco: hugo-os
gatilho: agendado
cadencia: diaria
hora: 25h99
fuso: America/Maceio
vigente_desde: 2026-07-06
instrucao: .claude/skills/daily/SKILL.md
permissao: escrita-no-espaco
destino_tipo: arquivo-local
destino: journal
tempo_limite_segundos: 99999
motivo_do_acesso: nada que se sustente
acessos:
  - fonte: "[[google-calendar]]"
    acao: ler-eventos
    modo: leitura
aprovado_por: "[[hugo-doria]]"
aprovado_em: 2026-07-06
updated: 2026-10-03
---

# Rotina quebrada
`;

try {
  // ── vault sintético em modo vault ───────────────────────────────────────────────
  write(join(vaultRoot, 'AGENTS.md'), '# Vault sintético\n');
  write(join(vaultRoot, '.git', 'info', 'exclude'), '# local excludes\n');
  assert.equal(bootstrapLegacyConsole(vaultRoot, { confirm: true }).status, 'created');
  const layoutPath = join(vaultRoot, '.cerebro', 'layout.json');
  write(layoutPath, {
    ...JSON.parse(readFileSync(layoutPath, 'utf8')),
    knowledgeRoot: '.',
    vault: { daily: 'journal', inbox: 'inbox', projects: 'projects', areas: 'areas' },
  });

  write(join(vaultRoot, 'areas', 'hugo-os.md'), '---\ntype: Area\nstatus: Active\n---\n\n# HUGO OS\n');
  write(join(vaultRoot, '.claude', 'skills', 'daily', 'SKILL.md'), '# daily\n');
  write(join(vaultRoot, 'sistema', 'fontes', 'google-calendar.md'), dataSource('google-calendar', 'Agenda do dono'));
  write(join(vaultRoot, 'sistema', 'fontes', 'vault.md'), dataSource('vault', 'Notas do vault', 'leitura-escrita'));
  write(join(vaultRoot, 'sistema', 'sistemas', 'daily.md'), DAILY_SYSTEM);
  write(join(vaultRoot, 'sistema', 'rotinas', 'daily.md'), DAILY_ROUTINE);
  write(join(vaultRoot, 'sistema', 'rotinas', 'quebrada.md'), BROKEN_ROUTINE);

  // ── 1. simulação por padrão: nada é gravado ─────────────────────────────────────
  const dry = sync(vaultRoot);
  assert.equal(dry.code, 1, 'com nota inválida, a simulação sai com código 1');
  assert.match(dry.out, /^ok · sistema\/rotinas\/daily\.md · rotina daily-nuvem → \.cerebro\/contracts\/routines\/daily-nuvem\.json \(gravaria\)$/m,
    'a simulação diz qual nota de Rotina viraria qual contrato');
  assert.match(dry.out, /^ok · sistema\/rotinas\/daily\.md · grant grant-daily-nuvem-google-calendar-ler-eventos → \.cerebro\/contracts\/access-grants\/grant-daily-nuvem-google-calendar-ler-eventos\.json \(gravaria\)$/m,
    'a simulação lista cada Access Grant que a rotina geraria');
  assert.match(dry.out, /^ok · sistema\/rotinas\/daily\.md · executor executor-daily-nuvem → \.cerebro\/runtime\/executors\/executor-daily-nuvem\.json \(gravaria\)$/m,
    'a simulação lista o executor binding da rotina');
  assert.deepEqual(dir(vaultRoot, ROUTINES), [], 'sem --confirm, nenhum Routine Contract é gravado');
  assert.deepEqual(dir(vaultRoot, GRANTS), [], 'sem --confirm, nenhum Access Grant é gravado');
  assert.deepEqual(dir(vaultRoot, EXECUTORS), [], 'sem --confirm, nenhum executor binding é gravado');

  // ── 2. nota inválida: campo e motivo legíveis ───────────────────────────────────
  assert.ok(dry.lines.includes('sistema/rotinas/quebrada.md · sistema · nenhuma nota System com system_id "sistema-fantasma" neste vault'),
    `sistema inexistente precisa dizer qual wikilink falhou: ${dry.out}`);
  assert.ok(dry.lines.includes('sistema/rotinas/quebrada.md · hora · precisa ser HH:MM em relógio de 24 horas (ex.: 06:53)'),
    `hora fora de formato precisa sair como <nota> · <campo> · <motivo>: ${dry.out}`);
  assert.ok(dry.lines.includes('sistema/rotinas/quebrada.md · tempo_limite_segundos · precisa ser inteiro entre 10 e 7200'),
    `tempo limite fora da faixa precisa sair legível: ${dry.out}`);
  assert.equal(dry.lines.some((line) => line.startsWith('ok · sistema/rotinas/quebrada.md')), false,
    'nota inválida nunca sai como contrato pronto, nem em parte');

  // ── 3. --confirm grava contrato, grants e binding válidos ───────────────────────
  const confirmed = sync(vaultRoot, '--confirm');
  assert.equal(confirmed.code, 1, 'a nota quebrada continua reportada');
  assert.deepEqual(dir(vaultRoot, ROUTINES), ['daily-nuvem.json'], 'só a nota válida vira Routine Contract');
  assert.deepEqual(dir(vaultRoot, GRANTS), ['grant-daily-nuvem-google-calendar-ler-eventos.json', 'grant-daily-nuvem-vault-escrever-daily.json'],
    'a rotina gera um grant por modo de acesso declarado');
  assert.deepEqual(dir(vaultRoot, EXECUTORS), ['executor-daily-nuvem.json'],
    'a rotina gera o executor binding que o Console resolve');

  const routine = json(vaultRoot, ROUTINES, 'daily-nuvem.json');
  assert.deepEqual(validateRoutineContract(routine), [],
    'o Routine Contract gerado passa no validador do protocolo sem ajuste');
  assert.equal(routine.protocol_version, 1);
  assert.equal(routine.lifecycle, 'approved', 'status Aprovada vira lifecycle approved');
  assert.equal(routine.system_ref, 'daily', 'o sistema vem do alvo do wikilink');
  assert.equal(routine.trigger.type, 'schedule');
  assert.deepEqual(routine.trigger.schedule.cadence, 'daily');
  assert.equal(routine.trigger.schedule.time, '06:53');
  assert.equal(routine.trigger.schedule.timezone, 'America/Maceio');
  assert.deepEqual(routine.trigger.schedule.weekdays, [], 'cadência diária não carrega dias da semana');
  assert.equal(routine.trigger.schedule.not_before, '2026-07-06T00:00:00.000Z');
  assert.equal(routine.trigger.schedule.missed_run_policy, 'run-on-wake');
  assert.equal(routine.placement.host_ref, 'host-claude-cloud', 'host nuvem vira o host da nuvem da Claude');
  assert.equal(routine.placement.workspace_ref, 'hugo-os');
  assert.equal(routine.executor.binding_ref, 'executor-daily-nuvem');
  assert.equal(routine.context.prompt_ref, '.claude/skills/daily/SKILL.md',
    'a instrução aponta o SKILL.md da skill no vault');
  assert.deepEqual(routine.context.access_requests, [
    { grant_ref: 'grant-daily-nuvem-google-calendar-ler-eventos', source_ref: 'google-calendar', action: 'ler-eventos', mode: 'read' },
    { grant_ref: 'grant-daily-nuvem-vault-escrever-daily', source_ref: 'vault', action: 'escrever-daily', mode: 'write-with-approval' },
  ], 'cada acesso declarado vira um pedido que aponta o grant do seu modo');
  assert.equal(routine.permission_mode, 'workspace-write');
  assert.deepEqual(routine.destination, { kind: 'local-file', ref: 'journal' });
  assert.equal(routine.operations.timeout_seconds, 1800);
  assert.equal(routine.operations.retry.idempotency_scope, 'scheduled-slot');
  assert.equal(routine.operations.concurrency, 'forbid');
  assert.equal(routine.approval.required_before_schedule, true);
  assert.equal(routine.approval.approved_by, 'hugo-doria');
  assert.equal(routine.approval.approved_at, '2026-07-06T00:00:00.000Z');
  assert.equal(routine.privacy.content_shared_with_inevita, false);
  assert.equal(routine.extensions.vault_note_ref, 'sistema/rotinas/daily.md',
    'o contrato aponta a nota que o gerou');
  assert.equal(routine.extensions.external_trigger_ref, 'trig_01EkF6Lv8ypHtr6QCSYdMGCk',
    'o id do agendamento externo fica registrado como referência');
  assert.equal(Object.keys(routine).includes('prompt'), false, 'o contrato nunca carrega uma chave prompt');
  assert.equal(/"(?:prompt|output|token|api_key|oauth)"\s*:/i.test(JSON.stringify(routine)), false,
    'nenhuma chave do contrato parece payload ou credencial');

  const readGrant = json(vaultRoot, GRANTS, 'grant-daily-nuvem-google-calendar-ler-eventos.json');
  assert.deepEqual(validateAccessGrant(readGrant), [],
    'o Access Grant gerado passa no validador do protocolo sem ajuste');
  assert.deepEqual(readGrant.subject, { type: 'system', ref: 'daily' },
    'o sujeito do grant é o Sistema da rotina');
  assert.deepEqual(readGrant.scope.system_refs, ['daily']);
  assert.deepEqual(readGrant.scope.source_refs, ['google-calendar'],
    'o escopo lista as fontes que a rotina acessa naquele modo');
  assert.deepEqual(readGrant.scope.actions, ['ler-eventos'], 'as ações vêm da nota');
  assert.equal(readGrant.mode, 'read');
  assert.equal(readGrant.assurance, 'receipt-audited',
    'sem custódia de credencial, a garantia é por recibo auditado');
  assert.equal(readGrant.custody, 'agent-direct');
  assert.equal(readGrant.credential_ref, null, 'o grant do vault não guarda credencial');
  assert.equal(readGrant.approved_by, 'hugo-doria');
  const writeGrant = json(vaultRoot, GRANTS, 'grant-daily-nuvem-vault-escrever-daily.json');
  assert.equal(writeGrant.mode, 'write-with-approval');
  assert.deepEqual(writeGrant.scope.source_refs, ['vault']);

  const binding = json(vaultRoot, EXECUTORS, 'executor-daily-nuvem.json');
  assert.deepEqual(validateExecutorBinding(binding), [],
    'o executor binding gerado passa no validador do protocolo sem ajuste');
  assert.equal(binding.adapter, 'claude-code');
  assert.equal(binding.auth.type, 'provider-session');
  assert.equal(binding.permission_profile, 'workspace-write');
  assert.equal(binding.privacy.credential_stored, false);
  assert.equal(binding.workspace_path, '.');

  const registry = json(vaultRoot, '.cerebro', 'compiled.json');
  const owned = registry.files.filter((file) => file.note === 'sistema/rotinas/daily.md').map((file) => file.path);
  assert.deepEqual(owned.sort(), [
    '.cerebro/contracts/access-grants/grant-daily-nuvem-google-calendar-ler-eventos.json',
    '.cerebro/contracts/access-grants/grant-daily-nuvem-vault-escrever-daily.json',
    '.cerebro/contracts/routines/daily-nuvem.json',
    '.cerebro/runtime/executors/executor-daily-nuvem.json',
  ], 'o registro assume todos os arquivos da rotina, inclusive o binding no runtime');

  // ── 4. o Console mostra a rotina com agenda, sistema e grants ───────────────────
  const api = await readApi(vaultRoot, { console: '/api/console' });
  assert.equal(api.console.counts.routines, 1, 'a tela Rotinas conta a rotina declarada');
  const view = api.console.routines.find((item) => item.routine_id === 'daily-nuvem');
  assert.ok(view, 'Julgamento › Rotinas mostra a rotina compilada');
  assert.equal(view.name, 'HUGO OS, Daily');
  assert.equal(view.system_ref, 'daily', 'a rotina aparece ligada ao Sistema');
  assert.equal(view.schedule, 'Todos os dias às 06:53 · America/Maceio',
    'a agenda sai legível na tela, a partir do calendário do contrato');
  assert.equal(view.lifecycle, 'approved');
  assert.equal(view.binding.adapter, 'claude-code', 'o Console resolve o executor binding gerado');
  assert.equal(view.binding.auth_status, 'ready');
  assert.deepEqual(view.access.map((item) => [item.source_ref, item.grant_status, item.assurance]), [
    ['google-calendar', 'granted', 'receipt-audited'],
    ['vault', 'granted', 'receipt-audited'],
  ], 'Confiança › Governança mostra cada fonte com o grant resolvido');
  assert.deepEqual(view.access.map((item) => item.grant_ref),
    ['grant-daily-nuvem-google-calendar-ler-eventos', 'grant-daily-nuvem-vault-escrever-daily'],
    'a governança aponta o grant de cada acesso');
  assert.deepEqual(view.receipts, [], 'rotina declarada não inventa execução: nada executa modelo aqui');
  assert.equal(api.console.issues.some((issue) => issue.reason_code === 'routine-contract-invalid'), false,
    'nenhum contrato gerado entra na tela Saúde como inválido');
  assert.equal(api.console.issues.some((issue) => issue.reason_code === 'routine-state-invalid'), false,
    'rotina sem estado gravado não vira issue');

  // Governança do Console é derivada de routine.access: o mesmo achatamento da tela.
  const grants = api.console.routines.flatMap((item) => item.access.map((access) => ({ ...access, routine: item.routine_id })));
  assert.equal(grants.length, 2, 'a tela Governança lista um cartão por acesso declarado');
  assert.equal(grants.every((grant) => grant.routine === 'daily-nuvem'), true);

  // ── 5. recompilar não muda nada ─────────────────────────────────────────────────
  const before = statSync(join(vaultRoot, ROUTINES, 'daily-nuvem.json')).mtimeMs;
  const content = readFileSync(join(vaultRoot, ROUTINES, 'daily-nuvem.json'), 'utf8');
  const again = sync(vaultRoot, '--confirm');
  assert.match(again.out, /· 0 arquivo\(s\) gravado\(s\) · 0 órfão\(s\) removido\(s\)/,
    'a segunda rodada não grava nada');
  assert.equal(readFileSync(join(vaultRoot, ROUTINES, 'daily-nuvem.json'), 'utf8'), content,
    'o conteúdo do Routine Contract é idêntico na recompilação');
  assert.equal(statSync(join(vaultRoot, ROUTINES, 'daily-nuvem.json')).mtimeMs, before,
    'o arquivo não é reescrito quando nada mudou');

  // ── 6. instalação INEVITA sem vault segue igual ─────────────────────────────────
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3 });
  const example = JSON.parse(readFileSync(resolve(here, '..', 'protocol', 'examples', 'routine-contract.v1.json'), 'utf8'));
  write(join(inevitaRoot, ROUTINES, 'funil-diario-cerebro.json'), example);
  const inevita = sync(inevitaRoot, '--confirm');
  assert.equal(inevita.code, 0, 'instalação sem nota compilável não é erro');
  assert.match(inevita.out, /nenhuma nota compilável encontrada neste vault/);
  assert.deepEqual(dir(inevitaRoot, ROUTINES), ['funil-diario-cerebro.json'],
    'instalação INEVITA não perde nem ganha Routine Contract');
  assert.deepEqual(json(inevitaRoot, ROUTINES, 'funil-diario-cerebro.json'), example,
    'o contrato de exemplo da INEVITA continua byte a byte o mesmo');
  assert.equal(existsSync(join(inevitaRoot, '.cerebro', 'compiled.json')), false,
    'sem nota compilável, o compilador não cria registro');

  console.log('✓ vault:sync compila notas Routine em Routine Contract, Access Grant e executor binding, e o Console mostra Rotinas com agenda, sistema e grants');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
