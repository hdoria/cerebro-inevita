// Importa o histórico do journal de um vault tipado como execuções das Rotinas
// compiladas: cada daily (`journal/AAAA-MM-DD.md`) e cada weekly review
// (`journal/AAAA-Www-review.md`) vira um Routine Run Receipt, com ponteiro de saída
// (caminho e hash, nunca conteúdo) na pasta de saídas da rotina e um trace reconstruído.
//
// Só lê o vault; escreve apenas no runtime do Cérebro. Reaproveita o formato do
// importador legado (`legacy-routine-run-import.mjs`): recibo + trace reconstruído +
// arquivo de saída reference-only. A diferença é a fonte: ali um manifesto declarado,
// aqui as notas que a rotina de nuvem já gravou no vault.
//
// O recibo é um schema fechado (sem `extensions`), então a marca de histórico importado
// mora no único campo livre que o schema oferece — `reason_code` — e o resto do contexto
// (origem reconstruída, hash da nota, ator declarado, estado de verificação) fica no
// trace e no ponteiro de saída, que aceitam extensões.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createExecutionTracer, readExecutionTrace } from './execution-trace-runtime.mjs';
import {
  createSlotKey,
  listRoutineContracts,
  loadExecutorBinding,
  listRoutineRunReceipts,
  routineOutputDirectory,
  writeRoutineRunReceipt,
} from './routine-protocol.mjs';
import { layout } from './system-protocol.mjs';
import { scanPii } from './vault-history.mjs';

const DAILY_NOTE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const WEEKLY_NOTE_RE = /^(\d{4})-W(\d{2})-review\.md$/;
const DAY_MS = 86_400_000;
// Marca de histórico importado no único campo livre do Routine Run Receipt.
export const IMPORT_REASON_CODE = 'journal-history-imported';
// Mesma marca que o importador de sessões usa: sem evidência de verificação, o recibo
// nunca se apresenta como conferido.
export const UNVERIFIED_MARKER = 'legacy-unverified';
// Seção da daily que nomeia quem rodou a rotina naquele dia.
const AGENT_LOG_SECTION = 'Log de agentes';
// Cadências do protocolo que este importador sabe reconstruir a partir do journal.
const KINDS = [
  { id: 'daily', cadence: 'daily', label: 'diária' },
  { id: 'weekly-review', cadence: 'weekly', label: 'semanal' },
];
const ISO_WEEKDAYS = new Map([['MO', 1], ['TU', 2], ['WE', 3], ['TH', 4], ['FR', 5], ['SA', 6], ['SU', 7]]);

function inside(root, ref) {
  if (typeof ref !== 'string' || !ref || isAbsolute(ref)) return false;
  const target = resolve(root, ref);
  const base = resolve(root);
  return target === base || target.startsWith(`${base}${sep}`);
}

