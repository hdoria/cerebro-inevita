// Compilador de notas tipadas do vault em contratos do protocolo.
//
// O dono descreve Fontes, Sistemas e Rotinas como notas Markdown com frontmatter em
// português. Este módulo lê essas notas, mapeia os campos para os contratos do protocolo,
// valida com os validadores que já existem e grava o JSON nos caminhos declarados pelo
// layout do Cérebro. A nota é a fonte da verdade; o JSON é artefato gerado.
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
// Para estender: acrescente uma entrada em VAULT_CONTRACT_TYPES com o type da nota, o
// mapeador e um descritor por artefato gerado (chave de layout, validador e mapa de campo
// reverso). Uma nota pode gerar mais de um artefato — a de Rotina gera três tipos.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  VERSION_RE, layout, readJson, validateAccessGrant, validateSourceContract,
  validateSystemContract, writeJsonAtomic,
} from './system-protocol.mjs';
import { validateExecutorBinding, validateRoutineContract } from './routine-protocol.mjs';
import { parseFrontmatter } from './vault-today.mjs';
import { knowledgeNotes } from './vault-read-model.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
// Mesmo `local_ref` do protocolo: caminho ou identificador, nunca `..` nem caminho vazio.
const LOCAL_REF_RE = /^(?!\.?\.?$)(?!\.\.?\/)(?!.*\/\.\.(?:\/|$))[A-Za-z0-9.][A-Za-z0-9_./:-]{0,255}$/;
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
  return (Array.isArray(raw) ? raw : [raw])
    .filter((item) => item === null || typeof item !== 'object')
    .map((item) => String(item))
    .filter((item) => item.trim());
}

// Todo texto que o campo carrega, inclusive dentro de lista de objetos: é sobre isso que
// a varredura de dado pessoal e segredo passa.
function leaves(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.flatMap((item) => leaves(item));
  if (typeof raw === 'object') return Object.values(raw).flatMap((item) => leaves(item));
  const value = String(raw);
  return value.trim() ? [value] : [];
}

function objects(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
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
    for (const value of leaves(data[field])) {
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

// Data da nota (`2026-07-06`) vira instante do contrato. Sem data reconhecível, devolve
// null: campo de data inválido vira erro legível, nunca instante inventado.
function stamp(value) {
  const text = String(value || '').trim();
  if (DATE_RE.test(text)) return `${text}T00:00:00.000Z`;
  if (text && Number.isFinite(Date.parse(text))) return new Date(text).toISOString();
  return null;
}

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
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

// ── System → System Contract v2 ───────────────────────────────────────────────────────

const SYSTEM_STATUSES = {
  Proposto: 'proposed', Confirmado: 'confirmed', Ativo: 'active',
  Atencao: 'needs_attention', Atenção: 'needs_attention',
};
const TRIGGER_TYPES = { manual: 'manual', evento: 'event', agendado: 'schedule' };
const CAPABILITY_ORIGINS = { local: 'local', inevita: 'inevita', externa: 'external' };
const SOURCE_ACCESS = {
  leitura: 'read-only', manual: 'manual', 'escrita-com-aprovacao': 'write-with-approval',
};
const SELECTIONS = { explicita: 'explicit', recente: 'recent', relevante: 'relevant', mista: 'mixed' };
const ON_UNAVAILABLE = { parar: 'stop', fallback: 'fallback', 'seguir-com-lacuna': 'continue-with-gap' };
const PROVENANCE = { 'por-afirmacao': 'per-claim', 'por-item': 'per-item' };

// Derivações documentadas: o que o protocolo exige e a nota não declara campo a campo.
const DEFAULT_CONFLICT_POLICY = 'a casa da verdade da fonte vence; divergência sem autoridade fica declarada como lacuna no output';
const DEFAULT_READ_PERMISSION = 'as fontes declaradas neste Sistema';
const DEFAULT_WRITE_PERMISSION = 'o output e o recibo locais deste Sistema';
const RETRIEVAL_VERSION = '0.1.0';
const EVAL_VERSION = '0.1.0';
const CONTEXT_BUDGET_UNIT = 'items';

const SYSTEM_FIELDS = [
  'system_id', 'nome', 'versao', 'status', 'area', 'area_confirmada', 'resultado', 'nao_sucesso',
  'entrega', 'pronto_quando', 'dono', 'gate_humano', 'gatilho', 'quando', 'capacidade',
  'capacidade_versao', 'capacidade_origem', 'entidades', 'fontes', 'etapas', 'gates',
  'perguntas_humanas', 'medida', 'conflito', 'paradas', 'fallback', 'itens_maximos',
  'itens_por_fonte', 'evidencia_por', 'leitura', 'escrita', 'acoes_externas', 'limiar_promocao',
  'procedimento',
];

const SYSTEM_FIELD_BY_PATH = {
  protocol_version: 'system_id',
  system_id: 'system_id',
  name: 'nome',
  version: 'versao',
  status: 'status',
  'result.statement': 'resultado',
  'result.non_success': 'nao_sucesso',
  'result.output_type': 'entrega',
  'result.definition_of_done': 'pronto_quando',
  'result.owner': 'dono',
  'result.human_gate': 'gate_humano',
  'trigger.type': 'gatilho',
  'trigger.description': 'quando',
  'capability.capability_id': 'capacidade',
  'capability.version': 'capacidade_versao',
  'capability.origin': 'capacidade_origem',
  entities: 'entidades',
  'entities.type': 'entidades',
  'entities.role': 'entidades',
  'entities.required': 'entidades',
  sources: 'fontes',
  'sources.role': 'fontes',
  'sources.source_id': 'fontes',
  'sources.required': 'fontes',
  'sources.access': 'fontes',
  'sources.freshness': 'fontes',
  'sources.purpose': 'fontes',
  'retrieval.source_roles': 'fontes',
  'retrieval.source_roles.role': 'fontes',
  'retrieval.source_roles.priority': 'fontes',
  'retrieval.source_roles.selection': 'fontes',
  'retrieval.source_roles.filters': 'fontes',
  'retrieval.source_roles.window': 'fontes',
  'retrieval.source_roles.required_freshness': 'fontes',
  'retrieval.source_roles.on_unavailable': 'fontes',
  'retrieval.conflict_policy': 'conflito',
  'retrieval.fallback.order': 'fallback',
  'retrieval.stop_conditions': 'paradas',
  'retrieval.context_budget.maximum': 'itens_maximos',
  'retrieval.context_budget.per_source_maximum': 'itens_por_fonte',
  'retrieval.evidence.provenance': 'evidencia_por',
  pipeline: 'etapas',
  'pipeline.state': 'etapas',
  'pipeline.input': 'etapas',
  'pipeline.output': 'etapas',
  'pipeline.gate': 'etapas',
  'permissions.read': 'leitura',
  'permissions.write': 'escrita',
  'permissions.external_actions': 'acoes_externas',
  'eval.deterministic_gates': 'gates',
  'eval.human_questions': 'perguntas_humanas',
  'eval.outcome_measure': 'medida',
  'learning.promotion_threshold': 'limiar_promocao',
  'extensions.operating_area': 'area',
  system_contract: 'type',
};

function flag(data, field, errors, fallback) {
  const raw = single(data[field]);
  if (!raw) return fallback;
  if (!(raw in TRUTH_FLAGS)) {
    errors.push(problem(field, 'valor inválido; use sim ou nao'));
    return fallback;
  }
  return TRUTH_FLAGS[raw];
}

function count(data, field, errors, fallback, minimum) {
  const raw = single(data[field]);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    errors.push(problem(field, `precisa ser inteiro >= ${minimum}`));
    return fallback;
  }
  return value;
}

// Inteiro dentro de uma faixa fechada do protocolo (timeout, tentativas, espera).
function ranged(data, field, errors, fallback, minimum, maximum) {
  const raw = single(data[field]);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(problem(field, `precisa ser inteiro entre ${minimum} e ${maximum}`));
    return fallback;
  }
  return value;
}

