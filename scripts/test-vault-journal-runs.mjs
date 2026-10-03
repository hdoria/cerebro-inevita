#!/usr/bin/env node

// Seam único do ticket 10: vault sintético (uma Área, três Fontes, dois Sistemas, duas
// Rotinas, três dailies e uma weekly review) → `vault-compile` + `vault-import-journal`
// (CLIs) → API HTTP do Console. Verifica comportamento externo: o que a CLI imprime, o
// que fica gravado no runtime e o que o Console devolve em Julgamento › Rotinas, em
// Julgamento › Runs, na saída de um recibo e no Canvas de um run.
//
// Cobre: recibo de execução de Rotina válido pelo validador do protocolo; ponteiro de
// saída com caminho e hash e sem nenhum pedaço do corpo da nota; trace reconstruído com
// sequência íntegra; julgamento pendente para cada execução (nenhuma aprovação
// inventada); nota fora da convenção e nota anterior ao `not_before` saem no relatório
// com motivo; PII recusada antes de gravar; reimportar não acrescenta nada; instalação
// INEVITA sem vault continua idêntica.
//
// Nada aqui executa modelo: a execução é histórico importado, e o Console só lê o que
// ficou declarado.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';
import { validateRoutineRunReceipt } from './lib/routine-protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const COMPILE = join(here, 'vault-compile.mjs');
const IMPORT = join(here, 'vault-import-journal.mjs');
const RECEIPTS = join('.cerebro', 'runtime', 'receipts', 'routines');
const OUTPUTS = join('.cerebro', 'runtime', 'outputs', 'routines');
const TRACES = join('.cerebro', 'runtime', 'traces');
const SECRET_BODY = 'segredo do corpo da nota que nunca pode sair do vault';
const vaultRoot = mkdtempSync(join(tmpdir(), 'vault-journal-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'vault-journal-inevita-'));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function run(script, root, ...flags) {
  const result = spawnSync(process.execPath, [script, `--root=${root}`, ...flags], { encoding: 'utf8' });
  return {
    out: result.stdout || '', err: result.stderr || '', code: result.status,
    lines: (result.stdout || '').split('\n').filter(Boolean),
  };
}

function dir(root, relative) {
  const path = join(root, relative);
  return existsSync(path) ? readdirSync(path).sort() : [];
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
finalidade: alimentar as rotinas do vault
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

function system({ id, name, result, measure, sources }) {
  return `---
type: System
system_id: ${id}
nome: ${name}
versao: 0.1.0
status: Ativo
area: "[[hugo-os]]"
resultado: ${result}
nao_sucesso: entregar sem a evidencia que o gate pede
entrega: ${measure}
pronto_quando: a nota de saida existe com a evidencia citada
dono: "[[hugo-doria]]"
gate_humano: o dono confirma o resultado antes de contar como aprovado
gatilho: agendado
quando: rotina de nuvem
fontes:
${sources.map((source) => `  - papel: ${source.role}
    fonte: "[[${source.id}]]"
    obrigatoria: ${source.required ? 'sim' : 'nao'}
    acesso: ${source.access || 'leitura'}
    frescor: 1 dia
    finalidade: alimentar o sistema ${id}`).join('\n')}
etapas:
  - estado: escrito
    entrada: contexto do periodo
    saida: a nota de saida do periodo
    gate: nenhum fato entra sem fonte real
gates:
  - nenhum fato entra sem fonte real
perguntas_humanas:
  - o resultado é o que o dono esperava?
medida: ${measure}
paradas:
  - parar se a nota do periodo ja existir
updated: 2026-10-03
---

# ${name}
`;
}

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

const WEEKLY_ROUTINE = `---
type: Routine
routine_id: weekly-review-nuvem
nome: HUGO OS, Weekly Review
versao: 0.1.0
status: Aprovada
sistema: "[[weekly-review]]"
host: nuvem
espaco: hugo-os
gatilho: agendado
cadencia: semanal
hora: "18:07"
fuso: America/Maceio
dias_da_semana: [domingo]
vigente_desde: 2026-07-06
se_perder: rodar-ao-acordar
instrucao: .claude/skills/weekly-review/SKILL.md
permissao: escrita-no-espaco
destino_tipo: arquivo-local
destino: journal
tempo_limite_segundos: 1800
motivo_do_acesso: fechar a semana a partir do que mudou de fato no vault
acessos:
  - fonte: "[[repositorios-git]]"
    acao: ler-log
    modo: leitura
  - fonte: "[[vault]]"
    acao: escrever-review
    modo: escrita-com-aprovacao
aprovado_por: "[[hugo-doria]]"
aprovado_em: 2026-07-06
updated: 2026-10-03
---

# HUGO OS, Weekly Review
`;

function daily({ date, actor = null, body = SECRET_BODY }) {
  return `---
type: Note
tags: [diario]
created: ${date}
---

# ${date}

## Prioridades

- ${body}

## Log de agentes

${actor ? `- ${actor}: rodou a rotina e gravou a nota.\n` : '- Contexto coletado sem agente nomeado.\n'}`;
}

function weekly({ week, created }) {
  return `---
type: Note
tags: [semana, review]
created: ${created}
---

# ${week} — Revisão semanal

## Resumo da semana

- ${SECRET_BODY}
`;
}

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
  write(join(vaultRoot, '.claude', 'skills', 'weekly-review', 'SKILL.md'), '# weekly\n');
  write(join(vaultRoot, 'sistema', 'fontes', 'google-calendar.md'), dataSource('google-calendar', 'Agenda do dono'));
  write(join(vaultRoot, 'sistema', 'fontes', 'repositorios-git.md'), dataSource('repositorios-git', 'Repositórios git'));
  write(join(vaultRoot, 'sistema', 'fontes', 'vault.md'), dataSource('vault', 'Notas do vault', 'leitura-escrita'));
  write(join(vaultRoot, 'sistema', 'sistemas', 'daily.md'), system({
    id: 'daily',
    name: 'Daily do dia',
    result: 'a daily note do dia com prioridades, agenda e loops abertos',
    measure: 'daily-aprovada',
    sources: [
      { role: 'agenda', id: 'google-calendar', required: false },
      { role: 'notas', id: 'vault', required: true, access: 'escrita-com-aprovacao' },
    ],
  }));
  write(join(vaultRoot, 'sistema', 'sistemas', 'weekly-review.md'), system({
    id: 'weekly-review',
    name: 'Revisão da semana',
    result: 'a nota da semana com o que mudou de fato e o foco da semana que começa',
    measure: 'weekly-aprovada',
    sources: [
      { role: 'repositorios', id: 'repositorios-git', required: false },
      { role: 'notas', id: 'vault', required: true, access: 'escrita-com-aprovacao' },
    ],
  }));
  write(join(vaultRoot, 'sistema', 'rotinas', 'daily.md'), DAILY_ROUTINE);
  write(join(vaultRoot, 'sistema', 'rotinas', 'weekly-review.md'), WEEKLY_ROUTINE);

  // journal: três dailies, uma weekly, uma daily anterior ao `vigente_desde` e uma nota
  // fora da convenção de nome.
  write(join(vaultRoot, 'journal', '2026-07-06.md'), daily({
    date: '2026-07-06', actor: 'Claude Code (rotina diária automática)',
  }));
  write(join(vaultRoot, 'journal', '2026-07-07.md'), daily({ date: '2026-07-07' }));
  write(join(vaultRoot, 'journal', '2026-07-08.md'), daily({ date: '2026-07-08' }));
  write(join(vaultRoot, 'journal', '2026-W28-review.md'), weekly({ week: '2026-W28', created: '2026-07-12' }));
  write(join(vaultRoot, 'journal', '2026-03-17.md'), daily({ date: '2026-03-17' }));
  write(join(vaultRoot, 'journal', 'rascunho-da-semana.md'), '---\ntype: Note\n---\n\n# rascunho\n');

  // ── 0. os contratos compilados são o pré-requisito ─────────────────────────────
  const compiled = run(COMPILE, vaultRoot, '--confirm');
  assert.equal(compiled.code, 0, `o vault sintético compila sem erro: ${compiled.out}${compiled.err}`);

  // ── 1. simulação por padrão: relatório completo, nada gravado ───────────────────
  const dry = run(IMPORT, vaultRoot);
  assert.equal(dry.code, 0, `a simulação de um journal sadio sai com código 0: ${dry.out}${dry.err}`);
  assert.ok(dry.lines.includes('dailies · daily-nuvem 0.1.0 · 3 execução(ões)'),
    `a simulação conta as dailies da rotina diária: ${dry.out}`);
  assert.ok(dry.lines.includes('weeklies · weekly-review-nuvem 0.1.0 · 1 execução(ões)'),
    `a simulação conta as weekly reviews da rotina semanal: ${dry.out}`);
  assert.ok(dry.lines.includes('ignorada · journal/2026-03-17.md · anterior ao vigente_desde da rotina'),
    `nota anterior ao not_before sai com motivo: ${dry.out}`);
  assert.ok(dry.lines.includes('ignorada · journal/rascunho-da-semana.md · nome fora da convenção de daily ou weekly review'),
    `nota fora da convenção sai com motivo: ${dry.out}`);
  assert.match(dry.out, /simulação: 4 execução\(ões\) · 4 a gravar · 0 já no runtime/,
    `a simulação diz quantas execuções entrariam: ${dry.out}`);
  assert.deepEqual(dir(vaultRoot, RECEIPTS), [], 'sem --confirm, nenhum recibo é gravado');
  assert.deepEqual(dir(vaultRoot, OUTPUTS), [], 'sem --confirm, nenhum ponteiro de saída é gravado');
  assert.deepEqual(dir(vaultRoot, TRACES), [], 'sem --confirm, nenhum trace é gravado');

  // ── 2. --confirm grava recibo, ponteiro e trace ─────────────────────────────────
  const confirmed = run(IMPORT, vaultRoot, '--confirm');
  assert.equal(confirmed.code, 0, `a importação confirmada sai com código 0: ${confirmed.out}${confirmed.err}`);
  assert.match(confirmed.out, /4 execução\(ões\) · 4 gravada\(s\) · 0 já no runtime/,
    `a rodada confirmada reporta o que gravou: ${confirmed.out}`);
  const receiptFiles = dir(vaultRoot, RECEIPTS);
  assert.equal(receiptFiles.length, 4, 'um recibo por daily e por weekly review');
  const receipts = receiptFiles.map((name) => JSON.parse(readFileSync(join(vaultRoot, RECEIPTS, name), 'utf8')));
  for (const receipt of receipts) {
    assert.deepEqual(validateRoutineRunReceipt(receipt), [],
      `o recibo gerado passa no validador do protocolo sem ajuste: ${receipt.receipt_id}`);
    assert.equal(receipt.protocol_version, 1);
    assert.equal(receipt.status, 'completed', 'nota existente com conteúdo é execução concluída');
    assert.equal(receipt.trigger, 'schedule');
    assert.ok(receipt.scheduled_for, 'trigger schedule exige scheduled_for');
    assert.equal(receipt.routine_ref, `routine:${receipt.routine_id}:${receipt.routine_version}`);
    assert.equal(receipt.model_observation, 'requested-not-verified');
    assert.equal(receipt.reason_code, 'journal-history-imported',
      'o recibo carrega a marca de histórico importado no único campo livre do schema');
    assert.equal(receipt.privacy.content_shared_with_inevita, false);
    assert.equal(receipt.privacy.prompt_recorded, false);
    assert.equal(receipt.privacy.output_recorded, false);
    assert.equal(receipt.privacy.raw_error_recorded, false);
    assert.ok(receipt.output_ref.startsWith('.cerebro/runtime/outputs/routines/'),
      'a saída fica na pasta de saídas da rotina, para o Julgamento conseguir abrir');
    assert.ok(!JSON.stringify(receipt).includes(SECRET_BODY),
      'nenhum pedaço do corpo da nota entra no recibo');
  }
  const byRoutine = {};
  for (const receipt of receipts) byRoutine[receipt.routine_id] = (byRoutine[receipt.routine_id] || 0) + 1;
  assert.deepEqual(byRoutine, { 'daily-nuvem': 3, 'weekly-review-nuvem': 1 },
    'cada nota cai na rotina que declara aquela cadência');

  const dailySix = receipts.find((receipt) => receipt.input_refs.includes('journal/2026-07-06.md'));
  assert.equal(dailySix.scheduled_for, '2026-07-06T09:53:00.000Z',
    'a daily é agendada às 06:53 em America/Maceio, convertida para UTC — nunca meia-noite');
  assert.equal(dailySix.started_at, dailySix.scheduled_for);
  assert.equal(dailySix.completed_at, dailySix.scheduled_for);
  assert.equal(dailySix.system_ref, 'daily');
  assert.equal(dailySix.adapter, 'claude-code');
  const weeklyReceipt = receipts.find((receipt) => receipt.routine_id === 'weekly-review-nuvem');
  assert.equal(weeklyReceipt.scheduled_for, '2026-07-12T21:07:00.000Z',
    'a weekly é agendada no domingo da semana ISO às 18:07 em America/Maceio');
  assert.equal(weeklyReceipt.system_ref, 'weekly-review');

  // ── 3. o ponteiro de saída mostra caminho, data e hash — nunca o corpo ──────────
  const pointerFiles = dir(vaultRoot, OUTPUTS);
  assert.equal(pointerFiles.length, 4, 'um ponteiro de saída por execução');
  for (const name of pointerFiles) {
    const pointer = readFileSync(join(vaultRoot, OUTPUTS, name), 'utf8');
    assert.ok(!pointer.includes(SECRET_BODY), 'o ponteiro nunca copia o corpo da nota');
    assert.match(pointer, /sha256:[0-9a-f]{64}/, 'o ponteiro carrega o hash do conteúdo da nota');
    assert.match(pointer, /journal\/(?:\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}-review)\.md/,
      'o ponteiro carrega o caminho da nota no vault');
  }

  // ── 4. o trace reconstruído fecha com sequência íntegra ────────────────────────
  const traceFiles = dir(vaultRoot, TRACES);
  assert.equal(traceFiles.length, 4, 'um trace por execução');
  for (const name of traceFiles) {
    const events = readFileSync(join(vaultRoot, TRACES, name), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1),
      'a sequência do trace vai de 1 a n sem buraco');
    assert.equal(new Set(events.map((event) => event.trace_id)).size, 1, 'um trace_id por run');
    assert.equal(new Set(events.map((event) => event.run_id)).size, 1, 'um run_id por trace');
    assert.equal(events[0].extensions.origin, 'reconstructed',
      'o trace do histórico é reconstruído, nunca gravado ao vivo');
    assert.equal(events[0].extensions.verification_state, 'legacy-unverified',
      'sem evidência de verificação, o trace sai marcado');
    assert.ok(events.some((event) => event.step_type === 'judgment' && event.state === 'pending'),
      'o trace deixa o julgamento humano explicitamente pendente');
    assert.ok(!readFileSync(join(vaultRoot, TRACES, name), 'utf8').includes(SECRET_BODY),
      'nenhum pedaço do corpo da nota entra no trace');
  }
  const dailySixTrace = readFileSync(join(vaultRoot, TRACES, `${dailySix.run_id}.jsonl`), 'utf8');
  assert.match(dailySixTrace, /Claude Code \(rotina diária automática\)/,
    'o ator declarado no Log de agentes entra como referência no trace');

  // ── 5. o Console mostra as execuções, os julgamentos e o Canvas ────────────────
  const api = await readApi(vaultRoot, {
    console: '/api/console',
    runs: '/api/runs',
    output: `/api/runs/${dailySix.receipt_id}/output`,
    graph: `/api/graphs/runs/${dailySix.receipt_id}`,
  });
  const consoleRoutines = new Map(api.console.routines.map((routine) => [routine.routine_id, routine]));
  assert.equal(consoleRoutines.get('daily-nuvem').receipts.length, 3,
    'Julgamento › Rotinas mostra os recibos da rotina diária');
  assert.equal(consoleRoutines.get('weekly-review-nuvem').receipts.length, 1,
    'Julgamento › Rotinas mostra o recibo da rotina semanal');
  assert.equal(api.console.counts.judgments, 4,
    'a caixa de julgamentos enche com uma pendência por execução');
  assert.equal(api.console.judgments.filter((item) => item.judgment.status === 'pending').length, 4,
    'nenhuma execução importada aparece julgada');
  assert.deepEqual(api.console.issues, [], 'nenhum recibo importado derruba a tela Saúde');

  assert.equal(api.runs.runs.length, 4, 'Julgamento › Runs mostra as quatro execuções');
  assert.deepEqual(api.runs.issues, [], 'o runtime importado não gera issue em Runs');
  for (const entry of api.runs.runs) {
    assert.equal(entry.origin, 'routine-receipt', 'cada linha nasce do recibo da rotina');
    assert.equal(entry.trace.status, 'reconstructed', 'o Console marca o trace como reconstruído');
    assert.ok(entry.trace.events >= 5, 'o trace tem os passos do run no Console');
    assert.equal(entry.human_decision, null, 'o Console nunca mostra aprovação inventada');
  }

  assert.equal(api.output.receipt.receipt_id, dailySix.receipt_id);
  assert.match(api.output.output.content, /journal\/2026-07-06\.md/,
    'a saída que o Julgamento abre mostra o caminho da nota');
  assert.match(api.output.output.content, /sha256:[0-9a-f]{64}/,
    'a saída que o Julgamento abre mostra o hash do conteúdo');
  assert.equal(api.output.output.content.includes(SECRET_BODY), false,
    'a saída que o Julgamento abre nunca mostra o corpo da nota');
  assert.equal(api.output.judgment.summary.status, 'pending');

  assert.ok(api.graph.nodes.length > 0, 'o Canvas do run desenha nós');
  assert.equal(api.graph.trace_origin, 'reconstructed');
  assert.ok(api.graph.trace_events >= 5, 'o Canvas do run recebe o trace reconstruído');

  // ── 6. reimportar não acrescenta nada ──────────────────────────────────────────
  const again = run(IMPORT, vaultRoot, '--confirm');
  assert.equal(again.code, 0, `a segunda rodada sai com código 0: ${again.out}${again.err}`);
  assert.match(again.out, /4 execução\(ões\) · 0 gravada\(s\) · 4 já no runtime/,
    `a segunda rodada não grava nada: ${again.out}`);
  assert.deepEqual(dir(vaultRoot, RECEIPTS), receiptFiles, 'os mesmos recibos continuam no runtime');
  assert.deepEqual(dir(vaultRoot, OUTPUTS), pointerFiles, 'os mesmos ponteiros continuam no runtime');
  assert.deepEqual(dir(vaultRoot, TRACES), traceFiles, 'os mesmos traces continuam no runtime');

  // ── 7. PII é recusada antes de gravar ─────────────────────────────────────────
  write(join(vaultRoot, 'journal', '2026-07-09.md'), daily({
    date: '2026-07-09', actor: 'Claude Code (ficha 123.456.789-09)',
  }));
  const withPii = run(IMPORT, vaultRoot, '--confirm');
  assert.equal(withPii.code, 1, 'daily com padrão de PII faz a importação sair com erro');
  assert.match(withPii.out, /recusada por PII · journal\/2026-07-09\.md · .*cpf/,
    `a recusa diz qual nota e qual padrão: ${withPii.out}`);
  assert.equal(dir(vaultRoot, RECEIPTS).length, 4, 'a nota recusada não gera recibo');
  assert.equal(dir(vaultRoot, OUTPUTS).length, 4, 'a nota recusada não gera ponteiro');
  rmSync(join(vaultRoot, 'journal', '2026-07-09.md'));

  // ── 8. instalação INEVITA sem vault segue igual ───────────────────────────────
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3 });
  const inevita = run(IMPORT, inevitaRoot, '--confirm');
  assert.equal(inevita.code, 0, 'instalação sem vault não é erro');
  assert.match(inevita.out, /este Cérebro não declara vault no layout; nada a importar/);
  assert.deepEqual(dir(inevitaRoot, RECEIPTS), [], 'nenhum recibo é criado numa instalação sem vault');
  assert.deepEqual(dir(inevitaRoot, OUTPUTS), [], 'nenhuma saída é criada numa instalação sem vault');
  assert.deepEqual(dir(inevitaRoot, TRACES), [], 'nenhum trace é criado numa instalação sem vault');

  console.log('✓ as dailies e as weekly reviews do journal viram execuções de Rotina com ponteiro de saída e trace, e o Console mostra recibos, julgamentos e Canvas');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
