// Fila de tarefas no próprio Postgres (sem serviço extra) e o relógio da publicação.
import { db } from "../db.js";

const EM_PARALELO = 3;
const TRABALHOS = {};
let rodando = 0, parar = false, timers = [];

export async function enfileirar(org, tipo, payload, usuario, tx = null) {
  const { rows } = await (tx || db()).query("insert into tarefas (org_id, tipo, payload, criado_por) values ($1, $2, $3, $4) returning id", [org, tipo, JSON.stringify(payload || {}), usuario || null]);
  // Quem usa transação chama puxar depois do commit, para o trabalhador já enxergar a tarefa.
  if (!tx) setImmediate(() => puxar().catch(() => {}));
  return rows[0].id;
}

export function registrar(tipo, fn) { TRABALHOS[tipo] = fn; }

async function pegarProxima() {
  const { rows } = await db().query(`update tarefas set status = 'rodando', iniciado_em = now(), tentativas = tentativas + 1
    where id = (select id from tarefas where status = 'pendente' and executar_em <= now() order by criado_em for update skip locked limit 1)
    returning *`);
  return rows[0] || null;
}

export async function puxar() {
  while (!parar && rodando < EM_PARALELO) {
    const t = await pegarProxima();
    if (!t) return;
    rodando++;
    executar(t).finally(() => { rodando--; puxar().catch(() => {}); });
  }
}

async function executar(t) {
  const fn = TRABALHOS[t.tipo];
  try {
    if (!fn) throw new Error("tipo de tarefa desconhecido: " + t.tipo);
    const resultado = await fn(t.org_id, t.payload || {}, t);
    await db().query("update tarefas set status = 'feito', terminado_em = now(), payload = payload || $2 where id = $1", [t.id, JSON.stringify({ resultado: resultado || null })]);
  } catch (e) {
    console.error(`[tarefa ${t.tipo} ${t.id}]`, e);
    await db().query("update tarefas set status = 'erro', terminado_em = now(), erro = $2, payload = payload - 'token' where id = $1", [t.id, String(e.message || e).slice(0, 500)]).catch(() => {});
    if (fn && fn.aoFalhar) await fn.aoFalhar(t.org_id, t.payload || {}, e).catch(() => {});
  }
}

// Tarefas que ficaram "rodando" quando o servidor reiniciou voltam para a fila (até 3 tentativas).
async function recuperar() {
  await db().query("update tarefas set status = 'pendente' where status = 'rodando' and tentativas < 3");
  const { rows } = await db().query("update tarefas set status = 'erro', erro = 'interrompida várias vezes' where status = 'rodando' returning *");
  // Sem isso o post ficaria "Em criação" para sempre (e o crédito do plano não voltaria).
  for (const t of rows) { const fn = TRABALHOS[t.tipo]; if (fn && fn.aoFalhar) await fn.aoFalhar(t.org_id, t.payload || {}, new Error("o servidor reiniciou várias vezes durante a tarefa")).catch(() => {}); }
}

export async function iniciarTrabalhador(relogios = []) {
  parar = false;
  await recuperar();
  timers.push(setInterval(() => puxar().catch(e => console.error("[fila]", e)), 5000));
  for (const { cada, fn } of relogios) timers.push(setInterval(() => fn().catch(e => console.error("[relógio]", e)), cada));
  puxar().catch(() => {});
}
export function pararTrabalhador() { parar = true; timers.forEach(clearInterval); timers = []; }