function nested(item, key) {
  const raw = item?.[key];
  return raw === undefined || raw === null ? '' : String(Array.isArray(raw) ? raw[0] || '' : raw).trim();
}

function nestedChoice(item, key, table, field, label, errors, fallback) {
  const raw = nested(item, key);
  if (!raw) return fallback;
  if (!(raw in table)) {
    errors.push(problem(field, `${label}: ${key} inválido; use ${Object.keys(table).join(', ')}`));
    return fallback;
  }
  return table[raw];
}

// System → System Contract v2. A nota declara o resultado, o gatilho, a área, as fontes
// (por wikilink para a nota DataSource), as etapas e os gates; o bloco `retrieval` do
// protocolo é derivado das fontes declaradas, com as regras descritas em `type/system.md`.
function mapSystem(data, { sourceIds = new Map(), areaSlugs = null } = {}) {
  const errors = refuseValues(data, SYSTEM_FIELDS);
  const systemId = required(data, 'system_id', errors);
  if (systemId && !ID_RE.test(systemId)) {
    errors.push(problem('system_id', 'id precisa ser kebab-case minúsculo (ex.: daily)'));
  }
  const name = required(data, 'nome', errors);
  const version = single(data.versao) || '0.1.0';
  if (!VERSION_RE.test(version)) errors.push(problem('versao', 'precisa ser semver (ex.: 0.1.0)'));
  const status = choice(data, 'status', SYSTEM_STATUSES, errors);

  const areaRaw = required(data, 'area', errors);
  const area = areaRaw ? slug(areaRaw) : '';
  if (area && !ID_RE.test(area)) {
    errors.push(problem('area', 'o alvo do wikilink precisa ser kebab-case minúsculo'));
  } else if (area && areaSlugs && areaSlugs.size && !areaSlugs.has(area)) {
    errors.push(problem('area', `nenhuma nota de área chamada "${area}" neste vault`));
  }
  const areaConfirmed = flag(data, 'area_confirmada', errors, true);

  const statement = required(data, 'resultado', errors);
  const nonSuccess = required(data, 'nao_sucesso', errors);
  const outputType = required(data, 'entrega', errors);
  if (outputType && !ID_RE.test(outputType)) {
    errors.push(problem('entrega', 'precisa ser kebab-case minúsculo (ex.: daily-note)'));
  }
  const done = required(data, 'pronto_quando', errors);
  const ownerRaw = required(data, 'dono', errors);
  const gate = required(data, 'gate_humano', errors);

  const triggerType = choice(data, 'gatilho', TRIGGER_TYPES, errors);
  const when = required(data, 'quando', errors);

  const capabilityId = single(data.capacidade) || systemId;
  if (capabilityId && !ID_RE.test(capabilityId)) {
    errors.push(problem('capacidade', 'precisa ser kebab-case minúsculo'));
  }
  const capabilityVersion = single(data.capacidade_versao) || version;
  if (!VERSION_RE.test(capabilityVersion)) {
    errors.push(problem('capacidade_versao', 'precisa ser semver (ex.: 0.1.0)'));
  }
  const originRaw = single(data.capacidade_origem);
  let origin = 'local';
  if (originRaw) {
    if (!(originRaw in CAPABILITY_ORIGINS)) {
      errors.push(problem('capacidade_origem', `valor inválido; use ${Object.keys(CAPABILITY_ORIGINS).join(', ')}`));
    } else origin = CAPABILITY_ORIGINS[originRaw];
  }

  const entities = objects(data.entidades).map((item, index) => {
    const label = `item ${index + 1}`;
    const type = nested(item, 'tipo');
    const role = nested(item, 'papel');
    if (!ID_RE.test(type)) errors.push(problem('entidades', `${label}: tipo precisa ser kebab-case minúsculo`));
    if (!ID_RE.test(role)) errors.push(problem('entidades', `${label}: papel precisa ser kebab-case minúsculo`));
    return {
      type,
      role,
      required: nestedChoice(item, 'obrigatoria', TRUTH_FLAGS, 'entidades', label, errors, false),
    };
  });

  const declared = objects(data.fontes);
  if (!declared.length) {
    errors.push(problem('fontes', 'declare pelo menos uma fonte com papel, fonte, frescor e finalidade'));
  }
  const roles = new Set();
  const sources = [];
  const sourceRoles = [];
  for (const [index, item] of declared.entries()) {
    const label = `item ${index + 1}`;
    const role = nested(item, 'papel');
    if (!ID_RE.test(role)) {
      errors.push(problem('fontes', `${label}: papel precisa ser kebab-case minúsculo`));
    } else if (roles.has(role)) {
      errors.push(problem('fontes', `${label}: papel "${role}" repetido`));
    }
    roles.add(role);

    const reference = nested(item, 'fonte');
    let sourceId = null;
    if (!reference) {
      errors.push(problem('fontes', `${label}: fonte obrigatória e vazia`));
    } else {
      const target = slug(reference);
      sourceId = sourceIds.get(target) || null;
      if (!sourceId) {
        errors.push(problem('fontes', `${label}: a fonte "${target}" não tem nota DataSource com source_id neste vault`));
      }
    }

    const isRequired = nestedChoice(item, 'obrigatoria', TRUTH_FLAGS, 'fontes', label, errors, false);
    const access = nestedChoice(item, 'acesso', SOURCE_ACCESS, 'fontes', label, errors, 'read-only');
    const freshness = nested(item, 'frescor');
    if (!freshness) errors.push(problem('fontes', `${label}: frescor obrigatório e vazio`));
    const purpose = nested(item, 'finalidade');
    if (!purpose) errors.push(problem('fontes', `${label}: finalidade obrigatória e vazia`));

    sources.push({ role, source_id: sourceId, required: isRequired, access, freshness, purpose });
    sourceRoles.push({
      role,
      priority: index + 1,
      selection: nestedChoice(item, 'selecao', SELECTIONS, 'fontes', label, errors, 'recent'),
      filters: values(item.filtros),
      window: nested(item, 'janela') || freshness,
      required_freshness: freshness,
      on_unavailable: nestedChoice(
        item, 'se_faltar', ON_UNAVAILABLE, 'fontes', label, errors,
        isRequired ? 'stop' : 'continue-with-gap',
      ),
    });
  }

  const fallbackOrder = values(data.fallback).map((item) => slug(item));
  for (const role of fallbackOrder) {
    if (!roles.has(role)) errors.push(problem('fallback', `"${role}" não é papel de nenhuma fonte declarada`));
  }

  const pipeline = objects(data.etapas).map((item, index) => {
    const label = `item ${index + 1}`;
    const state = nested(item, 'estado');
    if (!ID_RE.test(state)) errors.push(problem('etapas', `${label}: estado precisa ser kebab-case minúsculo`));
    for (const [key, field] of [['entrada', 'entrada'], ['saida', 'saída'], ['gate', 'gate']]) {
      if (!nested(item, key)) errors.push(problem('etapas', `${label}: ${field} obrigatória e vazia`));
    }
    return {
      state,
      input: nested(item, 'entrada'),
      output: nested(item, 'saida'),
      gate: nested(item, 'gate'),
    };
  });
  if (!pipeline.length) errors.push(problem('etapas', 'declare pelo menos uma etapa com estado, entrada, saida e gate'));

  const gates = values(data.gates);
  if (!gates.length) errors.push(problem('gates', 'declare pelo menos um gate determinístico'));
  const questions = values(data.perguntas_humanas);
  if (!questions.length) errors.push(problem('perguntas_humanas', 'declare pelo menos uma pergunta de julgamento'));
  const measure = required(data, 'medida', errors);

  const stops = values(data.paradas);
  if (!stops.length) errors.push(problem('paradas', 'declare pelo menos uma condição de parada'));

  const maximum = count(data, 'itens_maximos', errors, 120, 1);
  const perSource = single(data.itens_por_fonte) ? count(data, 'itens_por_fonte', errors, null, 1) : null;
  if (Number.isInteger(perSource) && perSource > maximum) {
    errors.push(problem('itens_por_fonte', 'não pode exceder itens_maximos'));
  }
  const provenanceRaw = single(data.evidencia_por);
  let provenance = 'per-claim';
  if (provenanceRaw) {
    if (!(provenanceRaw in PROVENANCE)) {
      errors.push(problem('evidencia_por', `valor inválido; use ${Object.keys(PROVENANCE).join(', ')}`));
    } else provenance = PROVENANCE[provenanceRaw];
  }

  const externalActions = flag(data, 'acoes_externas', errors, false);
  const threshold = count(data, 'limiar_promocao', errors, 3, 3);

  const procedureRaw = single(data.procedimento);
  const procedure = procedureRaw ? slug(procedureRaw) : null;
  if (procedure && !REF_RE.test(procedure)) {
    errors.push(problem('procedimento', 'o alvo do wikilink precisa ser um slug simples'));
  }

  if (errors.length) return { errors };

  return {
    errors: [],
    contract: {
      protocol_version: 2,
      system_id: systemId,
      name,
      version,
      status,
      result: {
        statement,
        non_success: nonSuccess,
        output_type: outputType,
        definition_of_done: done,
        owner: slug(ownerRaw),
        human_gate: gate,
      },
      trigger: { type: triggerType, description: when },
      capability: { capability_id: capabilityId, version: capabilityVersion, origin },
      entities,
      sources,
      retrieval: {
        version: RETRIEVAL_VERSION,
        source_roles: sourceRoles,
        conflict_policy: single(data.conflito) || DEFAULT_CONFLICT_POLICY,
        fallback: {
          enabled: fallbackOrder.length > 0,
          order: fallbackOrder,
          on_exhausted: 'continue-with-gap',
        },
        stop_conditions: stops,
        context_budget: { unit: CONTEXT_BUDGET_UNIT, maximum, per_source_maximum: perSource },
        // Evidência é obrigatória em todo Sistema deste cérebro: afirmação sem
        // proveniência é opinião da IA, não resultado.
        evidence: { required: true, provenance, minimum_refs: 1 },
      },
      pipeline,
      permissions: {
        read: values(data.leitura).length ? values(data.leitura) : [DEFAULT_READ_PERMISSION],
        write: values(data.escrita).length ? values(data.escrita) : [DEFAULT_WRITE_PERMISSION],
        external_actions: externalActions,
      },
      eval: {
        version: EVAL_VERSION,
        deterministic_gates: gates,
        human_questions: questions,
        outcome_measure: measure,
        baseline: null,
      },
      learning: {
        correction_policy: 'candidate-first',
        promotion_threshold: threshold,
        requires_replay: true,
        requires_human_approval: true,
      },
      // Chaves de extensão permitidas neste compilador. `operating_area` é o slug da nota
      // de área do vault, que o Console soma às áreas do vault em Estrutura › Áreas.
      extensions: {
        operating_area: area,
        operating_area_status: areaConfirmed ? 'confirmed' : 'to-confirm',
        product_kind: 'business-system',
        surface: 'systems',
        procedure_ref: procedure,
        vault_note_ref: null,
        vault_note_type: 'System',
      },
    },
  };
}

