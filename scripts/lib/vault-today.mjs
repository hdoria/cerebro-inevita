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
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!match) return {};
  const data = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { data[listKey].push(unquote(item[1])); continue; }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (raw === '') { data[key] = []; listKey = key; continue; }
    listKey = null;
    data[key] = raw.startsWith('[') && raw.endsWith(']')
      ? raw.slice(1, -1).split(',').map((value) => unquote(value.trim())).filter(Boolean)
      : unquote(raw);
  }
  return data;
}

function unquote(value) {
  return String(value).trim().replace(/^["']|["']$/g, '');
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
