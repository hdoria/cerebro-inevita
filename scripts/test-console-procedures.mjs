#!/usr/bin/env node

// Leitor de procedimentos (SOPs) testado pelo seam HTTP contra um Cérebro sintético:
// /api/procedures devolve cada procedimento com fluxos, passos numerados, papel,
// ramos de decisão com o passo-alvo e critério de pronto. Procedimento escrito antes
// da convenção (só passos numerados) continua virando fluxo linear, nota privada sai
// sem título e sem passos, e instalação INEVITA sem vault responde available:false.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';

const vaultRoot = mkdtempSync(join(tmpdir(), 'console-procedures-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'console-inevita-procedures-'));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function readApi(root, paths) {
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
    const values = {};
    for (const [name, path] of Object.entries(paths)) {
      const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, `${path} precisa responder 200`);
      values[name] = await response.json();
    }
    // Sem cookie de sessão, nenhum procedimento sai do servidor.
    const anonymous = await fetch(`${base}/api/procedures`);
    assert.equal(anonymous.status >= 400, true, '/api/procedures exige sessão');
    return values;
  } finally {
    await new Promise((closed) => instance.server.close(closed));
  }
}

const byslug = (list, slug) => list.find((item) => item.slug === slug);

try {
  // Cérebro em modo vault, com a pasta de procedimentos declarada no layout.
  write(join(vaultRoot, 'AGENTS.md'), '# Vault sintético\n');
  write(join(vaultRoot, '.git', 'info', 'exclude'), '# local excludes\n');
  assert.equal(bootstrapLegacyConsole(vaultRoot, { confirm: true }).status, 'created');
  const layoutPath = join(vaultRoot, '.cerebro', 'layout.json');
  write(layoutPath, {
    ...JSON.parse(readFileSync(layoutPath, 'utf8')),
    knowledgeRoot: '.',
    vault: { daily: 'journal', inbox: 'inbox', projects: 'projects', areas: 'areas', procedures: 'procedures' },
  });

  // (a) procedimento escrito antes da convenção: passos numerados, sem papel e sem ramo.
  write(join(vaultRoot, 'procedures', 'weekly-review.md'), `---
type: Procedure
status: Ativo
updated: 2026-09-20
---

# Weekly review

Revisão semanal.

## Passos

1. Ler as daily notes da semana em \`journal/\`.
2. Listar loops abertos e pendências.
3. Rascunhar as prioridades da semana seguinte.

## Critério de pronto

Nota semanal gravada, com loops abertos e prioridades.
`);

  // (b) procedimento na convenção: papel por passo, dois ramos num passo e critério em bullets.
  // (c) e uma segunda seção numerada, que é outro fluxo do mesmo procedimento.
  write(join(vaultRoot, 'procedures', 'triagem-inbox.md'), `---
type: Procedure
status: Ativo
sistema:
  - "[[inbox-zero|Inbox zero]]"
updated: 2026-09-28
---

# Triagem do inbox

Mantém o inbox pequeno.

## Passos

1. Quem: agente: ler o inbox em \`inbox/\` e dar H1 claro a cada captura.
2. Quem: agente: definir o \`type\` da nota ([[type]] decide a pasta).
3. Quem: Hugo: decidir o destino da captura ambígua.
   - Se é captura de pessoa → passo 4
   - Se é link solto sem instrução → passo 5
4. Quem: agente: mover para a pasta do type e marcar \`_organized: true\`.
5. Tratar como pedido de ingestão. Se a fonte não abrir -> passo 3.

## Material novo

1. Quem: agente: gerar o resumo da fonte nova.
2. Ligar a fonte ao projeto que a pediu.

## Comunicação

- Entrega que afeta cliente fecha com mensagem pronta.

## Critério de pronto

- Inbox vazio ou só com item que depende de decisão do Hugo.
- Toda captura movida tem \`type\` e \`_organized: true\`.
`);

  // (d) procedimento privado: entra na lista sem título, sem caminho e sem passos.
  write(join(vaultRoot, 'procedures', 'ficha-de-cliente.md'), `---
type: Procedure
visibility: private
---

# Ficha de um cliente nominal

## Passos

1. Abrir a nota da pessoa.
2. Conferir a ficha cadastral.
`);

  // Rascunho e anexo não entram.
  write(join(vaultRoot, 'procedures', '_rascunho.md'), '# Rascunho\n\n## Passos\n\n1. nada\n');
  write(join(vaultRoot, 'procedures', 'anexo.txt'), 'nada\n');

  const vaultApi = await readApi(vaultRoot, {
    procedures: '/api/procedures',
    revealed: '/api/procedures?reveal=1',
  });

  const model = vaultApi.procedures;
  assert.equal(model.available, true, 'em modo vault, a tela Procedimentos está disponível');
  assert.equal(model.folder, 'procedures', 'a pasta lida é a declarada no layout');
  assert.equal(model.procedures.length, 3, 'rascunho `_` e anexo não-markdown ficam de fora');
  assert.deepEqual(model.counts, { procedures: 3, flows: 4, steps: 12 },
    'contagem: 3 procedimentos, 4 fluxos (1 + 2 + 1 privado) e 12 passos');

  // (a) linear: um fluxo, passos sem papel e sem ramo, critério em prosa vira item.
  const weekly = byslug(model.procedures, 'weekly-review');
  assert.equal(weekly.title, 'Weekly review', 'o título vem do H1 da nota');
  assert.equal(weekly.path, 'procedures/weekly-review.md');
  assert.equal(weekly.private, false);
  assert.equal(weekly.flows.length, 1, 'procedimento antigo da convenção vira um fluxo único');
  assert.equal(weekly.flows[0].title, 'Passos');
  assert.deepEqual(weekly.flows[0].steps.map((step) => [step.n, step.role, step.branches.length]),
    [[1, null, 0], [2, null, 0], [3, null, 0]], 'fluxo linear: sem papel e sem ramo');
  assert.equal(weekly.flows[0].steps[0].text, 'Ler as daily notes da semana em `journal/`.');
  assert.deepEqual(weekly.done, ['Nota semanal gravada, com loops abertos e prioridades.'],
    'critério em prosa continua sendo lido');

  // (b) convenção: papel, ramos com passo-alvo e critério em bullets.
  const triagem = byslug(model.procedures, 'triagem-inbox');
  assert.deepEqual(triagem.sistema_refs, [{ slug: 'inbox-zero', title: 'Inbox zero' }],
    'o alvo do wikilink fica disponível para ligar, com o rótulo para mostrar');
  const passos = triagem.flows[0];
  assert.equal(passos.title, 'Passos');
  assert.deepEqual(passos.steps.map((step) => [step.n, step.role]),
    [[1, 'agente'], [2, 'agente'], [3, 'Hugo'], [4, 'agente'], [5, null]],
    'o prefixo `Quem: <papel>:` vira o papel do passo');
  assert.equal(passos.steps[0].text, 'ler o inbox em `inbox/` e dar H1 claro a cada captura.',
    'o texto do passo sai sem o prefixo de papel');
  assert.equal(passos.steps[1].text, 'definir o `type` da nota (type decide a pasta).',
    'wikilink sai sem sintaxe para a tela');
  assert.deepEqual(passos.steps[2].branches, [
    { condition: 'é captura de pessoa', target: 4 },
    { condition: 'é link solto sem instrução', target: 5 },
  ], 'um passo aceita vários ramos, cada um com condição e passo-alvo');
  assert.deepEqual(passos.steps[2].details, [], 'sub-bullet que é só ramo não vira detalhe');
  assert.deepEqual(passos.steps[4].branches, [{ condition: 'a fonte não abrir', target: 3 }],
    'ramo escrito com -> no meio do passo também é lido');
  assert.deepEqual(triagem.done, [
    'Inbox vazio ou só com item que depende de decisão do Hugo.',
    'Toda captura movida tem `type` e `_organized: true`.',
  ]);

  // (c) segunda seção numerada é outro fluxo; seção só com bullets não é fluxo.
  assert.deepEqual(triagem.flows.map((flow) => [flow.id, flow.title, flow.steps.length]),
    [['passos', 'Passos', 5], ['material-novo', 'Material novo', 2]],
    'seção numerada vira fluxo; Comunicação (só bullets) e Critério de pronto não');

  // (d) privado: sem título, sem caminho e sem passos; a contagem continua honesta.
  const privada = byslug(model.procedures, 'ficha-de-cliente');
  assert.equal(privada.private, true);
  assert.equal(privada.title, null, 'o título da nota privada não sai do servidor por padrão');
  assert.equal(privada.path, null, 'o caminho revelaria o título, então também fica de fora');
  assert.deepEqual(privada.flows, [], 'o passo revelaria o conteúdo da nota privada');
  assert.deepEqual(privada.done, []);
  assert.equal(privada.step_count, 2, 'a contagem diz que existem passos sem mostrá-los');

  // Revelar é explícito.
  const revealed = byslug(vaultApi.revealed.procedures, 'ficha-de-cliente');
  assert.equal(revealed.title, 'Ficha de um cliente nominal', 'com ?reveal=1 o título privado é enviado');
  assert.equal(revealed.flows[0].steps.length, 2, 'com ?reveal=1 os passos aparecem');

  // Instalação INEVITA sem a chave `vault`: a tela não existe.
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3 });
  write(join(inevitaRoot, 'procedures', 'qualquer.md'), '# Qualquer\n\n## Passos\n\n1. nada\n');
  const inevitaApi = await readApi(inevitaRoot, { procedures: '/api/procedures' });
  assert.equal(inevitaApi.procedures.available, false, 'sem a chave vault, /api/procedures é indisponível');
  assert.equal(inevitaApi.procedures.procedures, undefined, 'instalação INEVITA não ganha lista de procedimentos');

  console.log('✓ /api/procedures lê fluxos, papéis, ramos e critério de pronto sem expor nota privada');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