// ── Routine → Routine Contract + Access Grant(s) + executor binding ──────────────────

const ROUTINE_LIFECYCLES = { Rascunho: 'draft', Aprovada: 'approved', Aposentada: 'retired' };
const ROUTINE_TRIGGERS = { agendado: 'schedule', manual: 'manual' };
const CADENCES = { diaria: 'daily', diária: 'daily', semanal: 'weekly', mensal: 'monthly' };
const WEEKDAYS = {
  domingo: 'SU', segunda: 'MO', terca: 'TU', terça: 'TU', quarta: 'WE',
  quinta: 'TH', sexta: 'FR', sabado: 'SA', sábado: 'SA',
};
const WEEKDAY_NAMES = 'domingo, segunda, terca, quarta, quinta, sexta, sabado';
const MISSED_RUNS = { 'rodar-ao-acordar': 'run-on-wake', pular: 'skip' };
// Onde a rotina roda. `nuvem` é o agente de nuvem da Claude; `local` é a máquina do dono.
const HOSTS = { nuvem: 'host-claude-cloud', local: 'host-owner-local' };
const ROUTINE_PERMISSIONS = { leitura: 'read-only', 'escrita-no-espaco': 'workspace-write' };
const DESTINATIONS = { 'arquivo-local': 'local-file', 'saida-runtime': 'runtime-output' };
const REQUEST_MODES = { leitura: 'read', proposta: 'propose', 'escrita-com-aprovacao': 'write-with-approval' };
const EFFORTS = {
  baixo: 'low', medio: 'medium', médio: 'medium', alto: 'high',
  'muito-alto': 'xhigh', maximo: 'max', máximo: 'max',
};
const AUTH_STATUSES = {
  pronta: 'ready', ausente: 'missing', 'exige-login': 'authentication-required', degradada: 'degraded',
};

