// Leitura das notas de um vault tipado para alimentar as telas do Console que hoje
// dependem de recibos do protocolo da INEVITA. Só lê; nunca escreve no vault.
// Ativado quando .cerebro/layout.json declara a chave `vault`.
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { parseFrontmatter } from './vault-today.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// Janela do "Contexto vigente": nota atualizada nos últimos 90 dias.
export const CURRENT_CONTEXT_DAYS = 90;
// Seção que marca uma fonte como destilada (a leitura virou uso declarado).
export const DISTILLED_SECTION = 'Para que pode servir';

function inside(root, ref) {
  if (typeof ref !== 'string' || !ref || isAbsolute(ref)) return false;
  const target = resolve(root, ref);
  const brainRoot = resolve(root);
  return target === brainRoot || target.startsWith(`${brainRoot}${sep}`);
}

// Varredura das notas markdown de uma raiz de conhecimento: ignora pastas ocultas e
// node_modules, e devolve o conteúdo já lido para quem precisa de links, frontmatter
// ou seções — uma leitura por arquivo, não uma por pergunta.
export function knowledgeNotes(root, knowledgeRoot) {
  const base = resolve(root, knowledgeRoot);
  const notes = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const relative = full.slice(base.length + 1);
        let content = '';
        let readable = true;
        try { content = readFileSync(full, 'utf8'); } catch { readable = false; }
        notes.push({
          relative,
          domain: relative.includes('/') ? relative.slice(0, relative.indexOf('/')) : '·raiz',
          slug: relative.slice(relative.lastIndexOf('/') + 1, -3),
          content,
          readable,
        });
      }
    }
  };
  walk(base);
  return notes;
}

// `visibility: private` no frontmatter — o dono marca a nota; o Console respeita.
export function isPrivateNote(note) {
  return parseFrontmatter(note.content).visibility === 'private';
}

function hasSection(content, section) {
  const name = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+${name}\\s*$`, 'm').test(content || '');
}

function isTrue(value) {
  return value === true || value === 'true';
}

function inboxCount(root, ref) {
  try {
    return readdirSync(resolve(root, ref), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md')
        && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
      .length;
  } catch { return null; }
}

// Estados da memória medidos pelo próprio vault, para substituir os constantes
// "não instrumentado" do Console. Fora do modo vault devolve `{ available: false }`
// e o Console mantém o comportamento da INEVITA.
export function vaultMemoryLifecycle(root, config, { knowledgeRoot = '.', now = new Date() } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { available: false };
  const inboxRef = inside(root, config.inbox) ? config.inbox : null;
  const raw = inboxRef ? inboxCount(root, inboxRef) : null;
  const notes = inside(root, knowledgeRoot) ? knowledgeNotes(root, knowledgeRoot) : [];
  const today = now.toISOString().slice(0, 10);
  const cutoff = new Date(Date.parse(`${today}T12:00:00Z`) - CURRENT_CONTEXT_DAYS * DAY_MS).toISOString().slice(0, 10);

  let processed = 0;
  let distilled = 0;
  let current = 0;
  for (const note of notes) {
    const meta = parseFrontmatter(note.content);
    if (isTrue(meta._organized)) processed += 1;
    if (meta.type === 'Source' && hasSection(note.content, DISTILLED_SECTION)) distilled += 1;
    const updated = typeof meta.updated === 'string' && DATE_RE.test(meta.updated) ? meta.updated : null;
    if (updated && updated >= cutoff) current += 1;
  }

  return {
    available: true,
    window_days: CURRENT_CONTEXT_DAYS,
    steps: [
      Number.isInteger(raw)
        ? { id: 'raw', name: 'Bruto', measured: true, measured_by: 'vault', value: raw, unit: `medido pelo vault: notas em ${inboxRef}/` }
        : { id: 'raw', name: 'Bruto', measured: false, value: null, reason_code: 'vault-inbox-not-declared' },
      {
        id: 'processed',
        name: 'Processado',
        measured: true,
        measured_by: 'vault',
        value: processed,
        unit: 'medido pelo vault: notas com _organized: true',
      },
      {
        id: 'distilled',
        name: 'Destilado',
        measured: true,
        measured_by: 'vault',
        value: distilled,
        unit: `medido pelo vault: fontes com seção "${DISTILLED_SECTION}"`,
      },
      {
        id: 'current-context',
        name: 'Contexto vigente',
        measured: true,
        measured_by: 'vault',
        value: current,
        unit: `medido pelo vault: notas atualizadas nos últimos ${CURRENT_CONTEXT_DAYS} dias`,
      },
    ],
  };
}
