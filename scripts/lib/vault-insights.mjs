// Aprendizado de um vault de notas tipadas: decisões por mês, lições por tema, as
// regras promovidas ao MEMORY e o último resultado do teste de recall. Só lê; nunca
// escreve no vault. Ativado quando .cerebro/layout.json declara a chave `vault`.
//
// Convenções lidas (todas declaráveis em `vault`, com o padrão entre parênteses):
//   - `decisions` (decisions/): um arquivo por mês, `AAAA-MM.md`, com log de append.
//     Cada entrada é um bullet `- **AAAA-MM-DD · <decisão>**. Contexto: <uma linha>.
//     Notas: [[nota]], log [[sessão]].`
//   - `learnings` (resources/learnings/): um arquivo por tema, com as lições em
//     bullets `- **AAAA-MM-DD · <regra>**: <caso>` e sub-bullet `- caso: [[nota]]`.
//   - `recall` (resources/teste-de-recall.md): `status` no frontmatter e a tabela
//     markdown da seção `## Resultados`.
//   - `memory` (MEMORY.md): as regras sempre ligadas, uma por seção `##` ou por
//     parágrafo com título em negrito.
//
// Nada de corpo bruto sai daqui: cada campo é uma linha, o wikilink sai sem sintaxe
// para a tela e o slug fica disponível para ligar. Nota com `visibility: private`
// entra na contagem sem entregar título nem entrada.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parseFrontmatter } from './vault-today.mjs';

// Padrões quando o layout não declara o caminho.
export const DEFAULT_DECISIONS_FOLDER = 'decisions';
export const DEFAULT_LEARNINGS_FOLDER = 'resources/learnings';
export const DEFAULT_RECALL_NOTE = 'resources/teste-de-recall.md';
export const DEFAULT_MEMORY_NOTE = 'MEMORY.md';
// Quantas lições de cada tema a tela mostra sem abrir a nota.
export const LATEST_LESSONS = 3;
// Seção da tabela de resultados do teste de recall.
export const RECALL_RESULTS_SECTION = 'Resultados';

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Entrada de decisão e lição começam igual: `- **AAAA-MM-DD · <afirmação>**`.
const ENTRY_RE = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\s*·\s*([\s\S]*?)\*\*\s*(.*)$/;
const CASE_RE = /^\s+-\s+caso:\s*(.+)$/;

function inside(root, ref) {
  if (typeof ref !== 'string' || !ref || isAbsolute(ref)) return false;
  const target = resolve(root, ref);
  const brainRoot = resolve(root);
  return target === brainRoot || target.startsWith(`${brainRoot}${sep}`);
}

function markdownFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md')
        && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// Identificador estável e sem nada do nome do arquivo, que num tema privado é o próprio
// assunto. Serve para a tela ligar a linha sem receber o slug.
function opaqueId(slug) {
  return createHash('sha256').update(slug).digest('hex').slice(0, 12);
}

// Texto pronto para a tela: sem sintaxe de wikilink, sem negrito e numa linha.
function plain(value) {
  return String(value ?? '')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// `[[slug|Rótulo]]` vira `{ slug, title }`: o slug liga, o título mostra.
function wikiRefs(value) {
  return [...String(value ?? '').matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)]
    .map((match) => ({ slug: match[1].trim(), title: (match[2] || match[1]).trim() }))
    .filter((ref) => ref.slug);
}

function dedupeRefs(refs) {
  const seen = new Map();
  for (const ref of refs) if (!seen.has(ref.slug)) seen.set(ref.slug, ref);
  return [...seen.values()];
}

function body(text) {
  return String(text || '').replace(/^---[\s\S]*?\r?\n---/, '');
}

function heading(text, fallback) {
  const match = /^#\s+(.+)$/m.exec(body(text));
  return match ? plain(match[1]) : fallback;
}

// Bullets `- **data · afirmação** resto` de um corpo, com os sub-bullets de cada um.
// Linha indentada pertence ao bullet anterior — é onde mora o `caso:`.
function datedBullets(text) {
  const found = [];
  for (const line of body(text).split(/\r?\n/)) {
    const match = ENTRY_RE.exec(line);
    if (match) {
      found.push({ date: match[1], claim: match[2], rest: match[3], nested: [] });
      continue;
    }
    if (/^\s+\S/.test(line) && found.length) found.at(-1).nested.push(line);
  }
  return found;
}

