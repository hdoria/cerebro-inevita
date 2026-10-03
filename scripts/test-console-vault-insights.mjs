#!/usr/bin/env node

// Decisões, lições e recall lidos do vault, testados pelo seam HTTP contra um Cérebro
// sintético: /api/vault-insights devolve a linha do tempo de decisões por mês (mais
// novo primeiro, com a nota afetada e o log de sessão), as lições por tema com
// contagem e as três últimas de cada tema, as regras promovidas ao MEMORY e o último
// resultado do teste de recall. Nenhum corpo bruto sai do servidor, nota privada não
// entrega entrada, e instalação INEVITA sem vault responde available:false.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';

const vaultRoot = mkdtempSync(join(tmpdir(), 'console-insights-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'console-inevita-insights-'));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
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
    // Sem cookie de sessão, aprendizado nenhum sai do servidor.
    const anonymous = await fetch(`${base}/api/vault-insights`);
    assert.equal(anonymous.status >= 400, true, '/api/vault-insights exige sessão');
    return values;
  } finally {
    await new Promise((closed) => instance.server.close(closed));
  }
}

const bySlug = (list, slug) => list.find((item) => item.slug === slug);

try {
  write(join(vaultRoot, 'AGENTS.md'), '# Vault sintético\n');
  write(join(vaultRoot, '.git', 'info', 'exclude'), '# local excludes\n');
  assert.equal(bootstrapLegacyConsole(vaultRoot, { confirm: true }).status, 'created');
  const layoutPath = join(vaultRoot, '.cerebro', 'layout.json');
  write(layoutPath, {
    ...JSON.parse(readFileSync(layoutPath, 'utf8')),
    knowledgeRoot: '.',
    vault: {
      daily: 'journal',
      inbox: 'inbox',
      projects: 'projects',
      areas: 'areas',
      decisions: 'decisions',
      learnings: 'resources/learnings',
      recall: 'resources/teste-de-recall.md',
      memory: 'MEMORY.md',
    },
  });

  // Dois meses de decisões, no formato de append do log mensal.
  write(join(vaultRoot, 'decisions', '2026-09.md'), `---
type: Note
tags: [decisoes]
updated: 2026-09-30
---

# Decisões de setembro de 2026

Log de append do mês.

## Entradas

- **2026-09-02 · a peça foi para o repo existente, não para repo próprio**. Contexto: o repo já guarda material do mesmo pilar. Notas: [[nevoni]], [[delta-plataforma]], log [[2026-09-02-nevoni-versionamento]].
- **2026-09-16 · o blog publica só o que tiver \`status: pronto\`**. Contexto: conteúdo em Markdown no repo, lotes controlados por arquivo. Notas: [[delta-academy]], log [[2026-09-16-blog-delta]].
`);
  write(join(vaultRoot, 'decisions', '2026-10.md'), `---
type: Note
tags: [decisoes]
updated: 2026-10-03
---

# Decisões de outubro de 2026

## Entradas

- **2026-10-01 · a margem do contrato passou a 6,4% por mês**. Contexto: o teto por cargo mudou e a conta foi refeita. Notas: [[tse-pe-90015-2026]], log [[2026-10-01-tse-margem]].
`);
  // Mês privado: a contagem é honesta, a entrada não sai.
  write(join(vaultRoot, 'decisions', '2026-08.md'), `---
type: Note
visibility: private
---

# Decisões de agosto de 2026

- **2026-08-10 · decisão com nome de pessoa**. Contexto: ficha cadastral. Notas: [[alguem]].
`);
  // Rascunho não entra.
  write(join(vaultRoot, 'decisions', '_rascunho.md'), '# Rascunho\n\n- **2026-07-01 · nada**. Contexto: nada.\n');

  // Três temas de lição, no formato de bullet com data e regra.
  write(join(vaultRoot, 'resources', 'learnings', 'escrita-e-voz.md'), `---
type: Reference
updated: 2026-10-02
---

# Lições de escrita e voz

Post, carrossel, legenda e título.

- **2026-09-28 · imperativo na forma de você**: o Hugo corrigiu a conjugação. **Why**: a voz é a dele. **How to apply**: varra o artefato antes de entregar.
- **2026-09-20 · título afirma a regra**: o título dizia o erro. **Why**: regra se lembra. **How to apply**: escreva a regra.
  - caso: [[post-spacex]]
- **2026-09-10 · hook sem sustentação fica fora**: faltava fonte. **Why**: não inventar. **How to apply**: confira o estudo.
- **2026-08-30 · sem emoji em nome do Hugo**: a legenda saiu com emoji. **Why**: a voz barra. **How to apply**: grep antes de publicar.
`);
  write(join(vaultRoot, 'resources', 'learnings', 'codigo-e-api.md'), `---
type: Reference
updated: 2026-10-01
---

# Lições de código e API

Código, API, config e CI.

- **2026-09-15 · inventariar antes de instalar**: instalei app que já existia. **Why**: gasta tempo. **How to apply**: inventarie com busca sem caixa.
  - caso: [[delta-academy]]
- **2026-09-09 · texto no HTML não é texto visível**: inventei nome de token. **Why**: grep passa com texto invisível. **How to apply**: abra o arquivo de tokens.
  - caso: [[coding-standards]]
`);
  write(join(vaultRoot, 'resources', 'learnings', 'verificacao.md'), `---
type: Reference
updated: 2026-10-03
---

# Lições de verificação

Afirmação negativa, output truncado e definição de pronto.

- **2026-10-02 · output truncado responde "não vi"**: usei head e conclui ausência. **Why**: negativa é caro. **How to apply**: diga o que consultou.
`);
  // Tema privado: o nome do arquivo é o próprio assunto, então nem ele sai do servidor.
  write(join(vaultRoot, 'resources', 'learnings', 'cliente-nominal.md'), `---
type: Reference
visibility: private
updated: 2026-10-02
---

# Lições de um cliente nominal

- **2026-09-30 · primeira**: nada. **Why**: nada. **How to apply**: nada.
- **2026-09-20 · segunda**: nada. **Why**: nada. **How to apply**: nada.
- **2026-09-10 · terceira**: nada. **Why**: nada. **How to apply**: nada.
`);
  write(join(vaultRoot, 'resources', 'learnings', '_novo.md'), '# Rascunho\n\n- **2026-10-03 · nada**: nada.\n');

  // MEMORY com seções: só a contagem e o título das regras promovidas.
  write(join(vaultRoot, 'MEMORY.md'), `---
type: Note
updated: 2026-10-03
---

# MEMORY

Regras de toda sessão.

**Afirmação negativa é a mais cara de errar.** "Não achei" não é "não existe". Busca truncada responde "não vi".

**Verificar antes de reportar.** Nada é pronto sem resultado de tool colado.

## Vault

Nota citada é nota linkada.
`);

  // Teste de recall com duas linhas de resultado.
  write(join(vaultRoot, 'resources', 'teste-de-recall.md'), `---
type: Reference
status: Aprovado
updated: 2026-10-03
---

# Teste de recall

A régua do cérebro.

## Resultados

| Data | Acertos | Parciais | Erros | Placar | Perguntas que falharam | O que consertar |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-27 | — | — | — | 85% | 2 (teto do TSE), 7 (projetos da Idens) | ligar a decisão do teto à nota do projeto |
| 2026-10-03 | 10 | 0 | 0 | 100% | nenhuma | gabarito da 2 atualizado |

## Para que pode servir

Separa crescer de melhorar.
`);

  const vaultApi = await readApi(vaultRoot, { insights: '/api/vault-insights' });
  const model = vaultApi.insights;
  assert.equal(model.available, true, 'em modo vault, o aprendizado do vault está disponível');

  // Decisões: por mês, mais novo primeiro, com a nota afetada e o log de sessão.
  const decisions = model.decisions;
  assert.equal(decisions.available, true);
  assert.equal(decisions.folder, 'decisions');
  assert.deepEqual(decisions.months.map((month) => month.month), ['2026-10', '2026-09', '2026-08'],
    'os meses saem do mais novo para o mais antigo');
  assert.deepEqual(decisions.counts, { months: 3, entries: 4 },
    'rascunho `_` fica de fora; o mês privado conta sem mostrar');
  const setembro = decisions.months.find((month) => month.month === '2026-09');
  assert.equal(setembro.title, 'Decisões de setembro de 2026', 'o título do mês vem do H1 da nota');
  assert.equal(setembro.path, 'decisions/2026-09.md');
  assert.equal(setembro.count, 2);
  assert.deepEqual(setembro.entries.map((entry) => entry.date), ['2026-09-16', '2026-09-02'],
    'dentro do mês a entrada mais nova vem primeiro');
  const entry = setembro.entries[1];
  assert.equal(entry.decision, 'a peça foi para o repo existente, não para repo próprio',
    'a linha da decisão sai sem a data e sem negrito');
  assert.equal(entry.context, 'o repo já guarda material do mesmo pilar.',
    'o contexto é uma linha, lido do prefixo Contexto:');
  assert.deepEqual(entry.notes, [{ slug: 'nevoni', title: 'nevoni' }, { slug: 'delta-plataforma', title: 'delta-plataforma' }],
    'as notas afetadas mantêm o slug para ligar');
  assert.equal(entry.session, '2026-09-02-nevoni-versionamento', 'o log de sessão é o wikilink marcado como log');
  assert.equal(decisions.months[0].entries[0].date, '2026-10-01');

  // Mês privado: conta, mas não entrega entrada.
  const agosto = decisions.months.find((month) => month.month === '2026-08');
  assert.equal(agosto.private, true);
  assert.equal(agosto.title, null, 'o título do mês privado não sai do servidor');
  assert.deepEqual(agosto.entries, [], 'a entrada do mês privado fica no vault');
  assert.equal(agosto.count, 1, 'a contagem diz que existe entrada sem mostrá-la');

  // Lições por tema: contagem, as três últimas e o caso ligado.
  const lessons = model.lessons;
  assert.equal(lessons.available, true);
  assert.equal(lessons.folder, 'resources/learnings');
  assert.deepEqual(lessons.counts, { themes: 4, lessons: 10 }, 'quatro temas e dez lições, sem o rascunho');
  assert.deepEqual(lessons.themes.map((theme) => [theme.slug, theme.count]),
    [['escrita-e-voz', 4], [null, 3], ['codigo-e-api', 2], ['verificacao', 1]],
    'o tema com mais lição vem primeiro, e o tema privado entra sem slug');
  const escrita = bySlug(lessons.themes, 'escrita-e-voz');
  assert.equal(escrita.title, 'Lições de escrita e voz');
  assert.equal(escrita.path, 'resources/learnings/escrita-e-voz.md');
  assert.deepEqual(escrita.latest.map((lesson) => [lesson.date, lesson.rule]), [
    ['2026-09-28', 'imperativo na forma de você'],
    ['2026-09-20', 'título afirma a regra'],
    ['2026-09-10', 'hook sem sustentação fica fora'],
  ], 'só as três lições mais novas de cada tema, com data e regra');
  assert.equal(escrita.latest[0].rule.includes('Why'), false, 'o corpo da lição não sai do servidor');
  assert.deepEqual(escrita.latest[1].cases, [{ slug: 'post-spacex', title: 'post-spacex' }],
    'o sub-bullet `caso:` vira link de caso');
  const codigo = bySlug(lessons.themes, 'codigo-e-api');
  assert.deepEqual(codigo.cases, [{ slug: 'delta-academy', title: 'delta-academy' }, { slug: 'coding-standards', title: 'coding-standards' }],
    'os casos do tema aparecem juntos, sem repetir');

  // Tema privado: conta, e nada do nome do arquivo sai — nem como slug.
  const privado = lessons.themes.find((theme) => theme.private);
  assert.equal(privado.title, null, 'o título do tema privado não sai do servidor');
  assert.equal(privado.path, null, 'o caminho revelaria o título');
  assert.equal(privado.slug, null, 'o slug é o nome do arquivo: também revelaria o assunto');
  assert.match(privado.id, /^[0-9a-f]{12}$/, 'o tema privado entra na lista com id opaco');
  assert.equal(privado.count, 3, 'a contagem diz que existem lições sem mostrá-las');
  assert.deepEqual(privado.latest, [], 'as lições do tema privado ficam na nota');
  assert.deepEqual(privado.cases, []);
  assert.equal(JSON.stringify(model).includes('cliente-nominal'), false,
    'o nome do arquivo privado não sai em nenhum campo da resposta');

  // Regras promovidas ao MEMORY: contagem e título, nunca o texto.
  const memory = model.memory;
  assert.equal(memory.available, true);
  assert.equal(memory.path, 'MEMORY.md');
  assert.equal(memory.count, 3, 'duas regras em negrito e uma seção `##` contam como regra promovida');
  assert.deepEqual(memory.rules, [
    'Afirmação negativa é a mais cara de errar',
    'Verificar antes de reportar',
    'Vault',
  ], 'só o título de cada regra sai do servidor');

  // Recall: último resultado, status e tamanho do histórico.
  const recall = model.recall;
  assert.equal(recall.available, true);
  assert.equal(recall.path, 'resources/teste-de-recall.md');
  assert.equal(recall.status, 'Aprovado');
  assert.equal(recall.history, 2, 'duas rodadas registradas');
  assert.deepEqual(recall.latest, {
    date: '2026-10-03',
    hits: 10,
    partials: 0,
    misses: 0,
    score: '100%',
    failed: 'nenhuma',
    fix: 'gabarito da 2 atualizado',
  }, 'o último resultado é o da data mais nova');
  assert.equal(recall.previous.date, '2026-09-27', 'a rodada anterior continua disponível para comparar');
  assert.equal(recall.previous.score, '85%');
  assert.equal(recall.previous.hits, null, 'célula ilegível fica nula: zero medido seria invenção');

  // Instalação INEVITA sem a chave `vault`: o aprendizado do vault não existe.
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3 });
  write(join(inevitaRoot, 'decisions', '2026-10.md'), '# Decisões\n\n- **2026-10-01 · nada**. Contexto: nada.\n');
  write(join(inevitaRoot, 'MEMORY.md'), '# MEMORY\n\n**Regra.** nada.\n');
  const inevitaApi = await readApi(inevitaRoot, { insights: '/api/vault-insights' });
  assert.equal(inevitaApi.insights.available, false, 'sem a chave vault, /api/vault-insights é indisponível');
  assert.equal(inevitaApi.insights.decisions, undefined, 'instalação INEVITA não ganha decisões do vault');
  assert.equal(inevitaApi.insights.memory, undefined, 'instalação INEVITA não ganha regras do vault');

  // A tela não transforma célula nula em zero medido: o recall diz "não medido".
  const app = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8');
  const recallCard = app.slice(app.indexOf('function vaultRecallCard'), app.indexOf('function renderVaultLearning'));
  assert.doesNotMatch(recallCard, /brainCount\(latest\.(hits|partials|misses)\)/,
    'contagem não medida não pode sair como 0 no card do recall');
  assert.match(recallCard, /brainMeasure\(latest\.hits\)/, 'o card do recall mede pelo valor lido');
  assert.match(app, /function brainMeasure\(value\) \{[\s\S]*?'não medido'/,
    'valor nulo precisa aparecer como não medido');

  console.log('✓ /api/vault-insights lê decisões por mês, lições por tema, MEMORY e recall sem expor corpo bruto');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
