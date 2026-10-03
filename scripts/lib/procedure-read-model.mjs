// Leitura dos procedimentos (SOPs) de um vault de notas tipadas, para o Console
// desenhar cada um como fluxo vertical. Só lê; nunca escreve no vault. Ativado
// quando .cerebro/layout.json declara a chave `vault`.
//
// Convenção de procedimento (nota markdown com `type: Procedure`):
//   - frontmatter pode trazer `sistema: "[[x]]"` (ou lista) ligando ao Sistema;
//   - `## Passos` traz a lista numerada; um passo pode começar com
//     `Quem: <papel>:` para declarar o papel responsável;
//   - um ramo mora dentro do passo como `Se <condição> → passo N` (ou `->`),
//     no próprio texto ou em sub-bullets, e um passo aceita vários ramos;
//   - `## Critério de pronto` traz bullets com a definição de pronto;
//   - qualquer outra seção `##` com lista numerada é outro fluxo do mesmo
//     procedimento, titulado pelo próprio cabeçalho.
// Procedimento escrito antes da convenção (passos numerados, sem papel e sem
// ramo) continua sendo lido: vira um fluxo linear.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parseFrontmatter, sectionBullets } from './vault-today.mjs';

// Pasta padrão dos procedimentos quando o layout não declara `vault.procedures`.
export const DEFAULT_PROCEDURES_FOLDER = 'procedures';
// Seção que define pronto — nunca é lida como fluxo.
export const DONE_SECTION = 'Critério de pronto';
// Ramo de decisão dentro de um passo: `Se <condição> → passo N` (aceita `->`).
const BRANCH_RE = /\bse\s+([^\n]+?)\s*(?:→|->)\s*passo\s+(\d+)/gi;
// Papel responsável por um passo: `Quem: <papel>: <ação>`.
const ROLE_RE = /^Quem:\s*([^:]{1,60}?)\s*:\s*(.*)$/;

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

// Texto pronto para a tela: sem sintaxe de wikilink e sem negrito. O alvo do link
// continua disponível em `sistema_refs`, que é o que a tela usa para ligar.
function plain(value) {
  return String(value ?? '')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g, '$1')
    .replace(/\*\*/g, '')
    .trim();
}

// `[[slug|Rótulo]]` vira `{ slug, title }`: o slug liga, o título mostra.
function wikiRefs(values) {
  return [].concat(values || []).flatMap((value) => [...String(value).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)]
    .map((match) => ({ slug: match[1].trim(), title: (match[2] || match[1]).trim() }))
    .filter((ref) => ref.slug));
}

function heading(text, fallback) {
  const match = /^#\s+(.+)$/m.exec(text || '');
  return match ? plain(match[1]) : fallback;
}

function body(text) {
  return String(text || '').replace(/^---[\s\S]*?\r?\n---/, '');
}

// Seções `## Nome` na ordem do documento, cada uma com o próprio corpo.
function sections(text) {
  const lines = body(text).split(/\r?\n/);
  const found = [];
  let current = null;
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = { title: plain(match[1]), lines: [] };
      found.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return found.map((section) => ({ title: section.title, text: section.lines.join('\n') }));
}

function branchesOf(line) {
  return [...plain(line).matchAll(BRANCH_RE)].map((match) => ({
    condition: match[1].trim().replace(/[.,;:]$/, ''),
    target: Number(match[2]),
  }));
}

function isOnlyBranch(line) {
  const text = plain(line);
  const branches = branchesOf(text);
  if (branches.length !== 1) return false;
  return /^se\s/i.test(text) && /passo\s+\d+\s*[.;]?$/i.test(text);
}

