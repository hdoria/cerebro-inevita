#!/usr/bin/env node

// Seam único do ticket 16: vault sintético (uma Área, duas Fontes, dois Sistemas e dois
// procedimentos) → `vault-compile` → API HTTP do Console. Verifica comportamento externo:
// o workspace de um Sistema que declara `procedimento` expõe a referência do SOP, a lista
// de procedimentos tem essa nota com fluxos, passos, papéis e ramos, e o Sistema que não
// declara procedimento continua sem referência nenhuma.
//
// Cobre também a política do front (função pura lida de console/app.js): com procedimento
// legível, "Como o Sistema funciona" desenha o SOP ligado; sem procedimento, nota privada
// escondida ou nota sem passo, ele mantém o fluxo declarado de seis etapas.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'vault-compile.mjs');
const vaultRoot = mkdtempSync(join(tmpdir(), 'vault-procedure-flow-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'vault-procedure-flow-inevita-'));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function compile(root, ...flags) {
  const run = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...flags], { encoding: 'utf8' });
  assert.equal(run.stderr, '', `vault-compile não deve falhar em stderr: ${run.stderr}`);
  return { out: run.stdout, code: run.status };
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
finalidade: alimentar o sistema
sensibilidade: media
pii: indireto
frescor: 1 dia
retencao: so referencia no recibo
acesso: leitura
consumidores:
  - "[[enriquecer]]"
status: Ativo
updated: 2026-10-01
---

# ${name}
`;
}

// Sistema que declara o procedimento: `procedimento` aponta o slug da nota do SOP.
const WITH_PROCEDURE = `---
type: System
system_id: enriquecer
nome: Enriquecimento de empresa
versao: 0.1.0
status: Ativo
area: "[[comercial]]"
area_confirmada: sim
resultado: a nota da empresa com registro, socios e proveniencia
nao_sucesso: gravar dado sem origem e sem data
entrega: nota-de-empresa
pronto_quando: a nota existe com uma linha de proveniencia por consulta
dono: "[[hugo-doria]]"
gate_humano: o dono autoriza o custo de cada consulta
gatilho: manual
quando: invocacao manual com documento, dominio ou nome
capacidade: enriquecer
capacidade_origem: local
entidades:
  - tipo: company
    papel: empresa-enriquecida
    obrigatoria: sim
fontes:
  - papel: registro-oficial
    fonte: "[[registro]]"
    obrigatoria: sim
    acesso: leitura
    frescor: 90 dias
    finalidade: trazer o registro oficial
  - papel: rede-de-pessoas
    fonte: "[[rede]]"
    obrigatoria: nao
    acesso: leitura
    frescor: 90 dias
    finalidade: abrir a rede de pessoas
    se_faltar: seguir-com-lacuna
etapas:
  - estado: identificado
    entrada: o que o dono passou
    saida: o documento da empresa
    gate: o custo se confirma antes de gastar
  - estado: gravado
    entrada: as respostas das fontes
    saida: a nota da empresa
    gate: documento entra sem mascara
gates:
  - cada secao factual leva o rotulo da origem
perguntas_humanas:
  - o custo desta consulta esta autorizado?
medida: nota-aprovada
paradas:
  - parar quando a ponte para o documento falhar
leitura:
  - as fontes declaradas neste Sistema
escrita:
  - a nota da empresa
acoes_externas: nao
procedimento: "[[enriquecimento|Enriquecimento de leads]]"
updated: 2026-10-03
---

# Enriquecimento de empresa
`;

// Sistema sem `procedimento`: a tela precisa continuar com o fluxo declarado.
const WITHOUT_PROCEDURE = WITH_PROCEDURE
  .replace('system_id: enriquecer', 'system_id: desafiar')
  .replace('nome: Enriquecimento de empresa', 'nome: Desafiar o vault')
  .replace('capacidade: enriquecer', 'capacidade: desafiar')
  .replace('procedimento: "[[enriquecimento|Enriquecimento de leads]]"\n', '')
  .replace('# Enriquecimento de empresa', '# Desafiar o vault');

const PROCEDURE_NOTE = `---
type: Procedure
status: Ativo
updated: 2026-10-03
sistema: "[[enriquecer|Enriquecimento de empresa]]"
---

# Enriquecimento de leads

Como enriquecer empresas, com a fronteira de dados clara.

