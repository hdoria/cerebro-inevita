// Importação do histórico de sessões de IA de um vault tipado em Run Records v2.
//
// O vault guarda uma nota por sessão de trabalho (`ai/sessions/<data>-<tema>.md`) e uma
// daily por dia (`journal/<data>.md`) com a seção `## Log de agentes`, onde cada bullet
// nomeia o ator e as ferramentas que ele chamou. Este módulo lê as duas coisas e grava,
// no ledger do layout, um Run Record v2 por sessão classificada:
//
//   - o Sistema sai, primeiro, do nome do arquivo e das tags (a sessão é run de uma skill);
//   - o que não é run de skill vira run do Sistema da Área em que o trabalho aconteceu
//     (um Sistema por Área, `sessoes-<area>`), e a Área sai de evidência declarada na nota:
//     tag, `related_to` e token que casa com projeto da Área — nunca do assunto do texto;
//   - o `context_snapshot` sai das fontes nomeadas no Log de agentes do mesmo dia,
//     filtradas pelas fontes que o System Contract daquele Sistema declara;
//   - sem fonte no log, o Run Record declara a fonte `vault` (a própria nota é a evidência)
//     e registra a lacuna, em vez de inventar acesso;
//   - `eval.passed` só vira `true` quando a sessão tem `## Verificação` com conteúdo;
//   - `human_decision` fica sempre em `pending`: aprovação não registrada não se inventa.
//
// Só lê o vault; a única escrita é no ledger de runs (dentro de `.cerebro/runtime/`, fora
// do Git). Nunca copia conteúdo da sessão: o que entra no recibo é caminho, slug, data e
// vocabulário fixo deste módulo.
//
// **O importador é dono das suas linhas no ledger.** Os recibos daqui não são eventos de
// execução: são uma projeção do vault, do mesmo jeito que o System Contract é projeção da
// nota. Projeção precisa ser regenerável, então este módulo reescreve o próprio bloco do
// ledger e preserva byte a byte toda linha de outra ferramenta, na ordem em que estava — a
// mesma regra que o compilador de contratos já segue ("remove só os próprios órfãos;
// contrato criado por outra ferramenta não é tocado", em AGENTS.md).
//
// Append também funcionaria para *corrigir* (todo leitor usa `latestRunRecords`, o último
// registro de cada `run_id`), mas não para *retirar*: Run Record v2 só aceita `started` ou
// `completed`, não existe status de retratação. Sem reescrever, uma sessão que perdeu a
// classificação — como as que a regra apertada do `cerebro` desmentiu — ficaria no ledger
// para sempre como run de um Sistema que ela nunca rodou. Ledger que não se corrige não é
// auditável, é só antigo.
//
// A linha é reconhecida como deste importador por `extensions.import_origin`. Ferramenta
// que enriquecer um recibo importado precisa trocar esse marcador para assumir a posse.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { layout, readJson, validateRunRecord } from './system-protocol.mjs';
import { parseFrontmatter } from './vault-today.mjs';

const DATED_NOTE_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Seção da daily que registra o que cada agente fez e com que ferramenta.
export const AGENT_LOG_SECTION = 'Log de agentes';
// Seção que marca a sessão como verificada; sem ela, `eval.passed` fica nulo.
export const VERIFICATION_SECTION = 'Verificação';
// Marcador de histórico sem evidência de verificação nem de aprovação.
export const UNVERIFIED_MARKER = 'legacy-unverified';
export const VERIFIED_MARKER = 'legacy-verified';
// Papel usado nas referências de entidade derivadas de `related_to`.
const ENTITY_ROLE = 'nota-relacionada';
// Fonte de recaída: a própria nota de sessão é evidência do vault.
const VAULT_SOURCE_ID = 'vault';
// Marcador de posse: linha do ledger com este `extensions.import_origin` é deste módulo.
export const IMPORT_ORIGIN = 'vault-session-note';

