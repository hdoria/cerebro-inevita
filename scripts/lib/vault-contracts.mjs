// Compilador de notas tipadas do vault em contratos do protocolo.
//
// O dono descreve Fontes (e, nos próximos tickets, Sistemas e Rotinas) como notas
// Markdown com frontmatter em português. Este módulo lê essas notas, mapeia os campos
// para os contratos do protocolo, valida com os validadores que já existem e grava o
// JSON nos caminhos declarados pelo layout do Cérebro. A nota é a fonte da verdade; o
// JSON é artefato gerado.
//
// Regras que o módulo garante:
// - simula por padrão: só grava com `confirm`;
// - erro aponta nota, campo e motivo;
// - valor com cara de CPF, CNPJ, telefone, e-mail ou segredo é recusado;
// - rodar duas vezes não muda nada (comparação por conteúdo, ordem de chaves estável,
//   `freshness.observed_at` derivado do `updated` da nota ou preservado);
// - mantém `.cerebro/compiled.json` com os arquivos que gerou e remove só os próprios
//   órfãos; contrato escrito por outra ferramenta nunca é tocado.
//
// Para estender: acrescente uma entrada em VAULT_CONTRACT_TYPES com o type da nota, a
// chave de layout, o mapeador, o validador e o mapa de campo reverso.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { layout, readJson, validateSourceContract, writeJsonAtomic } from './system-protocol.mjs';
import { parseFrontmatter } from './vault-today.mjs';
import { knowledgeNotes } from './vault-read-model.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const REGISTRY_REF = join('.cerebro', 'compiled.json');

// Valor que parece dado pessoal ou segredo nunca entra num contrato. O CNPJ é testado
// antes do CPF porque os catorze dígitos dele contêm uma sequência de onze.
const REFUSED_VALUE_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'parece segredo'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i, 'parece segredo'],
  [/\b(?:sk|ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{12,}\b/, 'parece segredo'],
  [/https?:\/\/[^\s/:]+:[^\s/@]+@/, 'parece segredo'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, 'parece e-mail'],
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/, 'parece CNPJ'],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/, 'parece CPF'],
  [/(?:\+55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}[-\s]?\d{4}\b/, 'parece telefone'],
];

const KINDS = {
  mcp: {
    type: 'mcp-connector',
    connector: 'mcp-server',
    custody: 'agent-direct',
    revocation: 'desconectar o MCP na conta que o autoriza',
  },
  script: {
    type: 'local-script',
    connector: 'local-script',
    custody: 'none',
    revocation: 'remover o script da rotina que o chama',
  },
  arquivo: {
    type: 'local-file',
    connector: 'local-file',
    custody: 'none',
    revocation: 'remover o arquivo do alcance do agente',
  },
  manual: {
    type: 'manual-entry',
    connector: 'manual',
    custody: 'none',
    revocation: 'parar de registrar a entrada manual',
  },
  web: {
    type: 'web-service',
    connector: 'web-service',
    custody: 'agent-direct',
    revocation: 'revogar o acesso no serviço',
  },
  git: {
    type: 'git-repository',
    connector: 'git-repository',
    custody: 'none',
    revocation: 'revogar a chave de acesso ao repositório',
  },
};

const SENSITIVITIES = { baixa: 'public', media: 'team', alta: 'private', 'muito-alta': 'private' };
const PII_CLASSES = { nenhum: 'none', indireto: 'possible', direto: 'contains' };
const ACCESS_MODES = { leitura: ['read'], 'leitura-escrita': ['read', 'write-with-approval'] };
const STATUSES = { Ativo: 'active', Pausado: 'mapped' };
const TRUTH_FLAGS = { sim: true, nao: false, não: false };

// Campos da nota DataSource que o compilador mapeia. Todos passam pela varredura de
// dado pessoal e segredo antes de virar contrato.
const DATA_SOURCE_FIELDS = [
  'source_id', 'nome', 'kind', 'dono', 'casa_da_verdade', 'fonte_de_verdade', 'finalidade',
  'entidades', 'limites', 'sensibilidade', 'pii', 'frescor', 'retencao', 'retencao_ate',
  'revogacao', 'acesso', 'consumidores', 'status', 'binding', 'credencial', 'updated',
];