// Derivações documentadas da Rotina (ver `type/routine.md` no vault).
const DEFAULT_MODEL = 'padrao-da-conta';
const DEFAULT_EFFORT = 'medium';
const DEFAULT_AUTH = 'ready';
const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_ATTEMPTS = 1;
const DEFAULT_BACKOFF_SECONDS = 60;
const ROUTINE_ADAPTER = 'claude-code';

const ROUTINE_FIELDS = [
  'routine_id', 'nome', 'versao', 'status', 'sistema', 'host', 'espaco', 'gatilho',
  'cadencia', 'hora', 'fuso', 'dias_da_semana', 'dias_do_mes', 'vigente_desde', 'se_perder',
  'gatilho_externo', 'instrucao', 'skills', 'modelo', 'esforco', 'autenticacao', 'permissao',
  'destino_tipo', 'destino', 'tempo_limite_segundos', 'tentativas', 'espera_segundos',
  'motivo_do_acesso', 'acessos', 'aprovado_por', 'aprovado_em', 'updated',
];

// Caminho do contrato → campo da nota, para os três validadores que a Rotina atravessa.
const ROUTINE_FIELD_BY_PATH = {
  protocol_version: 'routine_id',
  routine_id: 'routine_id',
  version: 'versao',
  name: 'nome',
  lifecycle: 'status',
  routine: 'status',
  system_ref: 'sistema',
  'trigger.type': 'gatilho',
  'trigger.schedule': 'cadencia',
  'trigger.schedule.cadence': 'cadencia',
  cadência: 'cadencia',
  'trigger.schedule.time': 'hora',
  'trigger.schedule.timezone': 'fuso',
  'trigger.schedule.weekdays': 'dias_da_semana',
  weekdays: 'dias_da_semana',
  'trigger.schedule.month_days': 'dias_do_mes',
  month_days: 'dias_do_mes',
  'trigger.schedule.not_before': 'vigente_desde',
  'trigger.schedule.missed_run_policy': 'se_perder',
  missed_run_policy: 'se_perder',
  'placement.host_ref': 'host',
  'placement.workspace_ref': 'espaco',
  'executor.binding_ref': 'routine_id',
  'executor.requested_model': 'modelo',
  'executor.reasoning_effort': 'esforco',
  'context.prompt_ref': 'instrucao',
  'context.skill_refs': 'skills',
  'context.access_requests': 'acessos',
  'context.access_requests.grant_ref': 'acessos',
  'context.access_requests.source_ref': 'acessos',
  'context.access_requests.action': 'acessos',
  'context.access_requests.mode': 'acessos',
  'write-with-approval': 'permissao',
  permission_mode: 'permissao',
  'destination.kind': 'destino_tipo',
  'destination.ref': 'destino',
  'operations.timeout_seconds': 'tempo_limite_segundos',
  'operations.concurrency': 'routine_id',
  'retry.max_attempts': 'tentativas',
  'retry.backoff_seconds': 'espera_segundos',
  'retry.idempotency_scope': 'routine_id',
  'approval.required_before_schedule': 'status',
  'approval.approved_by': 'aprovado_por',
  'approval.approved_at': 'aprovado_em',
  privacy: 'routine_id',
  // Access Grant.
  grant_id: 'acessos',
  grant: 'acessos',
  'subject.type': 'sistema',
  'subject.ref': 'sistema',
  'scope.company_ref': 'sistema',
  'scope.unit_ref': 'sistema',
  'scope.system_refs': 'sistema',
  'scope.source_refs': 'acessos',
  'scope.actions': 'acessos',
  mode: 'acessos',
  assurance: 'acessos',
  custody: 'acessos',
  reason: 'motivo_do_acesso',
  issued_at: 'aprovado_em',
  expires_at: 'aprovado_em',
  revoked_at: 'aprovado_em',
  approved_by: 'aprovado_por',
  credential_ref: 'acessos',
  'receipts.use_refs': 'acessos',
  // Executor binding.
  binding_id: 'routine_id',
  adapter: 'host',
  host_ref: 'host',
  workspace_ref: 'espaco',
  workspace_path: 'espaco',
  'auth.type': 'autenticacao',
  'auth.status': 'autenticacao',
  'model_policy.default_model': 'modelo',
  'model_policy.allowed_models': 'modelo',
  permission_profile: 'permissao',
  observed_at: 'updated',
  routine_contract: 'type',
  access_grant: 'type',
  executor_binding: 'type',
};

// Caminho relativo que fica dentro do vault e aponta para arquivo que existe. O protocolo
// aceita qualquer `local_ref`, mas rotina com instrução inexistente é promessa vazia.
function vaultFile(data, field, errors, { root, label = null, value = null }) {
  const reference = value === null ? single(data[field]) : value;
  const name = label ? `${label}: ` : '';
  if (!LOCAL_REF_RE.test(reference) || isAbsolute(reference)
    || reference.split(/[\\/]/).includes('..')) {
    errors.push(problem(field, `${name}precisa ser um caminho relativo dentro do vault (ex.: .claude/skills/daily/SKILL.md)`));
    return null;
  }
  if (root && !existsSync(join(root, reference))) {
    errors.push(problem(field, `${name}arquivo não encontrado no vault: ${reference}`));
    return null;
  }
  return reference;
}