## Passos

1. Quem: agente: ler a entrada e classificar em documento, dominio ou nome.
   - Se veio o documento → passo 3
   - Se veio um nome → passo 2
2. Quem: agente: resolver nome para documento na base de rede de pessoas, a unica que faz essa ponte.
   - Se a autenticacao voltar 403 → passo 4
3. Quem: agente: rodar o registro oficial pelo documento.
4. Quem: Hugo: destravar a conta no painel, porque nao e o script nem a credencial.

## Trilha de pessoa fisica

1. Quem: Hugo: confirmar o proposito declarado e autorizar o custo.
2. Quem: agente: gravar a nota com visibility private.

## Critério de pronto

- Nota gravada com uma linha de proveniencia por consulta.
- Divergencia entre fontes marcada como a confirmar.
`;

// Nota privada: o SOP não pode vazar no workspace do Sistema que a declara.
const PRIVATE_PROCEDURE = `---
type: Procedure
status: Ativo
visibility: private
---

# Ficha de um cliente nominal

## Passos

1. Abrir a nota da pessoa.
`;

// Política do front, lida de console/app.js: quem decide entre o SOP e o fluxo de etapas.
function frontPolicy() {
  const app = readFileSync(resolve(here, '..', 'console', 'app.js'), 'utf8');
  const start = app.indexOf('function wsLinkedProcedure(');
  assert.ok(start > 0, 'console/app.js precisa declarar wsLinkedProcedure como função pura');
  const end = app.indexOf('\nfunction ', start + 1);
  const source = app.slice(start, end);
  return new Function(`${source}\nreturn wsLinkedProcedure;`)();
}

try {
  // ── vault sintético em modo vault, com a pasta de procedimentos declarada ───────
  write(join(vaultRoot, 'AGENTS.md'), '# Vault sintético\n');
  write(join(vaultRoot, '.git', 'info', 'exclude'), '# local excludes\n');
  assert.equal(bootstrapLegacyConsole(vaultRoot, { confirm: true }).status, 'created');
  const layoutPath = join(vaultRoot, '.cerebro', 'layout.json');
  write(layoutPath, {
    ...JSON.parse(readFileSync(layoutPath, 'utf8')),
    knowledgeRoot: '.',
    vault: { daily: 'journal', inbox: 'inbox', projects: 'projects', areas: 'areas', procedures: 'procedures' },
  });

  write(join(vaultRoot, 'areas', 'comercial.md'), '---\ntype: Area\nstatus: Active\n---\n\n# Comercial\n');
  write(join(vaultRoot, 'sistema', 'fontes', 'registro.md'), dataSource('registro', 'Registro oficial'));
  write(join(vaultRoot, 'sistema', 'fontes', 'rede.md'), dataSource('rede', 'Rede de pessoas'));
  write(join(vaultRoot, 'sistema', 'sistemas', 'enriquecer.md'), WITH_PROCEDURE);
  write(join(vaultRoot, 'sistema', 'sistemas', 'desafiar.md'), WITHOUT_PROCEDURE);
  write(join(vaultRoot, 'procedures', 'enriquecimento.md'), PROCEDURE_NOTE);
  write(join(vaultRoot, 'procedures', 'ficha-de-cliente.md'), PRIVATE_PROCEDURE);

  const compiled = compile(vaultRoot, '--confirm');
  assert.equal(compiled.code, 0, `a compilação do vault sintético não deve ter erro: ${compiled.out}`);

  const api = await readApi(vaultRoot, {
    withProcedure: '/api/systems/enriquecer/workspace',
    withoutProcedure: '/api/systems/desafiar/workspace',
    procedures: '/api/procedures',
  });

  // ── 1. o workspace expõe o procedimento declarado, pelo slug da nota ────────────
  assert.equal(api.withProcedure.contract.procedure_ref, 'enriquecimento',
    'o workspace do Sistema entrega o slug do procedimento que a nota declara');
  assert.equal(api.withoutProcedure.contract.procedure_ref, null,
    'Sistema sem procedimento declarado não ganha referência inventada');

  // ── 2. /api/procedures tem a nota, com fluxos, papéis e ramos ───────────────────
  const procedures = api.procedures.procedures || [];
  const linked = procedures.find((item) => item.slug === api.withProcedure.contract.procedure_ref);
  assert.ok(linked, 'o procedimento que o contrato aponta existe na lista de procedimentos');
  assert.equal(linked.title, 'Enriquecimento de leads');
  assert.deepEqual(linked.sistema_refs, [{ slug: 'enriquecer', title: 'Enriquecimento de empresa' }],
    'a nota do procedimento aponta de volta para o Sistema, fechando as duas direções');
  assert.deepEqual(linked.flows.map((flow) => [flow.id, flow.steps.length]),
    [['passos', 4], ['trilha-de-pessoa-fisica', 2]],
    'os dois fluxos da nota chegam ao Console na ordem do documento');
  assert.deepEqual(linked.flows[0].steps.map((step) => [step.n, step.role, step.branches.length]),
    [[1, 'agente', 2], [2, 'agente', 1], [3, 'agente', 0], [4, 'Hugo', 0]],
    'papel e ramos de cada passo chegam prontos para desenhar');
  assert.deepEqual(linked.flows[0].steps[0].branches, [
    { condition: 'veio o documento', target: 3 },
    { condition: 'veio um nome', target: 2 },
  ], 'cada ramo chega com condição e passo-alvo');
  assert.equal(linked.done.length, 2, 'o critério de pronto da nota chega ao workspace');

  // ── 3. a política do front escolhe o SOP só quando ele é legível ────────────────
  const wsLinkedProcedure = frontPolicy();
  assert.equal(wsLinkedProcedure(api.withProcedure, api.procedures), linked,
    'com procedimento declarado e legível, o workspace desenha o SOP ligado');
  assert.equal(wsLinkedProcedure(api.withoutProcedure, api.procedures), null,
    'Sistema sem procedimento mantém o fluxo declarado de seis etapas');
  assert.equal(wsLinkedProcedure(api.withProcedure, null), null,
    'sem o modelo de procedimentos carregado, a tela não arrisca: fluxo declarado');
  assert.equal(wsLinkedProcedure(api.withProcedure, { procedures: [] }), null,
    'procedimento declarado que não existe na pasta não vira fluxo vazio');
  const hidden = procedures.find((item) => item.private);
  assert.ok(hidden && hidden.flows.length === 0, 'a nota privada chega sem passos por padrão');
  assert.equal(wsLinkedProcedure({ contract: { procedure_ref: hidden.slug } }, api.procedures), null,
    'procedimento privado escondido não desenha fluxo no workspace do Sistema');

  // ── 4. a tela reaproveita os componentes da tela Procedimentos, sem estilo inline ─
  const app = readFileSync(resolve(here, '..', 'console', 'app.js'), 'utf8');
  const organ = app.slice(app.indexOf('function wsProcedureOrgan('), app.indexOf('function wsProcessFlow('));
  assert.ok(organ.includes('procedureFlow'), 'o workspace reaproveita o desenho de fluxo da tela Procedimentos');
  assert.ok(organ.includes('sop-done'), 'o critério de pronto usa a mesma classe da tela Procedimentos');
  assert.ok(organ.includes('data-open-procedure'), 'o workspace oferece abrir o SOP na tela Procedimentos');
  assert.equal(/style\s*=\s*["'`]/.test(organ), false, 'nenhum estilo inline: a CSP do Console bloqueia');
  assert.ok(app.includes("data-open-procedure"), 'o clique em abrir o SOP é tratado pelo app');

  // ── 5. instalação INEVITA sem vault: o workspace continua sem procedimento ──────
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3 });
  const inevitaContract = JSON.parse(readFileSync(resolve(here, '..', 'protocol', 'examples', 'system-contract.v2.json'), 'utf8'));
  write(join(inevitaRoot, '.cerebro', 'contracts', 'systems', `${inevitaContract.system_id}.json`), inevitaContract);
  const inevitaApi = await readApi(inevitaRoot, {
    workspace: `/api/systems/${inevitaContract.system_id}/workspace`,
    procedures: '/api/procedures',
  });
  assert.equal(inevitaApi.workspace.contract.procedure_ref, null,
    'contrato da INEVITA sem extensão de procedimento responde null, não erro');
  assert.equal(inevitaApi.procedures.available, false, 'sem a chave vault, a tela Procedimentos não existe');

  console.log('✓ o workspace do Sistema expõe o SOP ligado e a tela desenha o procedimento em vez do fluxo genérico');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