// Passos numerados de um corpo de seção. Linha indentada (sub-bullet ou
// continuação) pertence ao passo anterior: ramo vira ramo, o resto vira detalhe.
function stepsOf(text) {
  const raw = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const start = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (start) {
      raw.push({ n: Number(start[1]), lines: [start[2]] });
      continue;
    }
    const nested = /^\s+(?:[-*]\s+)?(\S.*)$/.exec(line);
    if (nested && raw.length) raw.at(-1).lines.push(nested[1]);
  }
  return raw.map((step) => {
    const first = plain(step.lines[0]);
    const role = ROLE_RE.exec(first);
    const branches = step.lines.flatMap(branchesOf);
    const details = step.lines.slice(1).map(plain).filter((line) => line && !isOnlyBranch(line));
    return {
      n: step.n,
      text: role ? role[2].trim() : first,
      role: role ? role[1].trim() : null,
      branches,
      details,
    };
  });
}

function flowId(title, index) {
  const slug = title.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || `fluxo-${index + 1}`;
}

// Fluxos do procedimento: cada seção `##` com lista numerada é um fluxo, na ordem
// do documento. Sem nenhuma seção com passos, a própria nota vale como fluxo único.
function flowsOf(text) {
  const flows = [];
  sections(text).forEach((section, index) => {
    if (section.title === DONE_SECTION) return;
    const steps = stepsOf(section.text);
    if (steps.length) flows.push({ id: flowId(section.title, index), title: section.title, steps });
  });
  if (flows.length) return flows;
  const steps = stepsOf(body(text));
  return steps.length ? [{ id: 'passos', title: 'Passos', steps }] : [];
}

// Critério de pronto: bullets da seção. Procedimento escrito antes da convenção
// escreve a definição de pronto em prosa — nesse caso cada linha vale como item.
function doneOf(text) {
  const bullets = sectionBullets(text, DONE_SECTION, 20);
  if (bullets.length) return bullets;
  const section = sections(text).find((item) => item.title === DONE_SECTION);
  if (!section) return [];
  return section.text.split(/\r?\n/).map(plain).filter(Boolean).slice(0, 20);
}

function procedure(root, folder, name, { reveal }) {
  const slug = name.slice(0, -3);
  let text = '';
  let readable = true;
  try { text = readFileSync(resolve(root, folder, name), 'utf8'); } catch { readable = false; }
  const meta = parseFrontmatter(text);
  const isPrivate = meta.visibility === 'private';
  const open = !isPrivate || reveal;
  const flows = flowsOf(text);
  return {
    slug,
    // Nota privada entra na lista sem título, sem caminho e sem passos: o caminho
    // revelaria o título e o passo revelaria o conteúdo. `?reveal=1` manda tudo.
    title: open ? heading(text, slug) : null,
    path: open ? join(folder, name) : null,
    private: isPrivate,
    readable,
    status: typeof meta.status === 'string' ? meta.status : null,
    updated: typeof meta.updated === 'string' ? meta.updated : null,
    sistema_refs: open ? wikiRefs(meta.sistema ?? meta.sistemas) : [],
    flows: open ? flows : [],
    done: open ? doneOf(text) : [],
    flow_count: flows.length,
    step_count: flows.reduce((total, flow) => total + flow.steps.length, 0),
  };
}

// Procedimentos do vault. Fora do modo vault (ou sem a pasta declarada) devolve
// `{ available: false }` e o Console não mostra a tela — instalação da INEVITA
// não muda de comportamento por causa deste módulo.
export function vaultProcedures(root, config, { reveal = false } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { available: false };
  const declared = typeof config.procedures === 'string' && config.procedures
    ? config.procedures
    : DEFAULT_PROCEDURES_FOLDER;
  if (!inside(root, declared) || !existsSync(resolve(root, declared))) {
    return { available: false, reason_code: 'vault-procedures-folder-missing' };
  }
  const procedures = markdownFiles(resolve(root, declared))
    .map((name) => procedure(root, declared, name, { reveal }));
  return {
    available: true,
    folder: declared,
    procedures,
    counts: {
      procedures: procedures.length,
      flows: procedures.reduce((total, item) => total + item.flow_count, 0),
      steps: procedures.reduce((total, item) => total + item.step_count, 0),
    },
  };
}
