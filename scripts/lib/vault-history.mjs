// Importação do histórico de sessões de IA de um vault tipado em Run Records v2.
//
// O vault guarda uma nota por sessão de trabalho (`ai/sessions/<data>-<tema>.md`) e uma
// daily por dia (`journal/<data>.md`) com a seção `## Log de agentes`, onde cada bullet
// nomeia o ator e as ferramentas que ele chamou. Este módulo lê as duas coisas e grava,
// no ledger do layout, um Run Record v2 por sessão classificada:
//
//   - o Sistema sai do nome do arquivo e das tags (classificação declarada, sem adivinhar);
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
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { layout, readJson, readRunLedger, validateRunRecord } from './system-protocol.mjs';
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
// sem a data; as tags vêm do frontmatter. Sessão que não casa com nenhum Sistema fica no
// balde `sessao-livre` e não é importada — Run Record exige `system_id` de um Sistema que
// existe, e contrato falso não se cria em silêncio.
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
  ['cerebro', 'cerebro-ou-boot', ({ tokens, tags }) => tokens.includes('cerebro') || tokens.includes('boot')
    || tokens.includes('bootstrap') || tags.includes('cerebro') || tags.includes('boot')],
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
    if (test(input)) return { system_id: systemId, basis };
  }
  return { system_id: null, basis: FREE_SESSION_BUCKET };
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
  const targets = [].concat(meta.related_to || [])
    .flatMap((value) => [...String(value).matchAll(/\[\[([^\]|#]+)/g)].map((match) => match[1].trim()));
  const seen = new Set();
  const refs = [];
  for (const target of targets) {
    const id = slugify(target.includes('/') ? target.slice(target.lastIndexOf('/') + 1) : target);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push({ role: ENTITY_ROLE, id });
  }
  return refs;
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

function sessionsDirectory(root, config) {
  if (typeof config.sessions === 'string' && config.sessions) return config.sessions;
  const domains = layout(root).companyMapDomains;
  if (Array.isArray(domains)) {
    for (const domain of domains) {
      for (const entry of domain?.entries || []) {
        if (entry?.id === 'sessoes' && typeof entry.refs?.[0] === 'string') return entry.refs[0];
      }
    }
  }
  return join('ai', 'sessions');
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
      import_origin: 'vault-session-note',
      verification_state: verified ? VERIFIED_MARKER : UNVERIFIED_MARKER,
      session_ref: session.ref,
      daily_ref: dailyRef || null,
      classified_by: session.classification.basis,
    },
  };
}

// Lê as notas de sessão do vault e devolve o plano de importação. `confirm` grava;
// sem ele, nada é escrito e o relatório diz o que entraria.
export function importVaultSessionHistory(root, { confirm = false } = {}) {
  const config = layout(root).vault;
  if (!config || typeof config !== 'object') {
    return {
      mode: 'no-vault', sessions_ref: null, daily_ref: null, total: 0, per_system: {},
      free_sessions: [], missing_contract: {}, pii_refused: [], invalid: [],
      with_gap: 0, verified: 0, already_imported: 0, appended: [], records: [],
    };
  }
  const sessionsRef = sessionsDirectory(root, config);
  const dailyRef = typeof config.daily === 'string' && config.daily ? config.daily : 'journal';
  if (!inside(root, sessionsRef) || !inside(root, dailyRef)) {
    throw new Error('o layout aponta sessões ou dailies fora do Cérebro');
  }
  const contracts = systemContracts(root);
  const logs = agentLogByDay(root, dailyRef);
  const existing = new Set(readRunLedger(root).map((record) => record.run_id));

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
    with_gap: 0,
    verified: 0,
    already_imported: 0,
    appended: [],
    records: [],
  };

  const directory = resolve(root, sessionsRef);
  if (!existsSync(directory)) return report;

  for (const name of markdownFiles(directory)) {
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
    const classification = classifySession({ theme, tags });
    if (!classification.system_id) {
      report.free_sessions.push(ref);
      continue;
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
    if (existing.has(record.run_id)) report.already_imported += 1;
    else report.appended.push(record);
  }

  if (confirm && report.appended.length) {
    // Uma escrita só, em append: rodada interrompida não deixa linha partida no ledger.
    const path = ledgerFile(root);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${report.appended.map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
    report.written_to = path;
  }
  return report;
}

// Mesmo caminho que `appendRunRecord` usa, sem passar pelo `ensureBrain` das CLIs da
// INEVITA (que recusa vault legado).
export function ledgerFile(root) {
  const configured = layout(root).runLedger;
  return configured ? resolve(root, configured) : resolve(root, '.cerebro', 'ledger', 'runs.jsonl');
}
