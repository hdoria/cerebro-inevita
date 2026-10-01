import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { companyMapModel, knowledgeIndex } from './console-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'console-layout-'));
const write = (relative, content) => {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
};

try {
  write('projects/alpha.md', '# Alpha\nVer [[beta]] e [[pessoa-x]].\n');
  write('projects/beta.md', '# Beta\nLiga em [[alpha]].\n');
  write('people/pessoa-x.md', '# Pessoa X\nTrabalha em [[alpha]].\n');
  write('.claude/skills/daily/SKILL.md', '# daily\n');

  // Sem layout: mantém o padrão da INEVITA e não enxerga as pastas do vault.
  assert.equal(knowledgeIndex(root).total_notes, 0, 'sem layout, a memória lê só 01-nucleo-privado');
  assert.equal(companyMapModel(root).domains.length, 0, 'sem layout, nenhum caminho da INEVITA existe aqui');

  write('.cerebro/layout.json', {
    version: 3,
    knowledgeRoot: '.',
    companyMapDomains: [
      { id: 'work', name: 'Trabalho', purpose: 'Projetos e gente.', entries: [
        { id: 'projects', name: 'Projetos', refs: ['projects'] },
        { id: 'people', name: 'Pessoas', refs: ['people'] },
        { id: 'missing', name: 'Ausente', refs: ['nao-existe'] },
      ] },
    ],
  });
  const index = knowledgeIndex(root);
  assert.equal(index.total_notes, 3, 'a raiz configurada conta as notas e ignora pastas ocultas');
  assert.equal(index.most_linked[0].title, 'alpha', 'a nota mais linkada sai do conteúdo real');
  assert.equal(index.most_linked[0].path, 'projects/alpha.md');

  const map = companyMapModel(root);
  assert.equal(map.domains.length, 1);
  assert.deepEqual(map.domains[0].entries.map((entry) => [entry.id, entry.count]), [['projects', 2], ['people', 1]],
    'entrada sem caminho existente some do mapa');

  // Caminho fora do Cérebro é recusado e o Console volta ao padrão.
  write('.cerebro/layout.json', {
    version: 3,
    knowledgeRoot: '../',
    companyMapDomains: [{ id: 'x', name: 'X', entries: [{ id: 'y', name: 'Y', refs: ['../../etc'] }] }],
  });
  assert.equal(knowledgeIndex(root).total_notes, 0, 'knowledgeRoot fora do Cérebro é ignorado');
  assert.equal(companyMapModel(root).domains.length, 0, 'mapa com ref fora do Cérebro é ignorado');

  console.log('✓ console lê mapa e memória pelos caminhos do layout, recusando caminho fora do Cérebro');
} finally {
  rmSync(root, { recursive: true, force: true });
}
