#!/usr/bin/env node

// Seam único do ticket 12: vault sintético → `vault-compile` + `vault-import-journal`
// (CLIs) → API HTTP do Console → julgamento de uma execução importada → Aprendizado.
// Verifica comportamento externo: o que a API devolve, o que fica gravado e onde.
//
// Cobre: a saída de um recibo importado abre; o julgamento humano grava um Judgment
// Receipt válido pelo validador do protocolo; a execução sai da caixa de pendências;
// `/api/anatomy` mostra o julgamento em Aprendizado (contagem por veredicto, últimos
// julgamentos e pendências); veredicto inválido é recusado sem gravar; nada é escrito
// fora de `.cerebro/runtime` (nenhuma nota do vault é tocada); instalação INEVITA sem
// vault continua com os mesmos números de Aprendizado.
//
// Run Record de sessão (ledger v2) não entra aqui: o Console não oferece julgamento
// para Run Record, e este ticket não inventa um tipo novo de julgamento.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';
import { validateJudgmentReceipt } from './lib/judgment-protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const COMPILE = join(here, 'vault-compile.mjs');
const IMPORT = join(here, 'vault-import-journal.mjs');
const JUDGMENTS = join('.cerebro', 'runtime', 'judgments');
const SECRET_BODY = 'segredo do corpo da nota que nunca pode sair do vault';
const vaultRoot = mkdtempSync(join(tmpdir(), 'vault-judgment-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'vault-judgment-inevita-'));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function run(script, root, ...flags) {
  const result = spawnSync(process.execPath, [script, `--root=${root}`, ...flags], { encoding: 'utf8' });
  return { out: result.stdout || '', err: result.stderr || '', code: result.status };
}

// Impressão de tudo que existe fora do runtime: caminho + hash do conteúdo. É a prova de
// que julgar não escreve em nota nenhuma do vault.
function fingerprintOutsideRuntime(root) {
  const runtime = join(root, '.cerebro', 'runtime');
  const seen = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (path === runtime) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        seen[relative(root, path)] = `${statSync(path).size}:${createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)}`;
      }
    }
  };
  walk(root);
  return seen;
}

function judgmentFiles(root) {
  const base = join(root, JUDGMENTS);
  if (!existsSync(base)) return [];
  return readdirSync(base).sort().flatMap((receiptId) => readdirSync(join(base, receiptId)).sort()
    .map((name) => join(base, receiptId, name)));
}