// Padrões de dado pessoal. Nenhum valor do Run Record pode casar com eles: o importador
// recusa a sessão inteira e reporta, em vez de gravar um recibo com PII.
const PII_PATTERNS = [
  ['cpf', /\b\d{3}\.?\d{3}\.?\d{3}-\d{2}\b/],
  ['cnpj', /\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-\d{2}\b/],
  // O separador entre os dois últimos grupos é obrigatório: sem ele, qualquer corrida de
  // dígitos de um hash viraria "telefone" e o importador recusaria sessão sadia.
  ['telefone', /(?:\+?55[\s.-]?)?(?:\(\d{2}\)|\b\d{2})[\s.-]?9?\d{4}[\s.-]\d{4}(?!\d)/],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];
// Campos gerados por este módulo, não lidos do vault: o `run_id` é hash hexadecimal e
// varrê-lo só produz falso positivo.
const PII_EXEMPT_PATHS = new Set(['run_record.run_id']);

// Ferramentas nomeadas no Log de agentes → `source_id` da nota DataSource do vault.
// Só fonte externa entra aqui: wikilink é a saída da sessão, não fonte recuperada, e o
// vault fica reservado para a recaída declarada (com lacuna), para que "sem fonte" meça
// alguma coisa.
const SOURCE_SIGNALS = [
  ['gmail', /\bgmail\b/i],
  ['google-calendar', /\b(?:google\s+)?calendar\b|\bgoogle agenda\b/i],
  ['clickup', /\bclickup\b/i],
  ['jira', /\bjira\b|\batlassian\b/i],
  ['fireflies', /\bfireflies\b/i],
  ['granola', /\bgranola\b/i],
  ['apollo', /\bapollo\b/i],
  ['fontedata', /\bfontedata\b|\bfonte\s*data\b|\bdabra\b/i],
  ['deskdata', /\bdeskdata\b|\bdesk\s*data\b/i],
  ['whatsapp-evolution', /\bwhatsapp\b|\bevolution\b/i],
  ['web', /\bhttps?:\/\//i],
  ['claude-cowork', /\bcowork\b/i],
  ['repositorios-git', /\bgithub\b|\bgit\b|\brepositóri|\brepositori/i],
];

// Classificação declarada: primeiro padrão que casar manda. O tema é o nome do arquivo
// sem a data; as tags vêm do frontmatter. Sessão que não casa com nenhuma skill cai na
// classificação por Área (abaixo); só quando nem a Área tem evidência é que a sessão fica
// no balde `sessao-livre` e não é importada — Run Record exige `system_id` de um Sistema
// que existe, e contrato falso não se cria em silêncio.
export const FREE_SESSION_BUCKET = 'sessao-livre';

const CLASSIFIERS = [
  ['ingerir', 'tema-ingestao', ({ theme }) => /^ingestao(?:-|$)/.test(theme)],
  ['processar-inbox', 'tema-triagem', ({ theme }) => /^triagem(?:-|$)/.test(theme)],
  ['enriquecer-empresa', 'tema-enriquecimento', ({ theme }) => /^enriquecimento(?:-|$)/.test(theme)],
  ['reconciliar', 'tema-reconciliacao', ({ theme }) => /^reconciliacao(?:-|$)/.test(theme)],
  ['desafiar', 'tema-desafio', ({ theme, tags }) => /desafi/.test(theme) || tags.some((tag) => /desafi/.test(tag))],
  ['daily', 'daily', ({ tokens, tags }) => tokens.includes('daily') || tokens.includes('diario')
    || tags.includes('daily') || tags.includes('diario')],
  ['weekly-review', 'weekly', ({ tokens, tags }) => tokens.includes('weekly') || tokens.includes('review')
    || tags.includes('weekly') || tags.includes('review') || tags.includes('weekly-review')],
  // O Sistema `cerebro` é o boot da sessão (`/cerebro` → raio-X). A palavra "cerebro" no
  // nome do arquivo não prova nada: "copia-curso-segundo-cerebro-drive" é cópia de curso e
  // "trava-segredo-e-skill-cerebro" é obra na skill, não uma invocação dela. Por isso só
  // conta tag declarada ou um tema inequívoco de boot; "bootstrap" saiu da lista porque
  // bootstrap do vault é manutenção do cérebro, não abertura de sessão.
  ['cerebro', 'tag-ou-tema-de-boot', ({ theme, tags }) => tags.includes('cerebro') || tags.includes('boot')
    || tags.includes('raio-x') || tags.includes('ligar-cerebro')
    || /^(?:boot|raio-x|ligar-cerebro)(?:-|$)/.test(theme) || /^boot-(?:do-)?cerebro(?:-|$)/.test(theme)],
];

function inside(root, ref) {
  if (typeof ref !== 'string' || !ref || isAbsolute(ref)) return false;
  const target = resolve(root, ref);
  const base = resolve(root);
  return target === base || target.startsWith(`${base}${sep}`);
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function markdownFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
}

// Corpo bruto de uma seção `## Nome`, com os wikilinks intactos. `sectionBullets` do
// vault-today limpa a sintaxe de link, e aqui o texto cru é o que carrega os sinais.
export function rawSection(text, section) {
  const body = (text || '').replace(/^---[\s\S]*?\n---/, '');
  const pattern = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const start = body.search(pattern);
  if (start < 0) return null;
  const rest = body.slice(start).split('\n').slice(1).join('\n');
  const next = rest.search(/^##\s+/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

// `## Verificação` com conteúdo é a única evidência de verificação que o vault tem.
// Seção vazia ou ausente mantém `eval.passed` nulo.
export function hasVerification(text) {
  for (const name of [VERIFICATION_SECTION, 'Verificacao']) {
    const body = rawSection(text, name);
    if (body) return true;
  }
  return false;
}

// Fontes nomeadas no Log de agentes de um dia.
export function detectSources(logText) {
  const found = new Set();
  if (!logText) return found;
  for (const [sourceId, pattern] of SOURCE_SIGNALS) {
    if (pattern.test(logText)) found.add(sourceId);
  }
  return found;
}

function slugify(value) {
  const plain = String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return plain.slice(0, 127);
}

function tagList(meta) {
  return [].concat(meta.tags || []).map((tag) => slugify(tag)).filter(Boolean);
}

export function classifySession({ theme, tags }) {
  const tokens = theme.split('-').filter(Boolean);
  const input = { theme, tokens, tags };
  for (const [systemId, basis, test] of CLASSIFIERS) {
    if (test(input)) return { system_id: systemId, basis, reason: `regra:${basis}` };
  }
  return { system_id: null, basis: FREE_SESSION_BUCKET, reason: null };
}

// ── Classificação por Área ────────────────────────────────────────────────────────
// Sessão que não é run de uma skill vira run do Sistema da Área em que o trabalho
// aconteceu: um Sistema por Área, com `system_id` = `sessoes-<area>`. A Área nunca sai do
// assunto do texto; ela sai de evidência declarada na nota, em três degraus:
//
//   a) `tags` que são slug de uma Área do vault ou um dos aliases abaixo;
//   b) `related_to`: wikilink para a nota de Área, ou para projeto/empresa cujo
//      `belongs_to` (ou, na falta dele, `related_to`) chega numa Área;
//   c) token do H1 ou do nome do arquivo que casa com o slug de um projeto/empresa que
//      pertence a uma Área.
//
// Dentro de cada degrau vale a maioria; empate desce para o degrau seguinte, porque mais
// evidência é melhor que desistir. Sem vencedor em nenhum degrau, a sessão só vira
// `hugo-os` quando o trabalho é sobre o próprio cérebro (os tokens de manutenção abaixo);
// o resto fica sem classificação e é contado no relatório, nunca chutado.
export const AREA_SYSTEM_PREFIX = 'sessoes-';
// Área do cérebro sobre si mesmo. É a única Área que a recaída pode escolher, e só com
// token de manutenção; não é destino de sessão sem evidência.
export const MAINTENANCE_AREA = 'hugo-os';
// Vocabulário de manutenção do próprio cérebro: vault, skill, agentes, console, rotina.
// Serve de alias de tag para a Área do cérebro e de prova na recaída de empate.
export const MAINTENANCE_TOKENS = ['vault', 'skill', 'skills', 'agents', 'console', 'rotina', 'rotinas'];
// Aliases de tag → Área. Lista curta de propósito: cada linha é uma tag que a casa usa
// como sinônimo operacional da Área, não uma adivinhação de tema. `linkedin`, `instagram`
// e `carrossel` são os canais que a Área Conteúdo declara; `mentoria` e `porto-digital`
// são os dois nomes da mentoria. Alias cuja Área não existe no vault simplesmente não vota.
export const AREA_TAG_ALIASES = new Map([
  ['linkedin', 'conteudo'],
  ['instagram', 'conteudo'],
  ['carrossel', 'conteudo'],
  ['mentoria', 'mentoria-porto-digital'],
  ['porto-digital', 'mentoria-porto-digital'],
  ...MAINTENANCE_TOKENS.map((token) => [token, MAINTENANCE_AREA]),
]);
// Slug curto casa com qualquer coisa; só slug de projeto com quatro letras ou mais entra
// no degrau (c).
const MIN_PROJECT_SLUG = 4;

function wikilinks(value) {
  return [].concat(value || [])
    .flatMap((item) => [...String(item).matchAll(/\[\[([^\]|#]+)/g)].map((match) => match[1].trim()))
    .map((target) => slugify(target.includes('/') ? target.slice(target.lastIndexOf('/') + 1) : target))
    .filter(Boolean);
}

// Slugs das notas de Área e índice dos projetos/empresas com os elos que levam a uma Área.
export function areaIndex(root, config) {
  const areas = new Set();
  const notes = new Map();
  const areasRef = typeof config.areas === 'string' && config.areas ? config.areas : 'areas';
  if (inside(root, areasRef)) {
    for (const name of markdownFiles(resolve(root, areasRef))) areas.add(slugify(name.slice(0, -3)));
  }
  const refs = [
    ['project', typeof config.projects === 'string' && config.projects ? config.projects : 'projects'],
    ['company', domainEntryRef(root, 'empresas') || 'companies'],
  ];
  for (const [kind, ref] of refs) {
    if (!inside(root, ref)) continue;
    for (const name of markdownFiles(resolve(root, ref))) {
      const slug = slugify(name.slice(0, -3));
      if (!slug || areas.has(slug) || notes.has(slug)) continue;
      const meta = parseFrontmatter(readText(join(resolve(root, ref), name)) || '');
      notes.set(slug, { kind, belongs: wikilinks(meta.belongs_to), related: wikilinks(meta.related_to) });
    }
  }
  return { areas, notes };
}

// Áreas a que uma nota de projeto/empresa pertence. `belongs_to` manda; só quando ele não
// chega a nenhuma Área o `related_to` é consultado. Resolve em cadeia (projeto que pertence
// a projeto que pertence a Área) e para em ciclo.
export function resolveNoteAreas(slug, { areas, notes }, seen = new Set()) {
  if (areas.has(slug)) return [slug];
  const note = notes.get(slug);
  if (!note || seen.has(slug)) return [];
  seen.add(slug);
  for (const field of ['belongs', 'related']) {
    const found = [];
    for (const target of note[field]) {
      for (const area of resolveNoteAreas(target, { areas, notes }, seen)) {
        if (!found.includes(area)) found.push(area);
      }
    }
    if (found.length) return found;
  }
  return [];
}

function winner(votes) {
  const ranked = [...votes.entries()].sort((left, right) => right[1].count - left[1].count
    || left[0].localeCompare(right[0]));
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0][1].count === ranked[1][1].count) return null;
  return { area: ranked[0][0], reason: ranked[0][1].reason };
}

// Degrau (a): tags.
function votesByTag(tags, index) {
  const votes = new Map();
  for (const tag of tags) {
    const area = index.areas.has(tag) ? tag : AREA_TAG_ALIASES.get(tag);
    if (!area || !index.areas.has(area)) continue;
    const vote = votes.get(area) || { count: 0, reason: `tag:${tag}` };
    vote.count += 1;
    votes.set(area, vote);
  }
  return votes;
}

// Degrau (b): `related_to`.
function votesByRelated(related, index) {
  const votes = new Map();
  for (const target of related) {
    const resolved = index.areas.has(target) ? [target] : resolveNoteAreas(target, index);
    const kind = index.areas.has(target) ? 'area' : index.notes.get(target)?.kind;
    if (!kind) continue;
    for (const area of resolved) {
      const code = kind === 'area' ? `related:area:${target}` : `related:${kind}:${target}->${area}`;
      const vote = votes.get(area) || { count: 0, reason: code };
      vote.count += 1;
      votes.set(area, vote);
    }
  }
  return votes;
}

// Degrau (c): token do nome do arquivo ou do H1 que casa com slug de projeto/empresa.
function votesByToken(tokens, index) {
  const votes = new Map();
  for (const slug of [...index.notes.keys()].sort()) {
    if (slug.length < MIN_PROJECT_SLUG || !containsTokens(tokens, slug.split('-'))) continue;
    for (const area of resolveNoteAreas(slug, index)) {
      const code = `token:${index.notes.get(slug).kind}:${slug}->${area}`;
      const vote = votes.get(area) || { count: 0, reason: code };
      vote.count += 1;
      votes.set(area, vote);
    }
  }
  return votes;
}

function containsTokens(haystacks, needle) {
  return haystacks.some((tokens) => tokens.some((_, start) => needle
    .every((token, offset) => tokens[start + offset] === token)));
}

export function classifyArea({ tags, related, themeTokens, h1Tokens }, index) {
  const tokens = [themeTokens, h1Tokens];
  const tiers = [votesByTag(tags, index), votesByRelated(related, index), votesByToken(tokens, index)];
  let evidence = false;
  for (const votes of tiers) {
    if (votes.size) evidence = true;
    const chosen = winner(votes);
    if (chosen) return { area: chosen.area, reason: chosen.reason };
  }
  // Recaída: só manutenção do próprio cérebro, e só com token que prove isso.
  if (index.areas.has(MAINTENANCE_AREA)) {
    const proof = MAINTENANCE_TOKENS.find((token) => tags.includes(token) || containsTokens(tokens, [token]));
    if (proof) return { area: MAINTENANCE_AREA, reason: `manutencao:${proof}` };
  }
  return { area: null, reason: evidence ? 'empate' : 'sem-evidencia' };
}

// `run_id` estável, derivado só do caminho da nota: reimportar a mesma sessão devolve o
// mesmo id e o ledger não duplica. Formato UUID-like, dentro do padrão que o protocolo
// exige para `run_id` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`).
export function sessionRunId(sessionRef) {
  const digest = createHash('sha256').update(`vault-session:${sessionRef}`).digest('hex');
  const uuid = [
    digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32),
  ].join('-');
  return `run-sessao-${uuid}`;
}

function entityRefs(meta) {
  return [...new Set(wikilinks(meta.related_to))].map((id) => ({ role: ENTITY_ROLE, id }));
}

// Varredura de PII em todo valor de texto do recibo pronto. Sessão com qualquer casamento
// é recusada e contada; nenhum recibo com PII entra no ledger.
export function scanPii(value, path = 'run_record') {
  if (Array.isArray(value)) return value.flatMap((item, index) => scanPii(item, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => scanPii(item, `${path}.${key}`));
  }
  if (typeof value !== 'string' || PII_EXEMPT_PATHS.has(path)) return [];
  return PII_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([kind]) => `${path}: ${kind}`);
}

// Primeira referência de uma entrada do mapa da empresa (`companyMapDomains`), que é onde
// o layout declara onde cada tipo de nota mora.
function domainEntryRef(root, entryId) {
  const domains = layout(root).companyMapDomains;
  if (!Array.isArray(domains)) return null;
  for (const domain of domains) {
    for (const entry of domain?.entries || []) {
      if (entry?.id === entryId && typeof entry.refs?.[0] === 'string') return entry.refs[0];
    }
  }
  return null;
}

function sessionsDirectory(root, config) {
  if (typeof config.sessions === 'string' && config.sessions) return config.sessions;
  return domainEntryRef(root, 'sessoes') || join('ai', 'sessions');
}

function systemContracts(root) {
  const directory = resolve(root, layout(root).systemContracts || join('.cerebro', 'contracts', 'systems'));
  const contracts = new Map();
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch { return contracts; }
  for (const name of entries) {
    try {
      const contract = readJson(join(directory, name), name);
      if (typeof contract?.system_id === 'string') contracts.set(contract.system_id, contract);
    } catch { /* contrato ilegível não fabrica Sistema; a tela Saúde já o reporta */ }
  }
  return contracts;
}

function agentLogByDay(root, dailyDir) {
  const logs = new Map();
  const directory = resolve(root, dailyDir);
  for (const name of markdownFiles(directory)) {
    const date = name.slice(0, -3);
    if (!DATE_RE.test(date)) continue;
    const text = readText(join(directory, name));
    if (text === null) continue;
    logs.set(date, { ref: join(dailyDir, name), log: rawSection(text, AGENT_LOG_SECTION) });
  }
  return logs;
}

function buildAccesses(contract, detected, { date, slug, dailyRef }) {
  const declared = Array.isArray(contract.sources) ? contract.sources : [];
  const seen = new Set();
  const accesses = [];
  for (const source of declared) {
    if (!detected.has(source.source_id) || seen.has(source.source_id)) continue;
    seen.add(source.source_id);
    accesses.push({
      source_ref: { role: source.role, id: source.source_id },
      selected_refs: [`daily:${date}`],
      query: `fonte nomeada no Log de agentes da daily de ${date}`,
      filters: [],
      window: `dia ${date}`,
      freshness_marker: `observed:${date}`,
      assurance: 'exported',
    });
  }
  if (accesses.length) return { accesses, gaps: [] };
  const vaultRole = declared.find((source) => source.source_id === VAULT_SOURCE_ID)?.role || VAULT_SOURCE_ID;
  return {
    accesses: [{
      source_ref: { role: vaultRole, id: VAULT_SOURCE_ID },
      selected_refs: [`sessao:${slug}`],
      query: 'a própria nota de sessão como evidência do vault',
      filters: [],
      window: `dia ${date}`,
      freshness_marker: `observed:${date}`,
      assurance: 'exported',
    }],
    gaps: [{
      source_role: vaultRole,
      reason_code: dailyRef ? 'fonte-nao-nomeada-no-log-de-agentes' : 'daily-do-dia-ausente',
      detail_ref: dailyRef || null,
    }],
  };
}

function buildRunRecord({ contract, session, detected, dailyRef, verified }) {
  const { accesses, gaps } = buildAccesses(contract, detected, {
    date: session.date, slug: session.slug, dailyRef,
  });
  // A nota só tem a data, nunca a hora. Meio-dia UTC é o único instante que cai no mesmo
  // dia do calendário em qualquer fuso de UTC-11 a UTC+11: com meia-noite, o Console
  // mostraria a sessão no dia anterior para quem está no Brasil.
  const observedAt = `${session.date}T12:00:00.000Z`;
  const sourceRefs = [];
  const seen = new Set();
  for (const access of accesses) {
    const key = `${access.source_ref.role}:${access.source_ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sourceRefs.push({ ...access.source_ref });
  }
  return {
    protocol_version: 2,
    run_id: sessionRunId(session.ref),
    system_id: contract.system_id,
    system_version: contract.version,
    status: 'completed',
    started_at: observedAt,
    completed_at: observedAt,
    entity_refs: entityRefs(session.meta),
    source_refs: sourceRefs,
    output_refs: [session.ref],
    context_snapshot: {
      system_contract_version: contract.version,
      retrieval_version: contract.retrieval?.version || contract.version,
      observed_at: observedAt,
      accesses,
      gaps,
      fallbacks: [],
      conflicts: [],
    },
    eval: { version: contract.eval?.version || contract.version, passed: verified ? true : null },
    human_decision: 'pending',
    correction_ref: null,
    outcomes: [],
    privacy: { content_shared_with_inevita: false },
    extensions: {
      import_origin: IMPORT_ORIGIN,
      verification_state: verified ? VERIFIED_MARKER : UNVERIFIED_MARKER,
      session_ref: session.ref,
      daily_ref: dailyRef || null,
      classified_by: session.classification.basis,
      classification_reason: session.classification.reason,
    },
  };
}

// Primeiro `# título` do corpo. Entra só como tokens, para casar com slug de projeto:
// nenhum pedaço do texto da sessão é copiado para o recibo.
function headingTokens(text) {
  const body = (text || '').replace(/^---[\s\S]*?\n---/, '');
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? slugify(match[1]).split('-').filter(Boolean) : [];
}

// Lê as notas de sessão do vault e devolve o plano de importação. `confirm` grava;
// sem ele, nada é escrito e o relatório diz o que entraria.
export function importVaultSessionHistory(root, { confirm = false } = {}) {
  const config = layout(root).vault;
  if (!config || typeof config !== 'object') {
    return {
      mode: 'no-vault', sessions_ref: null, daily_ref: null, total: 0, per_system: {},
      free_sessions: [], missing_contract: {}, pii_refused: [], invalid: [], reasons: {},
      with_gap: 0, verified: 0, already_imported: 0, corrected: [], withdrawn: [], reemitted: 0,
      appended: [], records: [],
    };
  }
  const sessionsRef = sessionsDirectory(root, config);
  const dailyRef = typeof config.daily === 'string' && config.daily ? config.daily : 'journal';
  if (!inside(root, sessionsRef) || !inside(root, dailyRef)) {
    throw new Error('o layout aponta sessões ou dailies fora do Cérebro');
  }
  const contracts = systemContracts(root);
  const logs = agentLogByDay(root, dailyRef);
  const index = areaIndex(root, config);
  const ledger = partitionLedger(root);

  const report = {
    mode: 'vault',
    sessions_ref: sessionsRef,
    daily_ref: dailyRef,
    total: 0,
    per_system: {},
    free_sessions: [],
    missing_contract: {},
    pii_refused: [],
    invalid: [],
    reasons: {},
    with_gap: 0,
    verified: 0,
    already_imported: 0,
    corrected: [],
    withdrawn: [],
    reemitted: 0,
    appended: [],
    records: [],
  };

  // Pasta de sessões ausente (apagada ou repontada no layout) é zero sessão, não "nada a
  // fazer": o bloco deste importador precisa ser retirado do ledger como em qualquer
  // outra leitura, senão o run importado vive para sempre sem nota que o sustente.
  const directory = resolve(root, sessionsRef);
  const names = existsSync(directory) ? markdownFiles(directory) : [];

  for (const name of names) {
    const dated = DATED_NOTE_RE.exec(name);
    if (!dated) continue;
    const ref = join(sessionsRef, name);
    const text = readText(join(directory, name));
    if (text === null) continue;
    report.total += 1;
    const meta = parseFrontmatter(text);
    const date = DATE_RE.test(String(meta.created || '')) ? String(meta.created) : dated[1];
    const theme = slugify(dated[2]);
    const tags = tagList(meta);
    let classification = classifySession({ theme, tags });
    if (!classification.system_id) {
      // Não é run de skill: vira run do Sistema da Área, se a nota provar qual é.
      const area = classifyArea({
        tags,
        related: wikilinks(meta.related_to),
        themeTokens: theme.split('-').filter(Boolean),
        h1Tokens: headingTokens(text),
      }, index);
      report.reasons[area.reason] = (report.reasons[area.reason] || 0) + 1;
      if (!area.area) {
        report.free_sessions.push(ref);
        continue;
      }
      classification = { system_id: `${AREA_SYSTEM_PREFIX}${area.area}`, basis: 'area', reason: area.reason };
    } else {
      report.reasons[classification.reason] = (report.reasons[classification.reason] || 0) + 1;
    }
    const contract = contracts.get(classification.system_id);
    if (!contract) {
      report.missing_contract[classification.system_id] = (report.missing_contract[classification.system_id] || 0) + 1;
      continue;
    }
    const day = logs.get(date) || null;
    const record = buildRunRecord({
      contract,
      session: { ref, slug: name.slice(0, -3), date, meta, classification },
      detected: detectSources(day?.log),
      dailyRef: day?.ref || null,
      verified: hasVerification(text),
    });
    const pii = scanPii(record);
    if (pii.length) {
      report.pii_refused.push({ ref, matches: pii });
      continue;
    }
    const errors = validateRunRecord(record);
    if (errors.length) {
      report.invalid.push({ ref, errors });
      continue;
    }
    report.per_system[record.system_id] = (report.per_system[record.system_id] || 0) + 1;
    if (record.context_snapshot.gaps.length) report.with_gap += 1;
    if (record.eval.passed === true) report.verified += 1;
    report.records.push(record);
    const previous = ledger.owned.get(record.run_id);
    if (!previous) report.appended.push(record);
    else if (JSON.stringify(previous) === JSON.stringify(record)) report.already_imported += 1;
    else if (previous.system_id !== record.system_id) {
      // Mudança de Sistema é correção de classificação e sai nomeada no relatório; o resto
      // é só o recibo reemitido com o mesmo `run_id`.
      report.corrected.push({
        ref,
        from: previous.system_id,
        to: record.system_id,
        reason: record.extensions.classification_reason,
      });
    } else report.reemitted += 1;
  }

  // Órfão do próprio importador: run que ele gravou e que a leitura de hoje não sustenta
  // mais. Sai do bloco, com o Sistema que ele dizia ter rodado, para o relatório nomear.
  const current = new Set(report.records.map((record) => record.run_id));
  for (const [runId, record] of ledger.owned) {
    if (current.has(runId)) continue;
    report.withdrawn.push({
      ref: record.extensions?.session_ref || record.output_refs?.[0] || runId,
      from: record.system_id,
    });
  }

  const lines = [...ledger.kept, ...report.records.map((record) => JSON.stringify(record))];
  const content = lines.length ? `${lines.join('\n')}\n` : '';
  report.changed = content !== ledger.content;
  if (confirm && report.changed) {
    report.written_to = writeLedger(root, content);
  }
  return report;
}

// Separa o ledger entre as linhas deste importador (por `extensions.import_origin`) e as
// das outras ferramentas, que voltam como texto cru para serem preservadas byte a byte.
function partitionLedger(root) {
  const path = ledgerFile(root);
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const owned = new Map();
  const kept = [];
  for (const line of content.split('\n').filter(Boolean)) {
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    if (parsed?.extensions?.import_origin === IMPORT_ORIGIN && typeof parsed.run_id === 'string') {
      // Linha repetida do mesmo run: vale a última, como em `latestRunRecords`.
      owned.set(parsed.run_id, parsed);
    } else kept.push(line);
  }
  return { content, owned, kept };
}

// Escrita atômica: o ledger novo nasce ao lado e troca de nome, para rodada interrompida
// nunca deixar o arquivo pela metade.
function writeLedger(root, content) {
  const path = ledgerFile(root);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

// Mesmo caminho que `appendRunRecord` usa, sem passar pelo `ensureBrain` das CLIs da
// INEVITA (que recusa vault legado).
export function ledgerFile(root) {
  const configured = layout(root).runLedger;
  return configured ? resolve(root, configured) : resolve(root, '.cerebro', 'ledger', 'runs.jsonl');
}