// Caminho do contrato → campo da nota, para que o erro do validador aponte o que o dono
// escreveu, não o JSON gerado.
const DATA_SOURCE_FIELD_BY_PATH = {
  protocol_version: 'source_id',
  source_id: 'source_id',
  name: 'nome',
  type: 'kind',
  status: 'status',
  'truth.home_ref': 'casa_da_verdade',
  'truth.source_of_truth': 'fonte_de_verdade',
  'authority.owner_ref': 'dono',
  'authority.status': 'dono',
  'scope.purpose': 'finalidade',
  'scope.entity_types': 'entidades',
  'scope.boundaries': 'limites',
  sensitivity: 'sensibilidade',
  'pii.classification': 'pii',
  'pii.handling': 'pii',
  modes: 'acesso',
  'freshness.policy': 'frescor',
  'freshness.observed_at': 'updated',
  'retention.policy': 'retencao',
  'retention.until': 'retencao_ate',
  'revocation.method': 'revogacao',
  'revocation.effect': 'revogacao',
  'revocation.revocable': 'revogacao',
  'connector.kind': 'kind',
  'connector.binding_ref': 'binding',
  'connector.credential_ref': 'credencial',
  'connector.custody': 'kind',
  authorized_consumers: 'consumidores',
  assurance: 'kind',
  source_contract: 'type',
};