function posix(value) {
  return value.split(sep).join('/');
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

function deterministicId(prefix, material) {
  return `${prefix}-${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

// Offset real do fuso naquele instante, medido pelo próprio Intl: não assume -03:00 nem
// ausência de horário de verão.
function zoneOffset(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
  return asUtc - instant;
}

// A nota só tem data; o instante da execução é a hora de agenda declarada pela rotina no
// fuso dela, convertida para UTC. Meia-noite UTC jogaria a execução para o dia anterior.
export function zonedInstant(date, time, timezone) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
  if (!match) throw new Error(`hora de agenda inválida: ${time}`);
  const naive = Date.parse(`${date}T${match[1]}:${match[2]}:00Z`);
  if (!Number.isFinite(naive)) throw new Error(`data inválida: ${date}`);
  let instant = naive;
  // Duas passadas convergem mesmo em virada de offset: a primeira mede o offset perto do
  // alvo, a segunda confirma no instante corrigido.
  for (let pass = 0; pass < 2; pass += 1) instant = naive - zoneOffset(instant, timezone);
  return new Date(instant).toISOString();
}

// Data do dia ISO pedido dentro de uma semana ISO (segunda = 1 … domingo = 7).
export function isoWeekDate(year, week, isoDay) {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4IsoDay = ((new Date(jan4).getUTCDay() + 6) % 7) + 1;
  const week1Monday = jan4 - (jan4IsoDay - 1) * DAY_MS;
  const target = week1Monday + ((week - 1) * 7 + (isoDay - 1)) * DAY_MS;
  const value = new Date(target);
  if (!Number.isFinite(value.getTime())) throw new Error(`semana ISO inválida: ${year}-W${week}`);
  return value.toISOString().slice(0, 10);
}

function bodyOf(text) {
  return String(text || '').replace(/^---[\s\S]*?\n---/, '').trim();
}

// Ator declarado no primeiro item do `## Log de agentes` — "Claude Code (rotina diária
// automática)" e nada além do nome: o resto da linha é trabalho, não identidade.
export function declaredActor(text) {
  const body = String(text || '').replace(/^---[\s\S]*?\n---/, '');
  const pattern = new RegExp(`^##\\s+${AGENT_LOG_SECTION}\\s*$`, 'm');
  const start = body.search(pattern);
  if (start < 0) return null;
  const rest = body.slice(start).split('\n').slice(1);
  for (const line of rest) {
    if (/^##\s+/.test(line)) break;
    const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
    if (!bullet) continue;
    const actor = bullet[1].split(':')[0].trim().replace(/[`*_[\]]/g, '');
    return actor && actor.length <= 120 ? actor : null;
  }
  return null;
}

// Rotinas que gravam no journal, separadas pela cadência que declaram. Nada é hardcoded:
// a ligação vem do `destination` e do `trigger.schedule.cadence` do contrato compilado.
function journalRoutines(root, journalRef) {
  const found = new Map();
  const ambiguous = [];
  for (const contract of listRoutineContracts(root)) {
    if (contract.trigger?.type !== 'schedule') continue;
    if (contract.destination?.kind !== 'local-file') continue;
    if (posix(String(contract.destination.ref || '')) !== posix(journalRef)) continue;
    const kind = KINDS.find((candidate) => candidate.cadence === contract.trigger.schedule?.cadence);
    if (!kind) continue;
    if (found.has(kind.id)) {
      ambiguous.push({ kind: kind.id, routine_id: contract.routine_id });
      continue;
    }
    found.set(kind.id, contract);
  }
  return { found, ambiguous };
}

function pointerBody({ contract, noteRef, date, hash, bytes, actor }) {
  return `# Ponteiro de saída · ${noteRef}

- Rotina: ${contract.routine_id} ${contract.version} (${contract.name})
- Sistema: ${contract.system_ref}
- Data da execução: ${date}
- Nota no vault: ${noteRef}
- Hash da nota: sha256:${hash}
- Tamanho da nota: ${bytes} bytes
- Executor declarado: ${actor || '(não consta na nota)'}
- Origem: histórico do journal importado · trace reconstruído
- Verificação: ${UNVERIFIED_MARKER}

Este arquivo é um ponteiro, não a saída. O corpo da nota continua só no vault: abra
\`${noteRef}\` para ler o que a rotina escreveu naquele ${date}.
`;
}

function buildItem({ root, contract, binding, journalRef, name, kind, text }) {
  const noteRef = posix(join(journalRef, name));
  const schedule = contract.trigger.schedule;
  let date;
  if (kind.id === 'daily') {
    date = DAILY_NOTE_RE.exec(name)[1];
  } else {
    const [, year, week] = WEEKLY_NOTE_RE.exec(name);
    const weekday = ISO_WEEKDAYS.get(schedule.weekdays?.[0]) || 7;
    date = isoWeekDate(Number(year), Number(week), weekday);
  }
  const scheduledFor = zonedInstant(date, schedule.time, schedule.timezone);
  const material = `${contract.routine_id}|${noteRef}`;
  const runId = deterministicId('routine-run-journal', material);
  const receiptId = deterministicId('routine-receipt-journal', material);
  const outputRef = posix(join(relative(resolve(root), routineOutputDirectory(root)), `${runId}.pointer.md`));
  const promptRef = contract.context?.prompt_ref;
  const receipt = {
    protocol_version: 1,
    receipt_id: receiptId,
    run_id: runId,
    routine_ref: `routine:${contract.routine_id}:${contract.version}`,
    routine_id: contract.routine_id,
    routine_version: contract.version,
    system_ref: contract.system_ref,
    binding_ref: contract.executor.binding_ref,
    adapter: binding.adapter,
    requested_model: contract.executor.requested_model,
    model_observation: 'requested-not-verified',
    trigger: 'schedule',
    slot_key: createSlotKey(contract.routine_id, 'schedule', scheduledFor),
    scheduled_for: scheduledFor,
    attempts: 1,
    status: 'completed',
    reason_code: IMPORT_REASON_CODE,
    started_at: scheduledFor,
    completed_at: scheduledFor,
    input_refs: [...new Set([noteRef, promptRef].filter(Boolean))],
    output_ref: outputRef,
    access_receipt_refs: [],
    content_shared_with_provider: true,
    privacy: {
      content_shared_with_inevita: false,
      prompt_recorded: false,
      output_recorded: false,
      raw_error_recorded: false,
    },
  };
  const bytes = Buffer.byteLength(text, 'utf8');
  const hash = createHash('sha256').update(text).digest('hex');
  const actor = kind.id === 'daily' ? declaredActor(text) : null;
  return {
    ref: noteRef,
    kind: kind.id,
    date,
    receipt,
    contract,
    actor,
    hash,
    bytes,
    pointer: pointerBody({ contract, noteRef, date, hash, bytes, actor }),
    extensions: {
      origin: 'reconstructed',
      import_source: noteRef,
      note_kind: kind.id,
      note_hash: `sha256:${hash}`,
      verification_state: UNVERIFIED_MARKER,
      timing_assurance: 'completion-only',
      ...(actor ? { declared_actor: actor } : {}),
    },
  };
}

function writePointer(root, item) {
  const path = resolve(root, item.receipt.output_ref);
  if (existsSync(path)) {
    const current = readText(path);
    if (current === item.pointer) return 'no-change';
    writeFileSync(path, item.pointer, { mode: 0o600 });
    return 'refreshed';
  }
  mkdirSync(routineOutputDirectory(root), { recursive: true, mode: 0o700 });
  writeFileSync(path, item.pointer, { mode: 0o600 });
  return 'created';
}

// Trace reconstruído: run → skill declarada → capacidade → saída → julgamento pendente →
// run concluído. Reference-only, com a mesma forma do importador legado.
function writeReconstructedTrace(root, item) {
  const existing = readExecutionTrace(root, item.receipt.run_id);
  if (existing.length) return { status: 'no-change', events: existing.length };
  const occurredAt = new Date(item.receipt.started_at);
  const tracer = createExecutionTracer(root, {
    runId: item.receipt.run_id,
    systemRef: item.receipt.system_ref,
    routineRef: item.receipt.routine_ref,
    traceId: deterministicId('execution-trace-journal', item.receipt.run_id),
    clock: () => occurredAt,
  });
  const { extensions } = item;
  tracer.emit({
    stepId: 'run', stepType: 'run', state: 'running', parentStepId: null,
    inputRefs: item.receipt.input_refs, evidenceRef: item.ref, extensions,
  });
  if (item.contract.context?.prompt_ref) {
    tracer.emit({
      stepId: 'skill-1', stepType: 'skill', state: 'declared',
      skillRef: item.contract.context.prompt_ref, evidenceRef: item.ref,
      extensions: { ...extensions, load_assurance: 'requested-not-verified' },
    });
  }
  tracer.emit({
    stepId: 'capability', stepType: 'capability', state: 'completed',
    capabilityRef: `system:${item.receipt.system_ref}`, evidenceRef: item.ref, extensions,
  });
  tracer.emit({
    stepId: 'output', stepType: 'output', state: 'completed',
    outputRefs: [item.receipt.output_ref], evidenceRef: item.ref,
    extensions: { ...extensions, artifact_assurance: 'pointer-only' },
  });
  tracer.emit({
    stepId: 'judgment', stepType: 'judgment', state: 'pending',
    reasonCode: 'human-decision-pending', evidenceRef: item.ref, extensions,
  });
  tracer.emit({
    stepId: 'run', stepType: 'run', state: 'completed', parentStepId: null,
    reasonCode: item.receipt.reason_code, evidenceRef: item.ref, extensions,
  });
  return { status: 'created', events: readExecutionTrace(root, item.receipt.run_id).length };
}

export function importVaultJournalRuns(root, { confirm = false } = {}) {
  const empty = {
    mode: 'no-vault',
    journal_ref: null,
    routines: {},
    missing_routine: {},
    ambiguous: [],
    per_kind: {},
    skipped: [],
    pii_refused: [],
    invalid: [],
    conflicts: [],
    items: [],
    already_imported: 0,
    created: 0,
    refreshed: 0,
  };
  const config = layout(root).vault;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return empty;

  const journalRef = typeof config.daily === 'string' && config.daily ? config.daily : 'journal';
  if (!inside(root, journalRef)) throw new Error('o layout aponta o journal fora do Cérebro');

  const { found, ambiguous } = journalRoutines(root, journalRef);
  const bindings = new Map();
  const report = {
    ...empty,
    mode: 'vault',
    journal_ref: journalRef,
    ambiguous,
    routines: Object.fromEntries([...found].map(([kindId, contract]) => [kindId, {
      routine_id: contract.routine_id, version: contract.version, name: contract.name,
    }])),
    per_kind: Object.fromEntries(KINDS.map((kind) => [kind.id, 0])),
    missing_routine: Object.fromEntries(KINDS.map((kind) => [kind.id, 0])),
  };

  const directory = resolve(root, journalRef);
  if (!existsSync(directory)) return report;

  const items = [];
  for (const name of markdownFiles(directory)) {
    const kind = DAILY_NOTE_RE.test(name)
      ? KINDS[0]
      : (WEEKLY_NOTE_RE.test(name) ? KINDS[1] : null);
    const ref = posix(join(journalRef, name));
    if (!kind) {
      report.skipped.push({ ref, reason: 'nome fora da convenção de daily ou weekly review' });
      continue;
    }
    const contract = found.get(kind.id);
    if (!contract) {
      report.missing_routine[kind.id] += 1;
      continue;
    }
    const text = readText(join(directory, name));
    if (text === null) {
      report.skipped.push({ ref, reason: 'nota ilegível' });
      continue;
    }
    if (!bodyOf(text)) {
      report.skipped.push({ ref, reason: 'nota sem conteúdo depois do frontmatter' });
      continue;
    }
    let binding = bindings.get(contract.executor.binding_ref);
    if (!binding) {
      try {
        binding = loadExecutorBinding(root, contract.executor.binding_ref).binding;
      } catch (error) {
        report.skipped.push({ ref, reason: `executor binding indisponível: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      bindings.set(contract.executor.binding_ref, binding);
    }
    let item;
    try {
      item = buildItem({ root, contract, binding, journalRef, name, kind, text });
    } catch (error) {
      report.skipped.push({ ref, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const notBefore = Date.parse(contract.trigger.schedule?.not_before || '');
    if (Number.isFinite(notBefore) && Date.parse(item.receipt.scheduled_for) < notBefore) {
      report.skipped.push({ ref, reason: 'anterior ao vigente_desde da rotina' });
      continue;
    }
    // Varredura de PII em tudo que este módulo mapeia: recibo, ponteiro e extensões do
    // trace. Nenhum casamento é gravado; a nota é recusada e reportada.
    const pii = [
      ...scanPii(item.receipt, 'routine_run_receipt'),
      ...scanPii(item.pointer, 'output_pointer'),
      ...scanPii(item.extensions, 'trace_extensions'),
    ];
    if (pii.length) {
      report.pii_refused.push({ ref, matches: [...new Set(pii)] });
      continue;
    }
    items.push(item);
  }

  const existing = new Set(listRoutineRunReceipts(root).map((receipt) => receipt.receipt_id));
  for (const item of items) {
    report.per_kind[item.kind] += 1;
    report.items.push(item);
    if (existing.has(item.receipt.receipt_id)) report.already_imported += 1;
    else report.created += 1;
  }

  if (!confirm) return report;

  const written = [];
  for (const item of report.items) {
    const pointerStatus = writePointer(root, item);
    if (pointerStatus === 'refreshed') report.refreshed += 1;
    let receiptStatus = 'created';
    if (existing.has(item.receipt.receipt_id)) {
      receiptStatus = 'no-change';
    } else {
      try {
        writeRoutineRunReceipt(root, item.receipt);
      } catch (error) {
        report.invalid.push({ ref: item.ref, errors: [error instanceof Error ? error.message : String(error)] });
        continue;
      }
    }
    const trace = writeReconstructedTrace(root, item);
    written.push({
      ref: item.ref,
      receipt_ref: `routine-receipt:${item.receipt.receipt_id}`,
      run_id: item.receipt.run_id,
      receipt_status: receiptStatus,
      pointer_status: pointerStatus,
      trace_status: trace.status,
      trace_events: trace.events,
    });
  }
  report.written = written;
  return report;
}