// Mais novo primeiro. Entre datas iguais, a ordem do documento é preservada.
function newestFirst(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => String(right.item.date).localeCompare(String(left.item.date))
      || left.index - right.index)
    .map((entry) => entry.item);
}

// Uma entrada do log mensal: a decisão, o contexto numa linha, as notas afetadas e o
// log de sessão (o wikilink marcado como `log`).
function decisionEntry(bullet) {
  const rest = bullet.rest;
  const notesAt = rest.search(/\bNotas?:/);
  const refsPart = notesAt >= 0 ? rest.slice(notesAt).replace(/^\s*Notas?:\s*/, '') : '';
  const contextPart = notesAt >= 0 ? rest.slice(0, notesAt) : rest;
  const contextMatch = /Contexto:\s*([\s\S]*)$/.exec(contextPart);
  const sessionMatch = /\blog\s*\[\[([^\]|#]+)/.exec(refsPart);
  const session = sessionMatch ? sessionMatch[1].trim() : null;
  return {
    date: bullet.date,
    decision: plain(bullet.claim),
    context: plain(contextMatch ? contextMatch[1] : contextPart).replace(/^[.·\-\s]+/, '') || null,
    notes: dedupeRefs(wikiRefs(refsPart)).filter((ref) => ref.slug !== session),
    session,
  };
}

// Um mês do log. Nota privada entra com contagem e sem entrada: a decisão citaria a
// nota que o dono mandou esconder.
function decisionMonth(root, folder, name) {
  const slug = name.slice(0, -3);
  const text = readText(resolve(root, folder, name));
  const meta = parseFrontmatter(text || '');
  const isPrivate = meta.visibility === 'private';
  const entries = newestFirst(datedBullets(text || '').map(decisionEntry));
  return {
    month: slug,
    title: isPrivate ? null : heading(text, slug),
    path: isPrivate ? null : join(folder, name),
    private: isPrivate,
    readable: text !== null,
    updated: typeof meta.updated === 'string' ? meta.updated : null,
    count: entries.length,
    entries: isPrivate ? [] : entries,
  };
}

// Linha do tempo de decisões: um mês por arquivo `AAAA-MM.md`, mais novo primeiro.
function decisionTimeline(root, config) {
  const declared = typeof config.decisions === 'string' && config.decisions
    ? config.decisions
    : DEFAULT_DECISIONS_FOLDER;
  if (!inside(root, declared) || !existsSync(resolve(root, declared))) {
    return { available: false, reason_code: 'vault-decisions-folder-missing' };
  }
  const months = markdownFiles(resolve(root, declared))
    .filter((name) => MONTH_RE.test(name.slice(0, -3)))
    .map((name) => decisionMonth(root, declared, name))
    .sort((left, right) => right.month.localeCompare(left.month));
  return {
    available: true,
    folder: declared,
    months,
    counts: {
      months: months.length,
      entries: months.reduce((total, month) => total + month.count, 0),
    },
  };
}

// Um tema de lição: a contagem inteira, as três mais novas e os casos ligados.
function lessonTheme(root, folder, name) {
  const slug = name.slice(0, -3);
  const text = readText(resolve(root, folder, name));
  const meta = parseFrontmatter(text || '');
  const isPrivate = meta.visibility === 'private';
  const lessons = newestFirst(datedBullets(text || '').map((bullet) => ({
    date: bullet.date,
    rule: plain(bullet.claim),
    cases: dedupeRefs(bullet.nested.flatMap((line) => {
      const match = CASE_RE.exec(line);
      return match ? wikiRefs(match[1]) : [];
    })),
  })));
  return {
    // Tema privado entra na contagem com id opaco e sem slug: o nome do arquivo é o
    // assunto que o dono mandou esconder.
    id: opaqueId(slug),
    slug: isPrivate ? null : slug,
    title: isPrivate ? null : heading(text, slug),
    path: isPrivate ? null : join(folder, name),
    private: isPrivate,
    readable: text !== null,
    updated: typeof meta.updated === 'string' ? meta.updated : null,
    count: lessons.length,
    latest: isPrivate ? [] : lessons.slice(0, LATEST_LESSONS),
    cases: isPrivate ? [] : dedupeRefs(lessons.flatMap((lesson) => lesson.cases)),
  };
}

// Lições por tema, do tema com mais lição para o com menos.
function lessonsByTheme(root, config) {
  const declared = typeof config.learnings === 'string' && config.learnings
    ? config.learnings
    : DEFAULT_LEARNINGS_FOLDER;
  if (!inside(root, declared) || !existsSync(resolve(root, declared))) {
    return { available: false, reason_code: 'vault-learnings-folder-missing' };
  }
  const themes = markdownFiles(resolve(root, declared))
    .map((name) => lessonTheme(root, declared, name))
    // Empate de contagem continua em ordem de nome; tema privado, que não entrega nome,
    // se ordena pelo id — determinístico sem revelar nada.
    .sort((left, right) => right.count - left.count
      || String(left.slug || left.id).localeCompare(String(right.slug || right.id)));
  return {
    available: true,
    folder: declared,
    themes,
    counts: {
      themes: themes.length,
      lessons: themes.reduce((total, theme) => total + theme.count, 0),
    },
  };
}

// Regras promovidas: só o título de cada uma. O texto da regra fica na nota, porque
// a tela não precisa dele para dizer quantas regras entram em toda sessão.
function promotedRules(root, config) {
  const declared = typeof config.memory === 'string' && config.memory
    ? config.memory
    : DEFAULT_MEMORY_NOTE;
  if (!inside(root, declared) || !existsSync(resolve(root, declared))) {
    return { available: false, reason_code: 'vault-memory-note-missing' };
  }
  const text = readText(resolve(root, declared));
  const rules = [];
  for (const line of body(text || '').split(/\r?\n/)) {
    const section = /^##\s+(.+?)\s*$/.exec(line);
    if (section) { rules.push(plain(section[1]).replace(/[.:]$/, '')); continue; }
    const bold = /^\*\*([^*]+)\*\*/.exec(line);
    if (bold) rules.push(plain(bold[1]).replace(/[.:]$/, ''));
  }
  return {
    available: true,
    path: declared,
    updated: typeof parseFrontmatter(text || '').updated === 'string' ? parseFrontmatter(text || '').updated : null,
    count: rules.length,
    rules,
  };
}

function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function number(value) {
  return /^-?\d+$/.test(String(value || '').trim()) ? Number(value) : null;
}

// Tabela da seção `## Resultados`: cabeçalho, separador e uma linha por rodada.
function recallRows(text) {
  const lines = body(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${RECALL_RESULTS_SECTION}\\s*$`).test(line));
  if (start < 0) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    const row = cells(line);
    if (!row) continue;
    if (row.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    if (!DATE_RE.test(row[0])) continue;
    rows.push({
      date: row[0],
      hits: number(row[1]),
      partials: number(row[2]),
      misses: number(row[3]),
      score: plain(row[4]) || null,
      failed: plain(row[5]) || null,
      fix: plain(row[6]) || null,
    });
  }
  return newestFirst(rows);
}

// Último resultado do recall, mais o anterior para a tela comparar as duas rodadas.
function recallResult(root, config) {
  const declared = typeof config.recall === 'string' && config.recall
    ? config.recall
    : DEFAULT_RECALL_NOTE;
  if (!inside(root, declared) || !existsSync(resolve(root, declared))) {
    return { available: false, reason_code: 'vault-recall-note-missing' };
  }
  const text = readText(resolve(root, declared));
  const meta = parseFrontmatter(text || '');
  const rows = recallRows(text);
  return {
    available: true,
    path: declared,
    title: heading(text, declared),
    status: typeof meta.status === 'string' ? meta.status : null,
    updated: typeof meta.updated === 'string' ? meta.updated : null,
    history: rows.length,
    latest: rows[0] || null,
    previous: rows[1] || null,
  };
}

// Aprendizado do vault. Fora do modo vault devolve `{ available: false }` e o Console
// mantém o comportamento da INEVITA — instalação sem vault não muda por este módulo.
export function vaultInsights(root, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { available: false };
  return {
    available: true,
    decisions: decisionTimeline(root, config),
    lessons: lessonsByTheme(root, config),
    memory: promotedRules(root, config),
    recall: recallResult(root, config),
  };
}