function values(raw) {
  if (raw === undefined || raw === null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((item) => String(item)).filter((item) => item.trim());
}

function single(raw) {
  const list = values(raw);
  return list.length ? list[0].trim() : '';
}

function slug(value) {
  const link = /\[\[([^\]|#]+)/.exec(String(value));
  const target = (link ? link[1] : String(value)).trim();
  return target.includes('/') ? target.slice(target.lastIndexOf('/') + 1) : target;
}

// Erro legível: diz o campo da nota e o motivo, nunca o JSON intermediário.
function problem(field, reason) {
  return { field, reason };
}

function refuseValues(data, fields) {
  const errors = [];
  for (const field of fields) {
    for (const value of values(data[field])) {
      for (const [pattern, reason] of REFUSED_VALUE_PATTERNS) {
        if (pattern.test(value)) {
          errors.push(problem(field, `${reason}; contrato aceita só referência`));
          break;
        }
      }
    }
  }
  return errors;
}

function observedAt(data, previous, now) {
  const updated = single(data.updated);
  if (DATE_RE.test(updated)) return `${updated}T00:00:00.000Z`;
  if (updated && Number.isFinite(Date.parse(updated))) return new Date(updated).toISOString();
  if (typeof previous?.freshness?.observed_at === 'string') return previous.freshness.observed_at;
  return now.toISOString();
}

function required(data, field, errors) {
  const value = single(data[field]);
  if (!value) errors.push(problem(field, 'campo obrigatório e vazio'));
  return value;
}

function choice(data, field, table, errors) {
  const value = single(data[field]);
  if (!value) {
    errors.push(problem(field, 'campo obrigatório e vazio'));
    return null;
  }
  if (!(value in table)) {
    errors.push(problem(field, `valor inválido; use ${Object.keys(table).join(', ')}`));
    return null;
  }
  return table[value];
}

// DataSource → Source Contract v1.
function mapDataSource(data, { previous, now }) {
  const errors = refuseValues(data, DATA_SOURCE_FIELDS);
  const sourceId = required(data, 'source_id', errors);
  if (sourceId && !ID_RE.test(sourceId)) {
    errors.push(problem('source_id', 'id precisa ser kebab-case minúsculo (ex.: gmail-hugo)'));
  }
  const name = required(data, 'nome', errors);
  const kindKey = single(data.kind);
  const kind = choice(data, 'kind', KINDS, errors);
  const home = required(data, 'casa_da_verdade', errors);
  const purpose = required(data, 'finalidade', errors);
  const sensitivity = choice(data, 'sensibilidade', SENSITIVITIES, errors);
  const piiClass = choice(data, 'pii', PII_CLASSES, errors);
  const modes = choice(data, 'acesso', ACCESS_MODES, errors);
  const freshness = required(data, 'frescor', errors);
  const retention = required(data, 'retencao', errors);
  const status = choice(data, 'status', STATUSES, errors);

  const ownerRaw = single(data.dono);
  const owner = ownerRaw ? slug(ownerRaw) : null;
  if (owner && !REF_RE.test(owner)) {
    errors.push(problem('dono', 'o alvo do wikilink precisa ser um slug simples (letras, números, - ou _)'));
  }

  const entities = values(data.entidades).map((item) => slug(item));
  for (const entity of entities) {
    if (!ID_RE.test(entity)) errors.push(problem('entidades', `"${entity}" precisa ser kebab-case minúsculo`));
  }
  const consumers = values(data.consumidores).map((item) => slug(item));
  for (const consumer of consumers) {
    if (!REF_RE.test(consumer)) {
      errors.push(problem('consumidores', `"${consumer}" precisa ser um slug simples de nota de Sistema`));
    }
  }

  const truthFlagRaw = single(data.fonte_de_verdade);
  let sourceOfTruth = true;
  if (truthFlagRaw) {
    if (!(truthFlagRaw in TRUTH_FLAGS)) errors.push(problem('fonte_de_verdade', 'valor inválido; use sim ou nao'));
    else sourceOfTruth = TRUTH_FLAGS[truthFlagRaw];
  }

  const retentionUntil = single(data.retencao_ate);
  if (retentionUntil && !Number.isFinite(Date.parse(retentionUntil))) {
    errors.push(problem('retencao_ate', 'data inválida; use YYYY-MM-DD'));
  }

  if (errors.length) return { errors };

  return {
    errors: [],
    contract: {
      protocol_version: 1,
      source_id: sourceId,
      name,
      type: kind.type,
      status,
      truth: { home_ref: home, source_of_truth: sourceOfTruth },
      authority: { owner_ref: owner, status: owner ? 'confirmed' : 'unconfirmed' },
      scope: { purpose, entity_types: entities, boundaries: values(data.limites) },
      sensitivity,
      // Fonte sem PII não precisa de política de manuseio; com PII, o contrato só
      // carrega referência, nunca o conteúdo.
      pii: { classification: piiClass, handling: piiClass === 'none' ? 'not-applicable' : 'reference-only' },
      modes,
      freshness: { policy: freshness, observed_at: observedAt(data, previous, now) },
      retention: {
        policy: retention,
        until: retentionUntil ? new Date(retentionUntil).toISOString() : null,
      },
      revocation: {
        method: single(data.revogacao) || kind.revocation,
        effect: 'future-only',
        revocable: true,
      },
      connector: {
        kind: kind.connector,
        binding_ref: single(data.binding) || null,
        credential_ref: single(data.credencial) || null,
        custody: kind.custody,
      },
      authorized_consumers: consumers.map((consumer) => ({ subject_type: 'system', subject_ref: consumer })),
      // O vault não guarda credencial em custódia de runtime, então a garantia é por
      // recibo auditado: `runtime-enforced` exigiria segredo sob custódia exclusiva.
      assurance: 'receipt-audited',
      extensions: { vault_note_ref: null, vault_note_type: 'DataSource', vault_note_kind: kindKey },
    },
  };
}

export const VAULT_CONTRACT_TYPES = [
  {
    noteType: 'DataSource',
    label: 'fonte',
    layoutKey: 'sourceContracts',
    defaultDirectory: join('.cerebro', 'contracts', 'sources'),
    map: mapDataSource,
    validate: validateSourceContract,
    idOf: (contract) => contract.source_id,
    fieldByPath: DATA_SOURCE_FIELD_BY_PATH,
  },
];

// Erro do validador ("scope.purpose precisa ser texto não vazio") volta como campo da
// nota mais motivo, para que o dono corrija a nota sem abrir o JSON.
function translate(message, fieldByPath) {
  const [path, ...rest] = String(message).split(' ');
  const normalized = path.replace(/\[\d+\]/g, '').replace(/^source_contract\./, '');
  return problem(fieldByPath[normalized] || normalized || 'contrato', rest.join(' ') || 'inválido');
}

function insideRoot(root, configured, fallback) {
  if (typeof configured !== 'string' || !configured || isAbsolute(configured)) return resolve(root, fallback);
  const base = resolve(root);
  const target = resolve(base, configured);
  if (target === base || !target.startsWith(`${base}${sep}`)) return resolve(base, fallback);
  return target;
}

function posix(value) {
  return value.replaceAll('\\', '/');
}

function readRegistry(root) {
  const path = join(root, REGISTRY_REF);
  if (!existsSync(path)) return { protocol_version: 1, files: [] };
  try {
    const value = readJson(path, REGISTRY_REF);
    return { protocol_version: 1, files: Array.isArray(value.files) ? value.files : [] };
  } catch {
    return { protocol_version: 1, files: [] };
  }
}

// Template e rascunho declaram o type para herdar o formulário do app, mas não são
// declaração de nada: ficam fora da compilação, como já ficam na leitura de
// procedimentos.
function isDraft(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return path.startsWith('templates/') || name.startsWith('_');
}

// Notas do vault com um dos types compiláveis. Ignora pasta oculta e node_modules
// (herdado da varredura do read model), e devolve o caminho relativo à raiz do Cérebro.
function typedNotes(root, knowledgeRoot, noteTypes) {
  const prefix = knowledgeRoot && knowledgeRoot !== '.' ? `${posix(knowledgeRoot)}/` : '';
  return knowledgeNotes(root, knowledgeRoot || '.')
    .map((note) => ({ ...note, path: `${prefix}${posix(note.relative)}`, data: parseFrontmatter(note.content) }))
    .filter((note) => noteTypes.has(String(note.data.type || '').trim()) && !isDraft(note.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Compila as notas tipadas do vault em contratos do protocolo.
 *
 * @param {string} root raiz do Cérebro (o vault)
 * @param {{confirm?: boolean, now?: Date}} options `confirm` grava; sem ele, simula
 * @returns {{notes: Array, written: string[], removed: string[], errors: number}}
 */
export function compileVaultContracts(root, { confirm = false, now = new Date() } = {}) {
  const base = resolve(root);
  if (!existsSync(join(base, '.cerebro', 'layout.json'))) {
    throw new Error('.cerebro/layout.json não encontrado: informe --root de um Cérebro');
  }
  const config = layout(base);
  const byType = new Map(VAULT_CONTRACT_TYPES.map((compiler) => [compiler.noteType, compiler]));
  const notes = typedNotes(base, config.knowledgeRoot || '.', new Set(byType.keys()));

  const results = [];
  const owned = new Map();
  const seen = new Map();
  const written = [];
  const removed = [];

  for (const note of notes) {
    const compiler = byType.get(String(note.data.type).trim());
    const directory = insideRoot(base, config[compiler.layoutKey], compiler.defaultDirectory);
    if (!note.readable) {
      results.push({ path: note.path, type: compiler.noteType, status: 'error', errors: [problem('arquivo', 'nota ilegível')] });
      continue;
    }
    const mapped = compiler.map(note.data, { previous: null, now });
    let errors = mapped.errors;
    let contract = mapped.contract || null;
    let contractRef = null;

    if (contract) {
      const id = compiler.idOf(contract);
      contractRef = posix(join(directory.slice(base.length + 1), `${id}.json`));
      const contractPath = join(base, contractRef);
      const previous = existsSync(contractPath) ? readRegistryContract(contractPath) : null;
      // Recompilar não pode mexer na observação: ela vem do `updated` da nota ou do
      // valor já gravado.
      contract = compiler.map(note.data, { previous, now }).contract;
      contract.extensions.vault_note_ref = note.path;
      const duplicate = seen.get(contractRef);
      if (duplicate) {
        errors = [problem('source_id', `id já usado por ${duplicate}`)];
      } else {
        seen.set(contractRef, note.path);
        errors = compiler.validate(contract).map((message) => translate(message, compiler.fieldByPath));
      }
    }

    if (errors.length) {
      // A nota existe, então o contrato antigo dela não é órfão (ver o laço de órfãos
      // abaixo): fica como está até o dono corrigir a nota. O registro, porém, só lista
      // arquivo que este compilador garante válido.
      results.push({ path: note.path, type: compiler.noteType, status: 'error', errors });
      continue;
    }

    const serialized = `${JSON.stringify(contract, null, 2)}\n`;
    const contractPath = join(base, contractRef);
    const current = existsSync(contractPath) ? readFileSync(contractPath, 'utf8') : null;
    const changed = current !== serialized;
    owned.set(contractRef, { note: note.path, type: compiler.noteType, id: compiler.idOf(contract) });
    if (confirm && changed) {
      ensureRuntime(base);
      writeJsonAtomic(contractPath, contract);
      written.push(contractRef);
    }
    results.push({
      path: note.path,
      type: compiler.noteType,
      label: compiler.label,
      status: 'ok',
      id: compiler.idOf(contract),
      contract_ref: contractRef,
      changed,
      errors: [],
    });
  }

  const registry = readRegistry(base);
  const notePaths = new Set(notes.map((note) => note.path));
  for (const entry of registry.files) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (owned.has(entry.path)) continue;
    // Só é órfão o arquivo que este compilador gerou para uma nota que não existe mais.
    if (typeof entry.note === 'string' && notePaths.has(entry.note)) continue;
    removed.push(entry.path);
    if (confirm) rmSync(join(base, entry.path), { force: true });
  }

  const nextRegistry = {
    protocol_version: 1,
    files: [...owned.entries()]
      .map(([path, entry]) => ({ path, type: entry.type, note: entry.note }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  const registryPath = join(base, REGISTRY_REF);
  const serializedRegistry = `${JSON.stringify(nextRegistry, null, 2)}\n`;
  const currentRegistry = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null;
  // Instalação sem nota compilável não ganha registro: o compilador não deixa rastro
  // onde não trabalhou.
  const registryChanged = currentRegistry !== serializedRegistry
    && !(currentRegistry === null && !nextRegistry.files.length);
  if (confirm && registryChanged) {
    ensureRuntime(base);
    writeJsonAtomic(registryPath, nextRegistry);
    written.push(posix(REGISTRY_REF));
  }

  return {
    notes: results,
    written,
    removed,
    registry_changed: registryChanged,
    errors: results.filter((item) => item.status === 'error').length,
  };
}

function readRegistryContract(path) {
  try {
    return readJson(path, path);
  } catch {
    return null;
  }
}

// O estado privado do Console vive em `.cerebro/runtime/`. Sem esse diretório, leitores
// do protocolo (candidatos de aprendizado, por exemplo) acusam instalação incompleta.
function ensureRuntime(root) {
  const runtime = join(root, '.cerebro', 'runtime');
  if (existsSync(runtime)) return;
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
}