// Routine → Routine Contract v1 + um Access Grant por acesso declarado + executor binding.
// A nota declara o Sistema que a rotina executa (wikilink), a agenda, onde roda, o que lê
// e escreve, e quem aprovou. Nada aqui executa modelo: o contrato é declaração, e é o
// Console que lê o que foi declarado.
function mapRoutine(data, {
  sourceIds = new Map(), systemIndex = new Map(), root = null,
} = {}) {
  const errors = refuseValues(data, ROUTINE_FIELDS);
  const routineId = required(data, 'routine_id', errors);
  if (routineId && !ID_RE.test(routineId)) {
    errors.push(problem('routine_id', 'id precisa ser kebab-case minúsculo (ex.: daily-nuvem)'));
  }
  const name = required(data, 'nome', errors);
  const version = single(data.versao) || '0.1.0';
  if (!VERSION_RE.test(version)) errors.push(problem('versao', 'precisa ser semver (ex.: 0.1.0)'));
  const lifecycle = choice(data, 'status', ROUTINE_LIFECYCLES, errors);

  // O Sistema é o que a rotina executa, e é dele que o grant herda sujeito e escopo.
  const systemRaw = required(data, 'sistema', errors);
  let systemRef = null;
  let companyRef = null;
  if (systemRaw) {
    const target = slug(systemRaw);
    const system = systemIndex.get(target) || null;
    if (!system) {
      errors.push(problem('sistema', `nenhuma nota System com system_id "${target}" neste vault`));
    } else {
      systemRef = system.systemId;
      companyRef = system.area || null;
    }
  }

  const host = choice(data, 'host', HOSTS, errors);
  const workspace = required(data, 'espaco', errors);
  if (workspace && !REF_RE.test(workspace)) {
    errors.push(problem('espaco', 'precisa ser um slug simples (letras, números, - ou _)'));
  }

  const triggerType = choice(data, 'gatilho', ROUTINE_TRIGGERS, errors);
  let schedule = null;
  if (triggerType === 'schedule') {
    const cadence = choice(data, 'cadencia', CADENCES, errors);
    const time = required(data, 'hora', errors);
    if (time && !TIME_RE.test(time)) {
      errors.push(problem('hora', 'precisa ser HH:MM em relógio de 24 horas (ex.: 06:53)'));
    }
    const timezone = required(data, 'fuso', errors);
    if (timezone && !validTimezone(timezone)) {
      errors.push(problem('fuso', 'fuso inválido; use um nome IANA (ex.: America/Maceio)'));
    }

    const weekdays = [];
    for (const raw of values(data.dias_da_semana)) {
      const code = WEEKDAYS[raw.trim().toLowerCase()];
      if (!code) errors.push(problem('dias_da_semana', `"${raw}" não é dia da semana; use ${WEEKDAY_NAMES}`));
      else if (weekdays.includes(code)) errors.push(problem('dias_da_semana', `"${raw}" repetido`));
      else weekdays.push(code);
    }
    const monthDays = [];
    for (const raw of values(data.dias_do_mes)) {
      const day = Number(raw);
      if (!Number.isInteger(day) || day < 1 || day > 28) {
        errors.push(problem('dias_do_mes', `"${raw}" precisa ser inteiro entre 1 e 28`));
      } else if (monthDays.includes(day)) errors.push(problem('dias_do_mes', `"${raw}" repetido`));
      else monthDays.push(day);
    }
    if (cadence === 'weekly' && !weekdays.length) {
      errors.push(problem('dias_da_semana', 'cadência semanal exige pelo menos um dia da semana'));
    }
    if (cadence && cadence !== 'weekly' && weekdays.length) {
      errors.push(problem('dias_da_semana', 'só a cadência semanal tem dias da semana'));
    }
    if (cadence === 'monthly' && !monthDays.length) {
      errors.push(problem('dias_do_mes', 'cadência mensal exige pelo menos um dia do mês'));
    }
    if (cadence && cadence !== 'monthly' && monthDays.length) {
      errors.push(problem('dias_do_mes', 'só a cadência mensal tem dias do mês'));
    }

    const sinceRaw = required(data, 'vigente_desde', errors);
    const notBefore = stamp(sinceRaw);
    if (sinceRaw && !notBefore) errors.push(problem('vigente_desde', 'data inválida; use YYYY-MM-DD'));
    const missedRaw = single(data.se_perder);
    let missed = 'run-on-wake';
    if (missedRaw) {
      if (!(missedRaw in MISSED_RUNS)) {
        errors.push(problem('se_perder', `valor inválido; use ${Object.keys(MISSED_RUNS).join(', ')}`));
      } else missed = MISSED_RUNS[missedRaw];
    }
    schedule = {
      cadence,
      time,
      timezone,
      weekdays,
      month_days: monthDays,
      not_before: notBefore,
      missed_run_policy: missed,
    };
  } else if (triggerType === 'manual') {
    for (const field of ['cadencia', 'hora', 'fuso', 'dias_da_semana', 'dias_do_mes', 'vigente_desde']) {
      if (values(data[field]).length) errors.push(problem(field, 'gatilho manual não tem agenda'));
    }
  }

  const model = single(data.modelo) || DEFAULT_MODEL;
  if (!LOCAL_REF_RE.test(model)) {
    errors.push(problem('modelo', 'precisa ser um identificador simples (ex.: padrao-da-conta)'));
  }
  const effortRaw = single(data.esforco);
  let effort = DEFAULT_EFFORT;
  if (effortRaw) {
    if (!(effortRaw in EFFORTS)) {
      errors.push(problem('esforco', `valor inválido; use ${Object.keys(EFFORTS).join(', ')}`));
    } else effort = EFFORTS[effortRaw];
  }
  const authRaw = single(data.autenticacao);
  let auth = DEFAULT_AUTH;
  if (authRaw) {
    if (!(authRaw in AUTH_STATUSES)) {
      errors.push(problem('autenticacao', `valor inválido; use ${Object.keys(AUTH_STATUSES).join(', ')}`));
    } else auth = AUTH_STATUSES[authRaw];
  }

  const instructionRaw = required(data, 'instrucao', errors);
  const instruction = instructionRaw ? vaultFile(data, 'instrucao', errors, { root }) : null;
  const skills = [];
  for (const [index, reference] of values(data.skills).entries()) {
    const resolved = vaultFile(data, 'skills', errors, { root, label: `item ${index + 1}`, value: reference });
    if (resolved && skills.includes(resolved)) errors.push(problem('skills', `"${resolved}" repetido`));
    else if (resolved) skills.push(resolved);
  }

  const permission = choice(data, 'permissao', ROUTINE_PERMISSIONS, errors);
  const destinationKind = choice(data, 'destino_tipo', DESTINATIONS, errors);
  const destinationRaw = required(data, 'destino', errors);
  let destination = null;
  if (destinationRaw) {
    if (!LOCAL_REF_RE.test(destinationRaw) || isAbsolute(destinationRaw)
      || destinationRaw.split(/[\\/]/).includes('..')) {
      errors.push(problem('destino', 'precisa ser um caminho relativo dentro do Cérebro (ex.: journal)'));
    } else destination = destinationRaw;
  }

  const timeout = ranged(data, 'tempo_limite_segundos', errors, DEFAULT_TIMEOUT_SECONDS, 10, 7200);
  const attempts = ranged(data, 'tentativas', errors, DEFAULT_ATTEMPTS, 1, 3);
  const backoff = ranged(data, 'espera_segundos', errors, DEFAULT_BACKOFF_SECONDS, 0, 900);

  const declared = objects(data.acessos);
  if (!declared.length) {
    errors.push(problem('acessos', 'declare pelo menos um acesso com fonte, acao e modo'));
  }
  const reason = declared.length ? required(data, 'motivo_do_acesso', errors) : '';
  const accesses = [];
  const grantIds = new Set();
  for (const [index, item] of declared.entries()) {
    const label = `item ${index + 1}`;
    const reference = nested(item, 'fonte');
    let sourceId = null;
    if (!reference) errors.push(problem('acessos', `${label}: fonte obrigatória e vazia`));
    else {
      const target = slug(reference);
      sourceId = sourceIds.get(target) || null;
      if (!sourceId) {
        errors.push(problem('acessos', `${label}: a fonte "${target}" não tem nota DataSource com source_id neste vault`));
      }
    }
    const action = nested(item, 'acao');
    if (!action) errors.push(problem('acessos', `${label}: acao obrigatória e vazia`));
    else if (!ID_RE.test(action)) {
      errors.push(problem('acessos', `${label}: acao precisa ser kebab-case minúsculo (ex.: ler-eventos)`));
    }
    const modeRaw = nested(item, 'modo');
    let mode = null;
    if (!modeRaw) {
      errors.push(problem('acessos', `${label}: modo obrigatório e vazio; use ${Object.keys(REQUEST_MODES).join(', ')}`));
    } else if (!(modeRaw in REQUEST_MODES)) {
      errors.push(problem('acessos', `${label}: modo inválido; use ${Object.keys(REQUEST_MODES).join(', ')}`));
    } else mode = REQUEST_MODES[modeRaw];

    // Um grant por acesso: o protocolo exige grant_ref único em cada pedido, e um grant
    // por fonte e ação é o que a tela Governança audita.
    const grantId = routineId && sourceId && action ? `grant-${routineId}-${sourceId}-${action}` : null;
    if (grantId && !REF_RE.test(grantId)) {
      errors.push(problem('acessos', `${label}: o id do grant ficaria longo demais; encurte routine_id, fonte ou acao`));
    } else if (grantId && grantIds.has(grantId)) {
      errors.push(problem('acessos', `${label}: a mesma fonte com a mesma acao já foi declarada`));
    } else if (grantId) grantIds.add(grantId);
    accesses.push({ grantId, sourceId, action, mode });
  }
  if (permission === 'read-only' && accesses.some((access) => access.mode === 'write-with-approval')) {
    errors.push(problem('permissao', 'acesso com escrita-com-aprovacao exige permissao escrita-no-espaco'));
  }

  const approverRaw = single(data.aprovado_por);
  const approver = approverRaw ? slug(approverRaw) : null;
  if (approver && !REF_RE.test(approver)) {
    errors.push(problem('aprovado_por', 'o alvo do wikilink precisa ser um slug simples (letras, números, - ou _)'));
  }
  const approvedAtRaw = single(data.aprovado_em);
  const approvedAt = approvedAtRaw ? stamp(approvedAtRaw) : null;
  if (approvedAtRaw && !approvedAt) errors.push(problem('aprovado_em', 'data inválida; use YYYY-MM-DD'));
  if (lifecycle === 'approved' && (!approver || !approvedAt)) {
    errors.push(problem('aprovado_por', 'rotina Aprovada exige aprovado_por e aprovado_em'));
  }
  if (lifecycle === 'draft' && (approver || approvedAt)) {
    errors.push(problem('aprovado_por', 'rotina em Rascunho não pode declarar aprovação'));
  }

  // A observação do executor sai da nota, nunca do relógio: é o que mantém a recompilação
  // idêntica.
  const updatedRaw = required(data, 'updated', errors);
  const observed = updatedRaw ? stamp(updatedRaw) : null;
  if (updatedRaw && !observed) errors.push(problem('updated', 'data inválida; use YYYY-MM-DD'));

  const externalTrigger = single(data.gatilho_externo) || null;
  if (externalTrigger && !REF_RE.test(externalTrigger)) {
    errors.push(problem('gatilho_externo', 'precisa ser um id simples (letras, números, - ou _)'));
  }

  if (errors.length) return { errors };

  const bindingId = `executor-${routineId}`;
  const contract = {
    protocol_version: 1,
    routine_id: routineId,
    version,
    name,
    lifecycle,
    system_ref: systemRef,
    trigger: { type: triggerType, schedule },
    placement: { host_ref: host, workspace_ref: workspace },
    executor: { binding_ref: bindingId, requested_model: model, reasoning_effort: effort },
    context: {
      prompt_ref: instruction,
      ...(skills.length ? { skill_refs: skills } : {}),
      access_requests: accesses.map((access) => ({
        grant_ref: access.grantId,
        source_ref: access.sourceId,
        action: access.action,
        mode: access.mode,
      })),
    },
    permission_mode: permission,
    destination: { kind: destinationKind, ref: destination },
    operations: {
      timeout_seconds: timeout,
      retry: { max_attempts: attempts, backoff_seconds: backoff, idempotency_scope: 'scheduled-slot' },
      concurrency: 'forbid',
    },
    // Toda rotina deste cérebro passa por aprovação humana antes de entrar na agenda.
    approval: {
      required_before_schedule: true,
      approved_by: approver,
      approved_at: approvedAt,
    },
    privacy: { content_shared_with_inevita: false },
    extensions: {
      // Id do agendamento que roda a rotina fora do Cérebro (claude.ai), só como
      // referência: é o que liga o contrato ao agendamento real.
      external_trigger_ref: externalTrigger,
      vault_note_ref: null,
      vault_note_type: 'Routine',
    },
  };

  // Grant sem aprovador seria aprovação inventada: rotina em Rascunho declara o pedido de
  // acesso, mas não gera grant. O Console mostra o acesso como `missing`, que é a verdade.
  const grants = lifecycle === 'approved' ? accesses.map((access) => ({
    protocol_version: 1,
    grant_id: access.grantId,
    subject: { type: 'system', ref: systemRef },
    scope: {
      company_ref: companyRef || workspace,
      unit_ref: null,
      system_refs: [systemRef],
      source_refs: [access.sourceId],
      actions: [access.action],
    },
    mode: access.mode,
    // O vault não guarda credencial sob custódia de runtime: o agente usa a sessão da
    // própria conta, então a garantia é por recibo auditado, nunca runtime-enforced.
    assurance: 'receipt-audited',
    custody: 'agent-direct',
    reason,
    issued_at: approvedAt,
    expires_at: null,
    revoked_at: null,
    approved_by: approver,
    credential_ref: null,
    receipts: { use_refs: [], revocation_ref: null },
    extensions: {
      routine_ref: routineId,
      vault_note_ref: null,
      vault_note_type: 'Routine',
    },
  })) : [];

  const binding = {
    protocol_version: 1,
    binding_id: bindingId,
    adapter: ROUTINE_ADAPTER,
    host_ref: host,
    workspace_ref: workspace,
    // O espaço de trabalho da rotina é o próprio Cérebro: ela roda dentro do vault.
    workspace_path: '.',
    auth: { type: 'provider-session', status: auth },
    model_policy: { default_model: model, allowed_models: [] },
    permission_profile: permission,
    observed_at: observed,
    privacy: { credential_stored: false, content_shared_with_inevita: false },
  };

  return {
    errors: [],
    artifacts: [
      { output: 'routine', contract },
      ...grants.map((grant) => ({ output: 'grant', contract: grant })),
      { output: 'executor', contract: binding },
    ],
  };
}

