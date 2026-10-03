// Leitura do "agora" de um vault de notas tipadas (frontmatter YAML + wikilinks),
// para Cérebros que não seguem o protocolo de rotinas da INEVITA. Só lê; nunca
// escreve no vault. Ativado quando .cerebro/layout.json declara a chave `vault`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function inside(root, ref) {
  if (typeof ref !== 'string' || !ref || isAbsolute(ref)) return false;
  const target = resolve(root, ref);
  const brainRoot = resolve(root);
  return target === brainRoot || target.startsWith(`${brainRoot}${sep}`);
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function markdownFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
      .map((entry) => entry.name);
  } catch { return []; }
}

// Subconjunto de YAML usado pelos vaults: `chave: valor`, `chave: [a, b]` e listas `  - item`.
//
// `objectLists` nomeia as chaves cuja lista é de objetos simples (`- papel: agenda` com
// continuação indentada, inclusive uma lista de texto dentro do objeto). É opt-in porque
// um bullet de texto livre pode conter dois-pontos: fora dessas chaves, item de lista
// continua sendo texto, exatamente como antes.
export function parseFrontmatter(text, { objectLists = [] } = {}) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!match) return {};
  const objectKeys = new Set(objectLists);
  const data = {};
  let listKey = null;
  let itemIndent = 0;
  let current = null;
  let nestedKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const indent = item[1].length;
      if (current && nestedKey && indent > itemIndent) {
        current[nestedKey].push(unquote(item[2]));
        continue;
      }
      if (!objectKeys.has(listKey)) {
        data[listKey].push(unquote(item[2]));
        continue;
      }
      itemIndent = indent;
      current = {};
      nestedKey = null;
      data[listKey].push(current);
      const inner = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(item[2]);
      if (inner) assign(current, inner[1], inner[2], (key) => { nestedKey = key; });
      continue;
    }
    const pair = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, indentation, key, raw] = pair;
    if (indentation.length) {
      // Continuação de um objeto aberto dentro de uma lista de objetos.
      if (current) assign(current, key, raw, (nested) => { nestedKey = nested; });
      continue;
    }
    listKey = null;
    current = null;
    nestedKey = null;
    if (raw === '') { data[key] = []; listKey = key; itemIndent = 0; continue; }
    data[key] = scalar(raw);
  }
  return data;
}

function assign(target, key, raw, openList) {
  if (raw === '') {
    target[key] = [];
    openList(key);
    return;
  }
  target[key] = scalar(raw);
  openList(null);
}

function scalar(raw) {
  return raw.startsWith('[') && raw.endsWith(']')
    ? raw.slice(1, -1).split(',').map((value) => unquote(value.trim())).filter(Boolean)
    : unquote(raw);
}

// Só par de aspas que abre e fecha o valor inteiro é delimitador. Aspa solta no fim de
// uma frase (`... com a pergunta "ainda é Active?"`) é conteúdo: tirá-la truncava o texto
// que entra no contrato.
function unquote(value) {
  const text = String(value).trim();
  const paired = /^"([\s\S]*)"$/.exec(text) || /^'([\s\S]*)'$/.exec(text);
  return paired ? paired[1] : text;
}

function title(text, fallback) {
  const heading = /^#\s+(.+)$/m.exec(text || '');
  return heading ? heading[1].trim() : fallback;
}

function linkTargets(values) {
  return [].concat(values || []).flatMap((value) => [...String(value).matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()));
}

// Bullets de uma seção `## Nome` (ou da nota inteira, sem `section`), sem sintaxe de wikilink.
export function sectionBullets(text, section, limit = 8) {
  let body = (text || '').replace(/^---[\s\S]*?\n---/, '');
  if (section) {
    const start = body.search(new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
    if (start < 0) return [];
    body = body.slice(start).split('\n').slice(1).join('\n');
    const next = body.search(/^##\s+/m);
    if (next >= 0) body = body.slice(0, next);
  }
  return body.split('\n')
    .map((line) => /^\s*(?:[-*]|\d+\.)\s+(?:\[[ x]\]\s+)?(.+)$/.exec(line)?.[1])
    .filter(Boolean)
    .map((line) => line.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\*\*/g, '').trim())
    .slice(0, limit);
}

function focus(root, refs) {
  for (const ref of refs) {
    if (!inside(root, ref)) continue;
    const text = readText(resolve(root, ref));
    if (text === null) continue;
    const items = ref.endsWith('home.md') ? sectionBullets(text, 'Foco agora') : sectionBullets(text);
    if (items.length) return { ref, items };
  }
  return { ref: null, items: [] };
}

function daily(root, dir, today) {
  const dates = markdownFiles(resolve(root, dir)).map((name) => name.slice(0, -3)).filter((name) => DATE_RE.test(name) && name <= today).sort();
  const date = dates.at(-1);
  if (!date) return null;
  const text = readText(resolve(root, dir, `${date}.md`));
  return {
    date,
    ref: join(dir, `${date}.md`),
    is_today: date === today,
    priorities: sectionBullets(text, 'Prioridades'),
  };
}

function notes(root, dir) {
  return markdownFiles(resolve(root, dir)).map((name) => {
    const text = readText(resolve(root, dir, name)) || '';
    const slug = name.slice(0, -3);
    return { slug, ref: join(dir, name), title: title(text, slug), meta: parseFrontmatter(text) };
  });
}

export function vaultToday(root, config, { now = new Date() } = {}) {
  if (!config || typeof config !== 'object') return { available: false };
  const dirs = {};
  for (const key of ['daily', 'inbox', 'projects', 'areas']) {
    dirs[key] = inside(root, config[key]) ? config[key] : null;
  }
  const staleDays = Number.isInteger(config.staleDays) && config.staleDays > 0 ? config.staleDays : 7;
  const today = now.toISOString().slice(0, 10);
  const projects = dirs.projects ? notes(root, dirs.projects) : [];
  const active = projects.filter((project) => project.meta.status === 'Active');
  const stale = active
    .map((project) => {
      const updated = DATE_RE.test(project.meta.updated || '') ? project.meta.updated : null;
      const days = updated ? Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${updated}T12:00:00Z`)) / DAY_MS) : null;
      return { slug: project.slug, title: project.title, ref: project.ref, updated, days };
    })
    .filter((project) => project.days === null || project.days >= staleDays)
    .sort((left, right) => (right.days ?? Infinity) - (left.days ?? Infinity));
  const areas = (dirs.areas ? notes(root, dirs.areas) : []).map((area) => {
    const linked = active.filter((project) => linkTargets([project.meta.belongs_to, project.meta.related_to]).includes(area.slug));
    return { slug: area.slug, title: area.title, ref: area.ref, status: area.meta.status || null, active_projects: linked.length };
  }).sort((left, right) => right.active_projects - left.active_projects);
  return {
    available: true,
    today,
    focus: focus(root, Array.isArray(config.focus) ? config.focus : []),
    daily: dirs.daily ? daily(root, dirs.daily, today) : null,
    inbox: dirs.inbox && existsSync(resolve(root, dirs.inbox)) ? { ref: dirs.inbox, count: markdownFiles(resolve(root, dirs.inbox)).length } : null,
    projects: { active: active.length, stale_days: staleDays, stale: stale.slice(0, 10), stale_total: stale.length },
    areas,
  };
}
