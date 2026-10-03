#!/usr/bin/env node

// Estados da memória medidos pelo vault e privacidade das notas, testados pelo seam
// HTTP contra um Cérebro sintético: /api/anatomy devolve Bruto, Processado, Destilado
// e Contexto vigente com número real e rótulo "medido pelo vault", e /api/knowledge
// esconde o título das notas `visibility: private` por padrão. Instalação INEVITA
// sem a chave `vault` continua idêntica.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapLegacyConsole } from './console-bootstrap.mjs';
import { createConsoleServer } from './console-server.mjs';

const vaultRoot = mkdtempSync(join(tmpdir(), 'console-vault-memory-'));
const inevitaRoot = mkdtempSync(join(tmpdir(), 'console-inevita-memory-'));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function note(root, relative, meta, body) {
  write(join(root, relative), `---\n${meta}\n---\n\n${body}\n`);
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
    return values;
  } finally {
    await new Promise((closed) => instance.server.close(closed));
  }
}

const step = (lifecycle, id) => lifecycle.find((item) => item.id === id);

try {
  // Cérebro em modo vault: marcador legado, layout com `vault` e raiz de conhecimento na raiz.
  write(join(vaultRoot, 'AGENTS.md'), '# Vault sintético\n');
  write(join(vaultRoot, '.git', 'info', 'exclude'), '# local excludes\n');
  assert.equal(bootstrapLegacyConsole(vaultRoot, { confirm: true }).status, 'created');
  const layoutPath = join(vaultRoot, '.cerebro', 'layout.json');
  write(layoutPath, {
    ...JSON.parse(readFileSync(layoutPath, 'utf8')),
    knowledgeRoot: '.',
    vault: { focus: ['hot.md'], daily: 'journal', inbox: 'inbox', projects: 'projects', areas: 'areas' },
  });

  // Bruto: só as notas do inbox contam (anexo e rascunho `_` ficam de fora).
  write(join(vaultRoot, 'inbox', 'captura-1.md'), '# Captura 1\n');
  write(join(vaultRoot, 'inbox', 'captura-2.md'), '# Captura 2\n');
  write(join(vaultRoot, 'inbox', '_rascunho.md'), '# Rascunho\n');
  write(join(vaultRoot, 'inbox', 'anexo.txt'), 'nada\n');

  // Processado, Destilado e Contexto vigente saem do frontmatter e das seções.
  write(join(vaultRoot, 'hot.md'), '# Hot\n\n- Fechar o ticket\n- Ver [[nota-sensivel]]\n');
  note(vaultRoot, 'people/nota-sensivel.md', 'type: Person\nvisibility: private\n_organized: true\nupdated: 2026-09-20', '# Nota sensível');
  note(vaultRoot, 'resources/fonte-aberta.md', 'type: Source\n_organized: true\nupdated: 2026-09-25',
    '# Fonte aberta\n\n## Resumo\n\nTexto.\n\n## Para que pode servir\n\n- Decidir preço\n');
  note(vaultRoot, 'resources/fonte-antiga.md', 'type: Source\n_organized: true\nupdated: 2026-01-10',
    '# Fonte antiga\n\n## Para que pode servir\n\n- Histórico\n');
  note(vaultRoot, 'resources/fonte-crua.md', 'type: Source\n_organized: true\nupdated: 2026-09-28', '# Fonte crua\n\n## Resumo\n\nSó o bruto.\n');
  note(vaultRoot, 'projects/projeto.md', 'type: Project\nstatus: Active\nupdated: 2026-09-30',
    '# Projeto\n\n- [[nota-sensivel]] combinou o escopo\n- confirmar com [[nota-sensivel]]\n- apoio em [[fonte-aberta]]\n');

  const vaultApi = await readApi(vaultRoot, {
    anatomy: '/api/anatomy',
    knowledge: '/api/knowledge',
    revealed: '/api/knowledge?reveal=1',
  });

  const lifecycle = vaultApi.anatomy.control_center.memory.lifecycle;
  for (const [id, value] of [['raw', 2], ['processed', 4], ['distilled', 2], ['current-context', 4]]) {
    const measured = step(lifecycle, id);
    assert.equal(measured.measured, true, `${id} precisa ser medido em modo vault`);
    assert.equal(measured.value, value, `${id} conta as notas do vault`);
    assert.equal(measured.measured_by, 'vault', `${id} declara a origem da medição`);
    assert.match(measured.unit, /^medido pelo vault: /, `${id} aparece rotulado como medido pelo vault`);
    assert.equal(measured.reason_code ?? null, null, `${id} medido não carrega reason_code de ausência`);
  }
  assert.equal(step(lifecycle, 'source').measured_by ?? null, null, 'a etapa Fonte continua vindo dos contratos');

  // Privacidade: a nota mais linkada é privada e sai sem título nem caminho.
  const hidden = vaultApi.knowledge.most_linked;
  assert.equal(hidden[0].count, 3, 'a nota privada é a mais linkada do vault sintético');
  assert.equal(hidden[0].private, true, 'a nota privada é marcada como privada');
  assert.equal(hidden[0].title, null, 'o título da nota privada não sai do servidor por padrão');
  assert.equal(hidden[0].path, null, 'o caminho revelaria o título, então também fica de fora');
  assert.equal(hidden[0].domain, 'people', 'o domínio continua visível para dar contexto neutro');
  const open = hidden.find((item) => item.domain === 'resources');
  assert.equal(open.title, 'fonte-aberta', 'nota pública mantém título');
  assert.equal(open.private, false);
  assert.equal(open.path, 'resources/fonte-aberta.md');

  // Revelar é explícito: só com ?reveal=1 o título privado é enviado.
  const revealed = vaultApi.revealed.most_linked;
  assert.equal(revealed[0].private, true);
  assert.equal(revealed[0].title, 'nota-sensivel', 'com ?reveal=1 o título privado é enviado');
  assert.equal(revealed[0].path, 'people/nota-sensivel.md');

  // Instalação INEVITA sem `vault`: memória e memória semântica inalteradas.
  write(join(inevitaRoot, 'VERSION'), 'fixture\n');
  write(join(inevitaRoot, 'COMECE-AQUI.md'), '# Fixture\n');
  write(join(inevitaRoot, '.cerebro', 'layout.json'), { version: 3 });
  note(inevitaRoot, '01-nucleo-privado/conceitos/nota-a.md', 'visibility: private\n_organized: true\nupdated: 2026-09-20', '# Nota A');
  write(join(inevitaRoot, '01-nucleo-privado', 'conceitos', 'nota-b.md'), '# Nota B\n\nVer [[nota-a]].\n');
  write(join(inevitaRoot, 'inbox', 'captura.md'), '# Captura\n');

  const inevitaApi = await readApi(inevitaRoot, { anatomy: '/api/anatomy', knowledge: '/api/knowledge' });
  const inevitaLifecycle = inevitaApi.anatomy.control_center.memory.lifecycle;
  assert.deepEqual(
    [['raw', 'capture-transition-receipt-missing'], ['processed', 'processing-transition-receipt-missing'],
      ['distilled', 'distillation-transition-receipt-missing']].map(([id]) => {
      const item = step(inevitaLifecycle, id);
      return [id, item.measured, item.value, item.reason_code];
    }),
    [['raw', false, null, 'capture-transition-receipt-missing'],
      ['processed', false, null, 'processing-transition-receipt-missing'],
      ['distilled', false, null, 'distillation-transition-receipt-missing']],
    'sem vault, as transições continuam não instrumentadas',
  );
  assert.equal(inevitaLifecycle.some((item) => item.measured_by === 'vault'), false, 'nada é medido pelo vault numa instalação INEVITA');
  assert.equal(inevitaApi.knowledge.most_linked[0].title, 'nota-a', 'sem vault, o título da nota continua aparecendo');
  assert.equal(inevitaApi.knowledge.most_linked[0].private, undefined, 'sem vault, o índice não ganha campo novo');
  assert.equal(inevitaApi.knowledge.most_linked[0].path, '01-nucleo-privado/conceitos/nota-a.md');

  console.log('✓ memória medida pelo vault nos quatro estados e nota privada sem título por padrão');
} finally {
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(inevitaRoot, { recursive: true, force: true });
}