export const VAULT_CONTRACT_TYPES = [
  {
    noteType: 'DataSource',
    map: mapDataSource,
    outputs: {
      primary: {
        label: 'fonte',
        layoutKey: 'sourceContracts',
        defaultDirectory: join('.cerebro', 'contracts', 'sources'),
        validate: validateSourceContract,
        idField: 'source_id',
        fieldByPath: DATA_SOURCE_FIELD_BY_PATH,
      },
    },
  },
  {
    noteType: 'System',
    map: mapSystem,
    objectListFields: ['fontes', 'etapas', 'entidades'],
    outputs: {
      primary: {
        label: 'sistema',
        layoutKey: 'systemContracts',
        defaultDirectory: join('.cerebro', 'contracts', 'systems'),
        validate: validateSystemContract,
        idField: 'system_id',
        fieldByPath: SYSTEM_FIELD_BY_PATH,
      },
    },
  },
  {
    noteType: 'Routine',
    map: mapRoutine,
    objectListFields: ['acessos'],
    outputs: {
      routine: {
        label: 'rotina',
        layoutKey: 'routineContracts',
        defaultDirectory: join('.cerebro', 'contracts', 'routines'),
        // O leitor de Rotinas do protocolo só aceita diretório dentro de
        // `.cerebro/contracts`: layout apontando para fora cai no padrão.
        boundary: join('.cerebro', 'contracts'),
        validate: validateRoutineContract,
        idField: 'routine_id',
        fieldByPath: ROUTINE_FIELD_BY_PATH,
      },
      grant: {
        label: 'grant',
        layoutKey: 'accessGrants',
        defaultDirectory: join('.cerebro', 'contracts', 'access-grants'),
        validate: validateAccessGrant,
        idField: 'grant_id',
        fieldByPath: ROUTINE_FIELD_BY_PATH,
      },
      executor: {
        label: 'executor',
        layoutKey: 'executorBindings',
        // O binding é estado privado: vive no runtime, que fica fora do Git. Ele é gerado
        // de todo jeito para que o Console resolva o executor da rotina, e o registro em
        // `.cerebro/compiled.json` o assume como arquivo próprio do compilador.
        defaultDirectory: join('.cerebro', 'runtime', 'executors'),
        boundary: join('.cerebro', 'runtime'),
        validate: validateExecutorBinding,
        idField: 'binding_id',
        fieldByPath: ROUTINE_FIELD_BY_PATH,
      },
    },
  },
];

