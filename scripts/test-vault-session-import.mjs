#!/usr/bin/env node

// Seam único do ticket 11: vault sintético (Fontes, Sistemas, sessões de IA e dailies com
// `## Log de agentes`) → `vault:sync` (CLI) → API HTTP do Console. Verifica comportamento
// externo: o que a CLI imprime, o que fica gravado no ledger e o que o Console devolve em
// Julgamento › Runs (`/api/runs`) e em Cérebro › Recuperação (`/api/anatomy`).
//
// Cobre: Run Record v2 válido pelo validador do protocolo; um run por sessão classificada;
// as fontes do Log de agentes viram acessos do snapshot; sessão sem fonte no log cai na
// fonte vault com lacuna declarada; `## Verificação` é a única coisa que liga `eval.passed`;
// nenhuma aprovação inventada; sessão sem Sistema fica no balde `sessao-livre` e não vira
// recibo; reimportar não grava nada; instalação INEVITA sem vault continua idêntica.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';
import { validateRunRecord } from './lib/system-protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SYNC = join(here, 'vault-sync.mjs');
const LEDGER = join('.cerebro', 'runtime', 'ledger', 'runs.jsonl');
const vaultRoot = mkdtempSync(join(tmpdir(), 'vault-sessions-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'vault-sessions-inevita-'));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function sync(root, ...flags) {
  const run = spawnSync(process.execPath, [SYNC, `--root=${root}`, ...flags], { encoding: 'utf8' });
  return { out: run.stdout || '', code: run.status, lines: (run.stdout || '').split('\n').filter(Boolean) };
}

function ledger(root) {
  const path = join(root, LEDGER);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
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

function dataSource(id, name) {
  return `---
type: DataSource
source_id: ${id}
nome: ${name}
kind: mcp
dono: "[[hugo-doria]]"
casa_da_verdade: servico ${name}
finalidade: alimentar os sistemas do vault
sensibilidade: media
pii: indireto
frescor: 1 dia
retencao: so referencia no recibo
acesso: leitura
consumidores:
  - "[[daily]]"
status: Ativo
updated: 2026-10-01
---

# ${name}
`;
}

function system({ id, name, measure, sources }) {
  return `---
type: System
system_id: ${id}
nome: ${name}
versao: 0.1.0
status: Ativo
area: "[[popcode]]"
area_confirmada: sim
resultado: o resultado declarado do sistema ${id}
nao_sucesso: entregar sem a evidencia que o gate pede
entrega: ${measure}
pronto_quando: o output existe com a evidencia citada
dono: "[[hugo-doria]]"
gate_humano: o dono confirma o resultado antes de contar como aprovado
gatilho: manual
quando: invocacao manual de /${id}
capacidade: ${id}
capacidade_origem: local
fontes:
${sources.map((source) => `  - papel: ${source.role}
    fonte: "[[${source.id}]]"
    obrigatoria: ${source.required ? 'sim' : 'nao'}
    acesso: leitura
    frescor: 1 dia
    finalidade: alimentar o sistema ${id}
    janela: o dia de hoje
    selecao: recente${source.required ? '' : '\n    se_faltar: seguir-com-lacuna'}`).join('\n')}
etapas:
  - estado: coletado
    entrada: as fontes que responderem
    saida: o contexto do dia com origem
    gate: nenhum fato entra sem fonte real
gates:
  - nenhum fato entra sem fonte real
perguntas_humanas:
  - o resultado é o que o dono esperava?
medida: ${measure}
paradas:
  - parar quando a fonte obrigatoria nao abre
leitura:
  - as fontes declaradas neste Sistema
escrita:
  - a nota de saida do sistema
acoes_externas: nao
updated: 2026-10-03
---

# ${name}
`;
}

function session({ tags, created, relatedTo = [], verification = null, body = 'trabalho da sessão' }) {
  return `---
type: Note
tags: [${tags.join(', ')}]
created: ${created}
${relatedTo.length ? `related_to:\n${relatedTo.map((ref) => `  - "[[${ref}]]"`).join('\n')}\n` : ''}---

# ${created} — sessão sintética

## O que foi feito

- ${body}

${verification ? `## Verificação\n\n- ${verification}\n` : ''}`;
}

function daily({ date, log }) {
  return `---
type: Note
tags: [diario]
created: ${date}
---

# ${date}

## Prioridades

- prioridade do dia

## Log de agentes

${log.map((line) => `- ${line}`).join('\n')}
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
    runLedger: LEDGER.split('\\').join('/'),
    vault: {
      daily: 'journal', inbox: 'inbox', projects: 'projects', areas: 'areas', sessions: 'ai/sessions',
    },
  });

  write(join(vaultRoot, 'areas', 'popcode.md'), '---\ntype: Area\nstatus: Active\n---\n\n# Popcode Studio\n');
  for (const [id, name] of [
    ['gmail', 'Gmail do dono'], ['google-calendar', 'Agenda do dono'], ['clickup', 'ClickUp'],
    ['web', 'Página pública'], ['vault', 'Vault do dono'],
  ]) {
    write(join(vaultRoot, 'sistema', 'fontes', `${id}.md`), dataSource(id, name));
  }
  write(join(vaultRoot, 'sistema', 'sistemas', 'daily.md'), system({
    id: 'daily',
    name: 'Daily do dia',
    measure: 'daily-aprovada',
    sources: [
      { role: 'agenda', id: 'google-calendar', required: false },
      { role: 'email', id: 'gmail', required: false },
      { role: 'tarefas', id: 'clickup', required: false },
      { role: 'notas-do-vault', id: 'vault', required: true },
    ],
  }));
  write(join(vaultRoot, 'sistema', 'sistemas', 'ingerir.md'), system({
    id: 'ingerir',
    name: 'Ingestão de fonte',
    measure: 'nota-aprovada',
    sources: [
      { role: 'pagina-web', id: 'web', required: false },
      { role: 'notas-conectadas', id: 'vault', required: true },
    ],
  }));

  // Sessões: duas classificadas pelo tema, uma pela tag, uma verificada, uma sem daily e
  // duas sem Sistema nenhum.
  const sessions = join(vaultRoot, 'ai', 'sessions');
  write(join(sessions, '2026-07-06-ingestao-gerados.md'), session({
    tags: ['sessao', 'ingestao'], created: '2026-07-06', relatedTo: ['popcode', 'Área/Conteúdo'],
  }));
  write(join(sessions, '2026-07-06-daily.md'), session({
    tags: ['sessao', 'diario'], created: '2026-07-06',
  }));
  write(join(sessions, '2026-07-07-consolidacao.md'), session({
    tags: ['ai-session', 'daily'], created: '2026-07-07', verification: 'contagem conferida pelo comando',
  }));
  write(join(sessions, '2026-07-08-ingestao-sem-daily.md'), session({
    tags: ['sessao'], created: '2026-07-08',
  }));
  write(join(sessions, '2026-07-09-proposta-unifor.md'), session({
    tags: ['sessao', 'comercial'], created: '2026-07-09',
  }));
  write(join(sessions, '2026-07-09-post-linkedin.md'), session({
    tags: ['sessao', 'conteudo'], created: '2026-07-09',
  }));

  write(join(vaultRoot, 'journal', '2026-07-06.md'), daily({
    date: '2026-07-06',
    log: [
      'Claude Code (ingestão): leu https://tolaria.app inteiro e destilou em [[tolaria]].',
      'Claude Code (daily): Google Calendar (6 eventos), Gmail (threads não lidas), ClickUp (3 tarefas), Jira sem prazo.',
    ],
  }));
  write(join(vaultRoot, 'journal', '2026-07-07.md'), daily({
    date: '2026-07-07',
    log: ['Claude Code (daily): Google Calendar e Gmail consultados.'],
  }));
  write(join(vaultRoot, 'journal', '2026-07-09.md'), daily({
    date: '2026-07-09',
    log: ['Claude Code (comercial): proposta escrita à mão, sem ferramenta.'],
  }));

  // ── 1. simulação por padrão: nada gravado, e sem contrato não se inventa Sistema ─
  const dry = sync(vaultRoot);
  assert.equal(dry.code, 0, `a simulação de um vault sadio sai com código 0: ${dry.out}`);
  assert.ok(dry.lines.includes('sem contrato · daily · 2 sessão(ões) classificadas sem System Contract compilado'),
    `antes de compilar, a sessão classificada fica sem contrato em vez de virar recibo: ${dry.out}`);
  assert.ok(dry.lines.includes('sem classificação · 2 sessão(ões) no balde sessao-livre (não importadas)'),
    `o relatório conta o balde sessao-livre: ${dry.out}`);
  assert.match(dry.out, /simulação: 0 run record\(s\) v2 · 0 a gravar · 0 já no ledger/,
    `sem contrato, não há run record a gravar: ${dry.out}`);
  assert.deepEqual(ledger(vaultRoot), [], 'sem --confirm, nada entra no ledger');

  // ── 2. --confirm compila os contratos e grava Run Records v2 válidos ────────────
  const confirmed = sync(vaultRoot, '--confirm');
  assert.equal(confirmed.code, 0, `a importação confirmada sai com código 0: ${confirmed.out}`);
  const confirmedLines = confirmed.lines;
  assert.ok(confirmedLines.includes('por sistema · daily · 2 sessão(ões)'),
    `o relatório conta por Sistema: ${confirmed.out}`);
  assert.ok(confirmedLines.includes('por sistema · ingerir · 2 sessão(ões)'),
    `tema e tag classificam para o mesmo Sistema: ${confirmed.out}`);
  assert.ok(confirmedLines.includes('sem fonte · 1 run(s) com lacuna declarada e fonte vault como evidência'),
    `o relatório conta os runs sem fonte: ${confirmed.out}`);
  assert.ok(confirmedLines.includes('verificadas · 1 run(s) com seção Verificação; 3 marcada(s) legacy-unverified'),
    `o relatório separa verificado de legacy-unverified: ${confirmed.out}`);
  assert.match(confirmed.out, /4 run record\(s\) v2 · 4 gravado\(s\) · 0 já no ledger/,
    `a rodada confirmada reporta o que gravou: ${confirmed.out}`);
  const records = ledger(vaultRoot);
  assert.equal(records.length, 4, 'um Run Record por sessão classificada');
  for (const record of records) {
    assert.deepEqual(validateRunRecord(record), [],
      `o Run Record gerado passa no validador do protocolo sem ajuste: ${record.run_id}`);
    assert.equal(record.protocol_version, 2);
    assert.equal(record.status, 'completed');
    assert.equal(record.human_decision, 'pending',
      'sem aprovação registrada, a decisão humana fica pendente — nunca aprovada');
    assert.equal(record.privacy.content_shared_with_inevita, false);
    assert.equal(record.system_version, record.context_snapshot.system_contract_version,
      'o snapshot carrega a versão do contrato que rodou');
    assert.ok(record.context_snapshot.accesses.length >= 1, 'todo snapshot tem pelo menos um acesso');
    const declared = new Set(record.source_refs.map((ref) => `${ref.role}:${ref.id}`));
    for (const access of record.context_snapshot.accesses) {
      assert.ok(declared.has(`${access.source_ref.role}:${access.source_ref.id}`),
        'cada acesso do snapshot também aparece em source_refs');
    }
    assert.equal(record.output_refs.length, 1, 'o output é só a referência da nota de sessão');
    assert.match(record.output_refs[0], /^ai\/sessions\/\d{4}-\d{2}-\d{2}-.+\.md$/);
    assert.ok(!JSON.stringify(record).includes('trabalho da sessão'),
      'nenhum pedaço do conteúdo da sessão entra no recibo');
  }

  const byRef = new Map(records.map((record) => [record.output_refs[0], record]));
  const ingestao = byRef.get('ai/sessions/2026-07-06-ingestao-gerados.md');
  assert.equal(ingestao.system_id, 'ingerir', 'tema ingestao* classifica como ingerir');
  assert.deepEqual(ingestao.context_snapshot.accesses.map((access) => access.source_ref.id), ['web'],
    'a URL no Log de agentes vira o acesso à fonte web declarada pelo Sistema');
  assert.deepEqual(ingestao.context_snapshot.gaps, [], 'com fonte no log, não há lacuna');
  assert.deepEqual(ingestao.entity_refs, [
    { role: 'nota-relacionada', id: 'popcode' },
    { role: 'nota-relacionada', id: 'conteudo' },
  ], 'related_to vira entity_refs com slug, sem acento e sem caminho');
  assert.equal(ingestao.started_at, '2026-07-06T12:00:00.000Z',
    'a nota só tem data; o instante é meio-dia UTC, para o Console não mostrar a sessão no dia anterior');
  assert.equal(ingestao.completed_at, ingestao.started_at);
  assert.equal(ingestao.eval.passed, null, 'sessão sem Verificação fica com eval neutro');
  assert.equal(ingestao.extensions.verification_state, 'legacy-unverified',
    'sem evidência de verificação, o recibo sai marcado');

  const dailyRun = byRef.get('ai/sessions/2026-07-06-daily.md');
  assert.equal(dailyRun.system_id, 'daily', 'tag diario classifica como daily');
  assert.deepEqual(dailyRun.context_snapshot.accesses.map((access) => access.source_ref.id).sort(),
    ['clickup', 'gmail', 'google-calendar'],
    'as ferramentas do Log de agentes viram acessos, filtradas pelas fontes do contrato');
  assert.equal(dailyRun.context_snapshot.accesses[0].assurance, 'exported',
    'histórico importado é evidência exportada, nunca garantida em runtime');

  const verified = byRef.get('ai/sessions/2026-07-07-consolidacao.md');
  assert.equal(verified.system_id, 'daily', 'tag daily classifica como daily');
  assert.equal(verified.eval.passed, true, 'seção Verificação com conteúdo liga eval.passed');
  assert.equal(verified.extensions.verification_state, 'legacy-verified');
  assert.equal(verified.human_decision, 'pending',
    'verificada não é aprovada: a decisão humana continua pendente');

  const noSource = byRef.get('ai/sessions/2026-07-08-ingestao-sem-daily.md');
  assert.deepEqual(noSource.context_snapshot.accesses.map((access) => access.source_ref.id), ['vault'],
    'sem daily do dia, o run declara a fonte vault — a própria nota é a evidência');
  assert.deepEqual(noSource.context_snapshot.gaps, [{
    source_role: 'notas-conectadas', reason_code: 'daily-do-dia-ausente', detail_ref: null,
  }], 'a ausência da daily sai como lacuna declarada, com o papel que o contrato usa para o vault');

  assert.equal(byRef.has('ai/sessions/2026-07-09-proposta-unifor.md'), false,
    'sessão sem Sistema não vira Run Record nem Sistema inventado');
  assert.equal(existsSync(join(vaultRoot, '.cerebro', 'contracts', 'systems', 'sessao-livre.json')), false,
    'o balde sessao-livre nunca cria System Contract');

  // ── 3. o Console mostra os runs e a Recuperação conta os snapshots ──────────────
  const api = await readApi(vaultRoot, {
    runs: '/api/runs',
    anatomy: '/api/anatomy',
    console: '/api/console',
  });
  assert.equal(api.runs.runs.length, 4, 'Julgamento › Runs mostra os quatro runs importados');
  assert.deepEqual(api.runs.issues, [], 'o ledger importado não gera issue em Runs');
  const perSystem = {};
  for (const run of api.runs.runs) perSystem[run.system_ref] = (perSystem[run.system_ref] || 0) + 1;
  assert.deepEqual(perSystem, { daily: 2, ingerir: 2 }, 'Runs por Sistema conta certo');
  const consoleRun = api.runs.runs.find((run) => run.run_id === ingestao.run_id);
  assert.equal(consoleRun.origin, 'run-record', 'o run nasce do Run Record, não de recibo de rotina');
  assert.equal(consoleRun.context.sources, 1, 'o Console mostra as fontes usadas no run');
  assert.equal(consoleRun.human_decision, 'pending', 'o Console nunca mostra aprovação inventada');
  assert.equal(api.runs.runs.filter((run) => run.human_decision === 'approved').length, 0,
    'nenhum run importado conta como aprovado');
  assert.equal(api.runs.runs.filter((run) => run.eval_passed === true).length, 1,
    'só a sessão com Verificação conta como eval passado');

  assert.equal(api.anatomy.retrieval_health.snapshots.runs, 4,
    'Cérebro › Recuperação passa a contar os runs do histórico');
  assert.equal(api.anatomy.retrieval_health.snapshots.observed, 4,
    'todos os runs importados têm context snapshot observado');
  assert.equal(api.anatomy.retrieval_health.snapshots.complete, 4,
    'todos os snapshots importados estão completos');
  assert.equal(api.anatomy.retrieval_health.snapshots.gaps, 1,
    'a lacuna declarada aparece na Recuperação');
  assert.deepEqual(api.console.issues, [], 'nenhum recibo importado derruba a tela Saúde');

  // ── 4. reimportar não duplica ───────────────────────────────────────────────────
  const again = sync(vaultRoot, '--confirm');
  assert.match(again.out, /4 run record\(s\) v2 · 0 gravado\(s\) · 4 já no ledger/,
    `a segunda rodada não grava nada: ${again.out}`);
  assert.deepEqual(ledger(vaultRoot).map((record) => record.run_id).sort(),
    records.map((record) => record.run_id).sort(),
    'o ledger continua com os mesmos run_ids depois de reimportar');
  assert.equal(ledger(vaultRoot).length, 4, 'nenhuma linha nova no ledger');

  // ── 5. PII é recusada, nunca gravada ───────────────────────────────────────────
  const piiNote = '2026-07-10-ingestao-ficha-123.456.789-09.md';
  write(join(sessions, piiNote), session({ tags: ['sessao', 'ingestao'], created: '2026-07-10' }));
  const withPii = sync(vaultRoot, '--confirm');
  assert.equal(withPii.code, 1, 'sessão com padrão de PII faz a importação sair com erro');
  assert.match(withPii.out, /recusada por PII · ai\/sessions\/2026-07-10-ingestao-ficha-123\.456\.789-09\.md · .*cpf/,
    `a recusa diz qual nota e qual padrão: ${withPii.out}`);
  assert.equal(ledger(vaultRoot).length, 4, 'a sessão recusada não entra no ledger');
  rmSync(join(sessions, piiNote));

  // ── 6. instalação INEVITA sem vault segue igual ─────────────────────────────────
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3, runLedger: LEDGER.split('\\').join('/') });
  const inevitaRecord = JSON.parse(readFileSync(resolve(here, '..', 'protocol', 'examples', 'run-record.v2.json'), 'utf8'));
  write(join(inevitaRoot, LEDGER), `${JSON.stringify(inevitaRecord)}\n`);
  const inevita = sync(inevitaRoot, '--confirm');
  assert.equal(inevita.code, 0, 'instalação sem vault não é erro');
  assert.match(inevita.out, /este Cérebro não declara vault no layout; nada a importar/);
  assert.deepEqual(ledger(inevitaRoot), [inevitaRecord],
    'o ledger da INEVITA continua byte a byte o mesmo');

  console.log('✓ vault:sync importa as sessões do vault como Run Records v2 e o Console mostra Runs por Sistema e a Recuperação');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