// Sessão do Console numa única conexão: cookie, CSRF, GETs e POSTs na mesma instância.
async function withConsole(root, work) {
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
    const session = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
    assert.equal(session.status, 200, '/api/session precisa responder 200');
    const { csrf_token: csrf } = await session.json();
    const get = async (path) => {
      const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
      return { status: response.status, body: await response.json() };
    };
    const post = async (path, payload) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Cerebro-Csrf': csrf },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    };
    return await work({ get, post });
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

const SYSTEM_NOTE = `---
type: System
system_id: daily
nome: Daily do dia
versao: 0.1.0
status: Ativo
area: "[[hugo-os]]"
resultado: a daily note do dia com prioridades, agenda e loops abertos
nao_sucesso: entregar sem a evidencia que o gate pede
entrega: daily-aprovada
pronto_quando: a nota de saida existe com a evidencia citada
dono: "[[hugo-doria]]"
gate_humano: o dono confirma o resultado antes de contar como aprovado
gatilho: agendado
quando: rotina de nuvem
fontes:
  - papel: agenda
    fonte: "[[google-calendar]]"
    obrigatoria: nao
    acesso: leitura
    frescor: 1 dia
    finalidade: alimentar o sistema daily
  - papel: notas
    fonte: "[[vault]]"
    obrigatoria: sim
    acesso: escrita-com-aprovacao
    frescor: 1 dia
    finalidade: alimentar o sistema daily
etapas:
  - estado: escrito
    entrada: contexto do periodo
    saida: a nota de saida do periodo
    gate: nenhum fato entra sem fonte real
gates:
  - nenhum fato entra sem fonte real
perguntas_humanas:
  - o resultado é o que o dono esperava?
medida: daily-aprovada
paradas:
  - parar se a nota do periodo ja existir
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

function daily(date) {
  return `---
type: Note
tags: [diario]
created: ${date}
---

# ${date}

## Prioridades

- ${SECRET_BODY}

## Log de agentes

- Claude Code (rotina diária automática): rodou a rotina e gravou a nota.
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
  write(join(vaultRoot, 'sistema', 'fontes', 'google-calendar.md'), dataSource('google-calendar', 'Agenda do dono'));
  write(join(vaultRoot, 'sistema', 'fontes', 'vault.md'), dataSource('vault', 'Notas do vault', 'leitura-escrita'));
  write(join(vaultRoot, 'sistema', 'sistemas', 'daily.md'), SYSTEM_NOTE);
  write(join(vaultRoot, 'sistema', 'rotinas', 'daily.md'), DAILY_ROUTINE);
  write(join(vaultRoot, 'journal', '2026-07-06.md'), daily('2026-07-06'));
  write(join(vaultRoot, 'journal', '2026-07-07.md'), daily('2026-07-07'));

  const compiled = run(COMPILE, vaultRoot, '--confirm');
  assert.equal(compiled.code, 0, `o vault sintético compila sem erro: ${compiled.out}${compiled.err}`);
  const imported = run(IMPORT, vaultRoot, '--confirm');
  assert.equal(imported.code, 0, `a importação do journal sai com código 0: ${imported.out}${imported.err}`);

  const before = fingerprintOutsideRuntime(vaultRoot);
  assert.deepEqual(judgmentFiles(vaultRoot), [], 'nenhuma execução importada chega julgada');

  // ── 1. a execução importada abre, aceita julgamento e sai da caixa ──────────────
  const first = await withConsole(vaultRoot, async ({ get, post }) => {
    const before2 = await get('/api/console');
    assert.equal(before2.status, 200);
    assert.equal(before2.body.counts.judgments, 2, 'as duas dailies importadas entram pendentes');
    const pending = before2.body.judgments.filter((item) => item.judgment.status === 'pending');
    assert.equal(pending.length, 2, 'nenhuma execução importada aparece julgada');
    const target = pending.find((item) => item.output_ref.includes('.pointer.md')) || pending[0];

    const output = await get(`/api/runs/${target.receipt_id}/output`);
    assert.equal(output.status, 200, `a saída da execução importada abre: ${JSON.stringify(output.body)}`);
    assert.equal(output.body.judgment.summary.status, 'pending');

    // veredicto inválido é recusado antes de gravar
    const invalid = await post(`/api/runs/${target.receipt_id}/judgments`, {
      confirm: true, approved_by: 'hugo', verdict: 'aprovadissimo', action_intent: 'none', note: '',
    });
    assert.equal(invalid.status, 400, 'veredicto fora do protocolo é recusado');
    assert.equal(invalid.body.reason_code, 'judgment-verdict-invalid');
    assert.deepEqual(judgmentFiles(vaultRoot), [], 'veredicto inválido não grava recibo');

    const recorded = await post(`/api/runs/${target.receipt_id}/judgments`, {
      confirm: true,
      approved_by: 'hugo',
      verdict: 'changes-requested',
      action_intent: 'none',
      note: 'a daily importada perdeu os loops abertos do dia',
    });
    assert.equal(recorded.status, 200, `julgar uma execução importada responde 200: ${JSON.stringify(recorded.body)}`);
    assert.equal(recorded.body.status, 'recorded');
    assert.equal(recorded.body.summary.status, 'decided');
    assert.equal(recorded.body.summary.verdict, 'changes-requested');
    assert.equal(recorded.body.external_action_executed, false);
    return { receiptId: target.receipt_id, runId: target.run_id, systemRef: target.system_ref };
  });

  // ── 2. o recibo gravado é válido e mora só no runtime ──────────────────────────
  const files = judgmentFiles(vaultRoot);
  assert.equal(files.length, 1, 'um Judgment Receipt por julgamento');
  const receipt = JSON.parse(readFileSync(files[0], 'utf8'));
  assert.deepEqual(validateJudgmentReceipt(receipt), [],
    `o Judgment Receipt da execução importada passa no validador: ${JSON.stringify(receipt)}`);
  assert.equal(receipt.receipt_id, first.receiptId);
  assert.equal(receipt.run_id, first.runId);
  assert.equal(receipt.verdict, 'changes-requested');
  assert.equal(receipt.actor_ref, 'hugo');
  assert.equal(receipt.privacy.output_recorded, false);
  assert.equal(receipt.privacy.note_private, true);
  assert.ok(!JSON.stringify(receipt).includes(SECRET_BODY), 'o corpo da nota nunca entra no julgamento');
  assert.ok(files[0].includes(join(JUDGMENTS, first.receiptId)),
    'o recibo mora em .cerebro/runtime/judgments/<receipt_id>/');
  assert.deepEqual(fingerprintOutsideRuntime(vaultRoot), before,
    'julgar não escreve em nenhuma nota do vault nem em contrato');

  // ── 3. a pendência cai e o Aprendizado mostra o julgamento ─────────────────────
  await withConsole(vaultRoot, async ({ get }) => {
    const model = await get('/api/console');
    assert.equal(model.body.counts.judgments, 1, 'a execução julgada sai da caixa de pendências');
    const judged = model.body.judgments.find((item) => item.receipt_id === first.receiptId);
    assert.equal(judged.judgment.status, 'decided');
    assert.equal(judged.judgment.verdict, 'changes-requested');
    assert.deepEqual(model.body.issues, [], 'o julgamento de um recibo importado não gera issue');

    const anatomy = await get('/api/anatomy');
    assert.equal(anatomy.status, 200);
    const learning = anatomy.body.control_center.learning;
    assert.equal(learning.judgments, 1, 'Aprendizado conta o julgamento gravado');
    assert.deepEqual(learning.by_verdict, { approved: 0, 'changes-requested': 1, rejected: 0 },
      'Aprendizado separa a contagem por veredicto');
    assert.equal(learning.pending, 1, 'Aprendizado mostra quantas execuções ainda esperam martelo');
    assert.equal(learning.latest.length, 1, 'Aprendizado lista o julgamento mais recente');
    const [latest] = learning.latest;
    assert.equal(latest.verdict, 'changes-requested');
    assert.equal(latest.decided_at, receipt.decided_at, 'a linha do Aprendizado traz a data da decisão');
    assert.equal(latest.receipt_id, first.receiptId);
    assert.equal(latest.run_id, first.runId);
    assert.equal(latest.system_ref, first.systemRef, 'a linha diz de qual Sistema é a execução julgada');
    assert.equal(latest.note, 'a daily importada perdeu os loops abertos do dia',
      'a nota curta do julgamento aparece');
    assert.deepEqual(learning.reconciliation, { orphan_judgments: 0, duplicate_judgments: 0 },
      'julgar uma execução importada não vira inconsistência de reconciliação');
    assert.equal(anatomy.body.control_center.privacy.content_exposed, false);
  });

  // ── 3b. um recibo ilegível não apaga o Aprendizado das outras execuções ────────
  // O arquivo quebrado é um recibo de Rotina a menos, não o fim da leitura: a pendência,
  // a reconciliação e o Sistema de cada julgamento continuam saindo dos recibos válidos,
  // e o arquivo culpado aparece em "o que pede cuidado".
  write(join(vaultRoot, '.cerebro', 'runtime', 'receipts', 'routines', 'quebrado.json'), '{quebrado');
  await withConsole(vaultRoot, async ({ get }) => {
    const anatomy = await get('/api/anatomy');
    assert.equal(anatomy.status, 200, 'recibo ilegível não derruba /api/anatomy');
    const learning = anatomy.body.control_center.learning;
    assert.equal(learning.pending, 1, 'a pendência continua sendo contada pelos recibos legíveis');
    assert.equal(learning.latest[0].system_ref, first.systemRef,
      'a linha do Aprendizado continua dizendo de qual Sistema é a execução julgada');
    assert.deepEqual(learning.reconciliation, { orphan_judgments: 0, duplicate_judgments: 0 },
      'recibo ilegível não transforma julgamento de execução importada em órfão');
    const care = anatomy.body.control_center.overview.care;
    assert.deepEqual(care.find((item) => item.code === 'judgment-reconciliation'), undefined,
      'sem órfão, a reconciliação não entra no que pede cuidado');
    assert.deepEqual(care.find((item) => item.code === 'routine-receipt-invalid'),
      { code: 'routine-receipt-invalid', count: 1 },
      'o recibo ilegível aparece nomeado em "o que pede cuidado"');
  });
  rmSync(join(vaultRoot, '.cerebro', 'runtime', 'receipts', 'routines', 'quebrado.json'));

  // ── 4. segundo julgamento: aprovar sem nota e o histórico continua ─────────────
  await withConsole(vaultRoot, async ({ get, post }) => {
    const model = await get('/api/console');
    const pending = model.body.judgments.find((item) => item.judgment.status === 'pending');
    const approved = await post(`/api/runs/${pending.receipt_id}/judgments`, {
      confirm: true, approved_by: 'hugo', verdict: 'approved', action_intent: 'none', note: '',
    });
    assert.equal(approved.status, 200, `aprovar sem nota é permitido: ${JSON.stringify(approved.body)}`);
    const anatomy = await get('/api/anatomy');
    const learning = anatomy.body.control_center.learning;
    assert.deepEqual(learning.by_verdict, { approved: 1, 'changes-requested': 1, rejected: 0 });
    assert.equal(learning.pending, 0, 'sem execução pendente, a caixa fica vazia');
    assert.equal(learning.latest.length, 2, 'os dois julgamentos aparecem');
    assert.equal(learning.latest[0].decided_at >= learning.latest[1].decided_at, true,
      'o julgamento mais recente vem primeiro');
  });

  // ── 5. instalação INEVITA sem vault segue com os mesmos números ────────────────
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3 });
  const inevitaBefore = fingerprintOutsideRuntime(inevitaRoot);
  await withConsole(inevitaRoot, async ({ get }) => {
    const anatomy = await get('/api/anatomy');
    assert.equal(anatomy.status, 200, 'instalação sem vault continua respondendo Aprendizado');
    const learning = anatomy.body.control_center.learning;
    assert.equal(learning.judgments, 0);
    assert.equal(learning.corrections, 0);
    assert.equal(learning.outcomes, 0);
    assert.equal(learning.candidates, 0);
    assert.equal(learning.promotions.measured, false);
    assert.deepEqual(learning.reconciliation, { orphan_judgments: 0, duplicate_judgments: 0 });
    assert.deepEqual(learning.by_verdict, { approved: 0, 'changes-requested': 0, rejected: 0 });
    assert.equal(learning.pending, 0);
    assert.deepEqual(learning.latest, []);
  });
  assert.deepEqual(fingerprintOutsideRuntime(inevitaRoot), inevitaBefore,
    'ler Aprendizado numa instalação INEVITA não escreve nada');

  console.log('✓ o Hugo julga uma execução importada no Console, o recibo é válido, a pendência cai e o Aprendizado mostra o julgamento');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