// Erro do validador ("scope.purpose precisa ser texto não vazio") volta como campo da
// nota mais motivo, para que o dono corrija a nota sem abrir o JSON.
function translate(message, fieldByPath) {
  const [path, ...rest] = String(message).split(' ');
  const normalized = path.replace(/\[\d+\]/g, '')
    .replace(/^(?:source_contract|system_contract|routine_contract|access_grant|executor_binding)\./, '');
  return problem(fieldByPath[normalized] || normalized || 'contrato', rest.join(' ') || 'inválido');
}

// Diretório declarado pelo layout, confinado ao Cérebro e, quando o protocolo exige, a uma
// pasta específica dele (Rotina em `.cerebro/contracts`, binding em `.cerebro/runtime`).
// Layout apontando para fora do limite cai no padrão, em vez de gravar onde o leitor do
// protocolo não procura.
function insideRoot(root, configured, fallback, boundary = '') {
  const base = resolve(root);
  const limit = boundary ? resolve(base, boundary) : base;
  if (typeof configured !== 'string' || !configured || isAbsolute(configured)) return resolve(base, fallback);
  const target = resolve(base, configured);
  if (target === limit || !target.startsWith(`${limit}${sep}`)) return resolve(base, fallback);
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
// procedimentos. `templates/` conta em qualquer nível — a pasta pode morar numa subpasta
// do vault, e o caminho ainda vem prefixado pela raiz de conhecimento.
function isDraft(path) {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  return segments.slice(0, -1).includes('templates') || name.startsWith('_');
}

// Notas do vault com um dos types compiláveis. Ignora pasta oculta e node_modules
// (herdado da varredura do read model), e devolve o caminho relativo à raiz do Cérebro.
function typedNotes(root, knowledgeRoot, noteTypes, objectLists) {
  const prefix = knowledgeRoot && knowledgeRoot !== '.' ? `${posix(knowledgeRoot)}/` : '';
  return knowledgeNotes(root, knowledgeRoot || '.')
    .map((note) => ({
      ...note,
      path: `${prefix}${posix(note.relative)}`,
      slug: note.relative.slice(note.relative.lastIndexOf('/') + 1, -3),
      data: parseFrontmatter(note.content, { objectLists }),
    }))
    .filter((note) => noteTypes.has(String(note.data.type || '').trim()) && !isDraft(note.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

// Fonte declarada numa nota de Sistema é wikilink para a nota DataSource. O compilador
// resolve o alvo (slug do arquivo, ou o próprio source_id) no id do contrato dela; alvo
// sem nota correspondente vira erro legível, nunca contrato com fonte inventada.
function sourceIdIndex(notes) {
  const index = new Map();
  for (const note of notes) {
    if (String(note.data.type || '').trim() !== 'DataSource') continue;
    const id = single(note.data.source_id);
    if (!id || !ID_RE.test(id)) continue;
    index.set(note.slug, id);
    index.set(id, id);
  }
  return index;
}

// Sistema declarado numa nota de Rotina é wikilink para a nota System. O índice resolve o
// alvo (slug do arquivo ou o próprio system_id) no id do contrato e na área operacional,
// que é o escopo que o Access Grant herda.
function systemIndexOf(notes) {
  const index = new Map();
  for (const note of notes) {
    if (String(note.data.type || '').trim() !== 'System') continue;
    const id = single(note.data.system_id);
    if (!id || !ID_RE.test(id)) continue;
    const areaRaw = single(note.data.area);
    const area = areaRaw ? slug(areaRaw) : '';
    const entry = { systemId: id, area: ID_RE.test(area) ? area : '' };
    index.set(note.slug, entry);
    index.set(id, entry);
  }
  return index;
}

// Slugs das notas de área do vault, para recusar `area:` que aponta para o nada. Vault
// sem pasta de áreas declarada não ganha a checagem.
function areaSlugIndex(root, config) {
  const folder = config?.vault?.areas;
  if (typeof folder !== 'string' || !folder || isAbsolute(folder)) return null;
  const directory = insideRoot(root, folder, '');
  if (directory === resolve(root) || !existsSync(directory)) return null;
  try {
    return new Set(readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
      .map((entry) => entry.name.slice(0, -3)));
  } catch {
    return null;
  }
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
  const objectLists = [...new Set(VAULT_CONTRACT_TYPES.flatMap((compiler) => compiler.objectListFields || []))];
  const notes = typedNotes(base, config.knowledgeRoot || '.', new Set(byType.keys()), objectLists);
  const context = {
    root: base,
    sourceIds: sourceIdIndex(notes),
    systemIndex: systemIndexOf(notes),
    areaSlugs: areaSlugIndex(base, config),
  };

  const results = [];
  const owned = new Map();
  const seen = new Map();
  const written = [];
  const removed = [];

  // Caminho de cada artefato de uma nota, na pasta que o layout declara para o tipo dele.
  function locate(compiler, artifacts) {
    return artifacts.map((artifact) => {
      const output = compiler.outputs[artifact.output];
      const directory = insideRoot(base, config[output.layoutKey], output.defaultDirectory, output.boundary);
      const id = artifact.contract[output.idField];
      return {
        ...artifact,
        output,
        id,
        ref: posix(join(directory.slice(base.length + 1), `${id}.json`)),
      };
    });
  }

  for (const note of notes) {
    const compiler = byType.get(String(note.data.type).trim());
    if (!note.readable) {
      results.push({ path: note.path, type: compiler.noteType, status: 'error', errors: [problem('arquivo', 'nota ilegível')] });
      continue;
    }
    const first = compiler.map(note.data, { ...context, previous: null, now });
    let errors = first.errors;
    let located = [];

    if (!errors.length) {
      const primary = locate(compiler, normalizeArtifacts(first))[0] || null;
      const primaryPath = primary ? join(base, primary.ref) : null;
      const previous = primaryPath && existsSync(primaryPath) ? readRegistryContract(primaryPath) : null;
      // Recompilar não pode mexer na observação: ela vem do `updated` da nota ou do
      // valor já gravado.
      const mapped = compiler.map(note.data, { ...context, previous, now });
      errors = mapped.errors;
      located = errors.length ? [] : locate(compiler, normalizeArtifacts(mapped));
    }

    for (const artifact of located) {
      // Binding do executor é fechado pelo protocolo e não aceita extensões: só o
      // artefato que já reserva a chave aponta de volta para a nota de origem.
      if (artifact.contract.extensions && 'vault_note_ref' in artifact.contract.extensions) {
        artifact.contract.extensions.vault_note_ref = note.path;
      }
      const duplicate = seen.get(artifact.ref);
      if (duplicate) {
        errors.push(problem(artifact.output.idField, `id já usado por ${duplicate}`));
        continue;
      }
      seen.set(artifact.ref, note.path);
      errors.push(...artifact.output.validate(artifact.contract)
        .map((message) => translate(message, artifact.output.fieldByPath)));
    }

    if (errors.length) {
      // A nota existe, então o contrato antigo dela não é órfão (ver o laço de órfãos
      // abaixo): fica como está até o dono corrigir a nota. O registro, porém, só lista
      // arquivo que este compilador garante válido. Uma nota que gera vários artefatos
      // não grava nenhum pela metade: o erro em qualquer um barra todos.
      results.push({ path: note.path, type: compiler.noteType, status: 'error', errors });
      continue;
    }

    for (const artifact of located) {
      const serialized = `${JSON.stringify(artifact.contract, null, 2)}\n`;
      const contractPath = join(base, artifact.ref);
      const current = existsSync(contractPath) ? readFileSync(contractPath, 'utf8') : null;
      const changed = current !== serialized;
      owned.set(artifact.ref, { note: note.path, type: compiler.noteType, id: artifact.id });
      if (confirm && changed) {
        ensureRuntime(base);
        writeJsonAtomic(contractPath, artifact.contract);
        written.push(artifact.ref);
      }
      results.push({
        path: note.path,
        type: compiler.noteType,
        label: artifact.output.label,
        status: 'ok',
        id: artifact.id,
        contract_ref: artifact.ref,
        changed,
        errors: [],
      });
    }
  }

  const registry = readRegistry(base);
  const notePaths = new Set(notes.map((note) => note.path));
  const failedNotes = new Set(results.filter((item) => item.status === 'error').map((item) => item.path));
  // Nota que existe e falhou na validação fica com o último contrato bom em disco (ver o
  // laço de erros acima). O registro precisa continuar listando esse arquivo, senão ele
  // vira órfão invisível: quando a nota for apagada, ninguém mais sabe que era dela.
  const retained = new Map();
  for (const entry of registry.files) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (owned.has(entry.path)) continue;
    // Só é órfão o arquivo que este compilador gerou para uma nota que não existe mais.
    if (typeof entry.note === 'string' && notePaths.has(entry.note)) {
      if (failedNotes.has(entry.note) && existsSync(join(base, entry.path))) {
        retained.set(entry.path, { type: entry.type, note: entry.note });
      }
      continue;
    }
    removed.push(entry.path);
    if (confirm) rmSync(join(base, entry.path), { force: true });
  }

  const nextRegistry = {
    protocol_version: 1,
    files: [...owned.entries(), ...retained.entries()]
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

// Mapeador de um artefato só devolve `contract`; o de Rotina devolve `artifacts`. O laço
// trabalha sempre com a lista.
function normalizeArtifacts(mapped) {
  if (Array.isArray(mapped.artifacts)) return mapped.artifacts;
  return mapped.contract ? [{ output: 'primary', contract: mapped.contract }] : [];
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
