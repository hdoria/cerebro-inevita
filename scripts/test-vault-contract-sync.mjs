#!/usr/bin/env node

// Seam único do ticket 05: vault sintético → `vault:sync` (CLI) → API HTTP do Console.
// Verifica comportamento externo, não função interna: o que a CLI imprime, o que fica
// gravado em disco e o que `/api/console` devolve para a tela Fontes.
//
// Cobre: contrato válido gravado e listado; simulação não escreve; nota inválida produz
// `<nota> · <campo> · <motivo>`; CPF em campo é recusado; recompilar não muda nada;
// remoção de órfão toca só o que o compilador gerou; instalação INEVITA sem vault
// continua igual.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';
import { validateSourceContract } from './lib/system-protocol.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'vault-compile.mjs');
const vaultRoot = mkdtempSync(join(tmpdir(), 'vault-contracts-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'vault-contracts-inevita-'));
const CONTRACTS = join('.cerebro', 'contracts', 'sources');

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function sync(root, ...flags) {
  const run = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...flags], { encoding: 'utf8' });
  assert.equal(run.stderr, '', `vault-compile não deve falhar em stderr: ${run.stderr}`);
  return { out: run.stdout, code: run.status, lines: run.stdout.split('\n').filter(Boolean) };
}

function sourcesDir(root) {
  const directory = join(root, CONTRACTS);
  return existsSync(directory) ? readdirSync(directory).sort() : [];
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

const GMAIL_NOTE = `---
type: DataSource
source_id: gmail
nome: Gmail do Hugo
kind: mcp
dono: "[[hugo-doria]]"
casa_da_verdade: Caixa de entrada do Gmail
finalidade: achar o que exige acao do dia sem abrir a caixa inteira
entidades: [email-thread]
limites:
  - so leitura das threads nao lidas ou importantes dos ultimos dois dias
  - nenhum rascunho, nenhum envio
sensibilidade: alta
pii: direto
frescor: 2 dias
retencao: so referencia de thread no recibo da execucao
acesso: leitura
consumidores:
  - "[[daily|Daily]]"
status: Ativo
updated: 2026-10-01
_organized: true
---

# Gmail do Hugo

Fonte de acao do dia.
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
  // O bootstrap do Console não cria `.cerebro/runtime/`: é o `--confirm` que cria.
  rmSync(join(vaultRoot, '.cerebro', 'runtime'), { recursive: true, force: true });

  // (a) fonte válida
  write(join(vaultRoot, 'sistema', 'fontes', 'gmail.md'), GMAIL_NOTE);

  // (b) nota inválida: sensibilidade fora da régua e frescor vazio
  write(join(vaultRoot, 'sistema', 'fontes', 'planilha.md'), `---
type: DataSource
source_id: planilha
nome: Planilha de caixa
kind: arquivo
casa_da_verdade: Pasta local de financeiro
finalidade: conferir o caixa do mes
sensibilidade: altissima
pii: nenhum
frescor:
retencao: so referencia
acesso: leitura
status: Ativo
---

# Planilha de caixa
`);

  // (c) nota com CPF num campo mapeado
  write(join(vaultRoot, 'sistema', 'fontes', 'cadastro.md'), `---
type: DataSource
source_id: cadastro
nome: Cadastro
kind: manual
casa_da_verdade: ficha do contratante 529.982.247-25
finalidade: preencher contrato
sensibilidade: muito-alta
pii: direto
frescor: 30 dias
retencao: so referencia
acesso: leitura
status: Ativo
---

# Cadastro
`);

  // Template e rascunho declaram o type para herdar o formulário do app; não são fonte.
  write(join(vaultRoot, 'templates', 'datasource.md'), `---
type: DataSource
source_id:
nome:
kind: mcp
---

#
`);
  write(join(vaultRoot, 'sistema', 'fontes', '_rascunho.md'), '---\ntype: DataSource\n---\n\n# Rascunho\n');
  // Template não precisa morar na raiz do vault: qualquer segmento `templates/` é
  // formulário do app, não declaração de fonte.
  write(join(vaultRoot, 'sistema', 'templates', 'datasource.md'), `---
type: DataSource
source_id:
nome:
kind: mcp
---

#
`);

  // Contrato de outra ferramenta: o compilador não é dono dele e nunca o apaga.
  const foreign = {
    protocol_version: 1,
    source_id: 'alheio',
    name: 'Fonte registrada por outra ferramenta',
    type: 'local-folder',
    status: 'mapped',
    truth: { home_ref: 'pasta local', source_of_truth: true },
    authority: { owner_ref: null, status: 'unconfirmed' },
    scope: { purpose: 'teste', entity_types: [], boundaries: [] },
    sensitivity: 'private',
    pii: { classification: 'unknown', handling: 'reference-only' },
    modes: ['read'],
    freshness: { policy: 'manual', observed_at: null },
    retention: { policy: 'manual', until: null },
    revocation: { method: 'remover a pasta', effect: 'future-only', revocable: true },
    connector: {
      kind: 'local-folder', binding_ref: null, credential_ref: null, custody: 'none',
    },
    authorized_consumers: [],
    assurance: 'receipt-audited',
  };
  write(join(vaultRoot, CONTRACTS, 'alheio.json'), foreign);

  // ── 1. simulação por padrão: nada é gravado ─────────────────────────────────────
  const dry = sync(vaultRoot);
  assert.equal(dry.code, 1, 'com nota inválida, a simulação sai com código 1');
  assert.match(dry.out, /^ok · sistema\/fontes\/gmail\.md · fonte gmail → \.cerebro\/contracts\/sources\/gmail\.json \(gravaria\)$/m,
    'a simulação diz qual nota viraria qual contrato');
  assert.deepEqual(sourcesDir(vaultRoot), ['alheio.json'],
    'sem --confirm, nenhum contrato novo é gravado');
  assert.equal(existsSync(join(vaultRoot, '.cerebro', 'compiled.json')), false,
    'sem --confirm, o registro de arquivos gerados não é criado');
  assert.equal(existsSync(join(vaultRoot, '.cerebro', 'runtime')), false,
    'sem --confirm, o diretório de runtime não é criado');
  assert.match(dry.out, /simulação: 1 contrato\(s\) válido\(s\) · 2 nota\(s\) com erro/,
    'o resumo da simulação conta válidos e com erro, sem contar template nem rascunho');
  assert.equal(dry.out.includes('templates/datasource.md'), false,
    'o template do type não é uma fonte declarada, na raiz ou em subpasta');
  assert.equal(dry.out.includes('_rascunho.md'), false, 'rascunho prefixado com _ fica de fora');

  // ── 2. erro aponta nota, campo e motivo ─────────────────────────────────────────
  assert.ok(dry.lines.includes('sistema/fontes/planilha.md · sensibilidade · valor inválido; use baixa, media, alta, muito-alta'),
    `erro de valor fora da régua precisa sair como <nota> · <campo> · <motivo>: ${dry.out}`);
  assert.ok(dry.lines.includes('sistema/fontes/planilha.md · frescor · campo obrigatório e vazio'),
    'campo obrigatório vazio também aponta nota e campo');

  // ── 3. CPF em campo mapeado é recusado ──────────────────────────────────────────
  assert.ok(dry.lines.includes('sistema/fontes/cadastro.md · casa_da_verdade · parece CPF; contrato aceita só referência'),
    `CPF num campo mapeado precisa ser recusado com motivo legível: ${dry.out}`);
  assert.equal(dry.lines.some((line) => line.includes('529.982.247-25') && line.startsWith('ok')), false,
    'o valor recusado nunca sai como contrato pronto');

  // ── 4. --confirm grava, valida e aparece no Console ─────────────────────────────
  const confirmed = sync(vaultRoot, '--confirm');
  assert.equal(confirmed.code, 1, 'as duas notas quebradas continuam reportadas');
  assert.deepEqual(sourcesDir(vaultRoot), ['alheio.json', 'gmail.json'],
    'só a nota válida vira contrato; o contrato alheio continua intacto');
  const contract = JSON.parse(readFileSync(join(vaultRoot, CONTRACTS, 'gmail.json'), 'utf8'));
  assert.deepEqual(validateSourceContract(contract), [],
    'o contrato gerado passa no validador do protocolo sem ajuste');
  assert.equal(contract.sensitivity, 'private', 'sensibilidade alta vira private');
  assert.equal(contract.pii.classification, 'contains', 'pii direto vira contains');
  assert.equal(contract.pii.handling, 'reference-only', 'fonte com PII só carrega referência');
  assert.deepEqual(contract.modes, ['read'], 'acesso leitura vira apenas read');
  assert.equal(contract.type, 'mcp-connector', 'kind mcp vira o type do protocolo');
  assert.equal(contract.connector.custody, 'agent-direct', 'MCP fica em custódia do agente');
  assert.equal(contract.authority.owner_ref, 'hugo-doria', 'o dono vem do alvo do wikilink');
  assert.deepEqual(contract.authorized_consumers, [{ subject_type: 'system', subject_ref: 'daily' }],
    'consumidor ainda sem nota de Sistema é tolerado: o alvo não precisa existir');
  assert.equal(contract.freshness.observed_at, '2026-10-01T00:00:00.000Z',
    'a observação vem do campo updated da nota, não do relógio');
  assert.equal(contract.extensions.vault_note_ref, 'sistema/fontes/gmail.md',
    'o contrato aponta a nota que o gerou');
  assert.equal(existsSync(join(vaultRoot, '.cerebro', 'runtime')), true,
    '--confirm cria o diretório de runtime que faltava');

  const registry = JSON.parse(readFileSync(join(vaultRoot, '.cerebro', 'compiled.json'), 'utf8'));
  assert.deepEqual(registry.files, [
    { path: '.cerebro/contracts/sources/gmail.json', type: 'DataSource', note: 'sistema/fontes/gmail.md' },
  ], 'o registro lista só os arquivos que o compilador gerou, com a nota de origem');

  const api = await readApi(vaultRoot, { console: '/api/console' });
  const gmail = api.console.sources.find((source) => source.source_id === 'gmail');
  assert.ok(gmail, 'a tela Fontes do Console mostra o Gmail');
  assert.equal(gmail.name, 'Gmail do Hugo');
  assert.equal(gmail.status, 'active');
  assert.equal(gmail.type, 'mcp-connector');
  assert.equal(gmail.pii, 'contains');
  assert.equal(gmail.custody, 'agent-direct');
  assert.deepEqual(gmail.modes, ['read']);
  assert.equal(api.console.issues.some((issue) => issue.reason_code === 'source-contract-invalid'), false,
    'nenhum contrato gerado entra na tela Saúde como inválido');
  assert.equal(api.console.issues.some((issue) => issue.reason_code === 'learning-candidate-invalid'), false,
    'com `.cerebro/runtime/` criado, a Saúde para de acusar instalação incompleta');

  // ── 5. recompilar não muda nada ─────────────────────────────────────────────────
  const before = statSync(join(vaultRoot, CONTRACTS, 'gmail.json')).mtimeMs;
  const content = readFileSync(join(vaultRoot, CONTRACTS, 'gmail.json'), 'utf8');
  const again = sync(vaultRoot, '--confirm');
  assert.match(again.out, /· 0 arquivo\(s\) gravado\(s\) · 0 órfão\(s\) removido\(s\)/,
    'a segunda rodada não grava nada');
  assert.equal(readFileSync(join(vaultRoot, CONTRACTS, 'gmail.json'), 'utf8'), content,
    'o conteúdo do contrato é idêntico na recompilação');
  assert.equal(statSync(join(vaultRoot, CONTRACTS, 'gmail.json')).mtimeMs, before,
    'o arquivo não é reescrito quando nada mudou');

  // ── 5b. nota que passa a falhar mantém o último contrato bom, e o registro dele ─
  // Validação quebrada não apaga o contrato que já funcionava: a nota existe, então o
  // arquivo dela não é órfão. O registro precisa continuar listando esse arquivo com a
  // nota de origem, senão ele vira órfão invisível e nunca sai quando a nota for apagada.
  const notionNote = join(vaultRoot, 'sistema', 'fontes', 'notion.md');
  const notionContract = join(vaultRoot, CONTRACTS, 'notion.json');
  const registered = () => JSON.parse(readFileSync(join(vaultRoot, '.cerebro', 'compiled.json'), 'utf8'))
    .files.map((entry) => entry.path);
  write(notionNote, GMAIL_NOTE.replace('source_id: gmail', 'source_id: notion')
    .replace('nome: Gmail do Hugo', 'nome: Notion do dono'));
  sync(vaultRoot, '--confirm');
  assert.equal(existsSync(notionContract), true, 'a fonte nova vira contrato');
  assert.ok(registered().includes('.cerebro/contracts/sources/notion.json'),
    'o registro lista o contrato gerado');

  write(notionNote, GMAIL_NOTE.replace('source_id: gmail', 'source_id: notion')
    .replace('nome: Gmail do Hugo', 'nome: Notion do dono')
    .replace('sensibilidade: alta', 'sensibilidade: altissima'));
  const brokenAgain = sync(vaultRoot, '--confirm');
  assert.ok(brokenAgain.lines.includes('sistema/fontes/notion.md · sensibilidade · valor inválido; use baixa, media, alta, muito-alta'),
    `a nota quebrada é reportada: ${brokenAgain.out}`);
  assert.equal(existsSync(notionContract), true,
    'o último contrato bom fica em disco até o dono corrigir a nota');
  assert.ok(registered().includes('.cerebro/contracts/sources/notion.json'),
    'o registro continua listando o contrato da nota que falhou');
  assert.deepEqual(brokenAgain.out.match(/removido ·/g), null,
    'nota que existe não tem contrato órfão');

  rmSync(notionNote);
  const notionGone = sync(vaultRoot, '--confirm');
  assert.ok(notionGone.lines.includes('removido · .cerebro/contracts/sources/notion.json · nota de origem não existe mais'),
    `apagada a nota, o contrato dela sai mesmo depois de uma rodada com erro: ${notionGone.out}`);
  assert.equal(existsSync(notionContract), false, 'o contrato não fica para sempre em disco');
  assert.equal(registered().includes('.cerebro/contracts/sources/notion.json'), false,
    'o registro deixa de listar o arquivo removido');

  // ── 6. órfão: nota apagada tira o contrato dela e só o dela ─────────────────────
  rmSync(join(vaultRoot, 'sistema', 'fontes', 'gmail.md'));
  const orphanDry = sync(vaultRoot);
  assert.ok(orphanDry.lines.includes('removeria · .cerebro/contracts/sources/gmail.json · nota de origem não existe mais'),
    'a simulação avisa qual arquivo sairia');
  assert.equal(existsSync(join(vaultRoot, CONTRACTS, 'gmail.json')), true,
    'simular não remove nada');
  sync(vaultRoot, '--confirm');
  assert.deepEqual(sourcesDir(vaultRoot), ['alheio.json'],
    'o órfão sai e o contrato de outra ferramenta continua lá');

  // ── 7. instalação INEVITA sem vault segue igual ─────────────────────────────────
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3 });
  write(join(inevitaRoot, CONTRACTS, 'paid-media.json'), foreign);
  const inevita = sync(inevitaRoot, '--confirm');
  assert.equal(inevita.code, 0, 'instalação sem nota compilável não é erro');
  assert.match(inevita.out, /nenhuma nota compilável encontrada neste vault/);
  assert.deepEqual(sourcesDir(inevitaRoot), ['paid-media.json'],
    'instalação INEVITA não perde nem ganha contrato');
  assert.equal(existsSync(join(inevitaRoot, '.cerebro', 'compiled.json')), false,
    'sem nota compilável, o compilador não cria registro nem diretório novo');

  console.log('✓ vault:sync compila notas DataSource em Source Contracts e a tela Fontes do Console mostra o resultado');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
