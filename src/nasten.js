// Webhooks autenticados, confirmação na API e fila durável de pagamentos Nasten.
import crypto from "node:crypto";
import { db } from "./db.js";
import { UUID, ErroApi } from "./erros.js";
import { OFERTAS_NASTEN, OFERTAS_NASTEN_ANTIGAS } from "./ofertas.js";
import { PLANOS, CICLOS, totalDo } from "./planos.js";

const BASE = "https://api.nasten.net";
const empresa = () => process.env.NASTEN_EMPRESA || "cmvh9snyi000m01jdkus2qxv5";
const texto = v => typeof v === "string" ? v.slice(0, 250) : "";
const normal = v => texto(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const numero = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const configurada = () => !!(process.env.NASTEN_PUBLIC_KEY && process.env.NASTEN_SECRET_KEY);
let cache = {}, autenticando = null, processando = false, conciliando = false;

export function assinaturaNastenOk(bruto, header) {
  const segredo = process.env.NASTEN_WEBHOOK_SECRET;
  if (!segredo || typeof header !== "string") return false;
  const m = /^t=(\d{13}),v1=([a-f0-9]{64})$/i.exec(header.replace(/\s/g, ""));
  if (!m || Math.abs(Date.now() - Number(m[1])) > 15 * 60000) return false;
  const esperado = crypto.createHmac("sha256", segredo).update(m[1] + "." + bruto).digest();
  const recebido = Buffer.from(m[2], "hex");
  return recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
}

async function token() {
  if (!configurada()) throw new Error("Configure NASTEN_PUBLIC_KEY e NASTEN_SECRET_KEY no Railway.");
  const credencial = `${process.env.NASTEN_PUBLIC_KEY}:${process.env.NASTEN_SECRET_KEY}`;
  if (cache.credencial === credencial && cache.ate > Date.now() + 30000) return cache.token;
  if (autenticando?.credencial === credencial) return autenticando.pedido;
  const pedido = (async () => {
    const r = await fetch(BASE + "/auth", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(credencial).toString("base64") }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`Falha na autenticação Nasten (HTTP ${r.status}).`);
    const j = await r.json();
    if (!j.success || !j.token || !(Number(j.expiresIn) > 0)) throw new Error("Resposta de autenticação Nasten inválida.");
    cache = { credencial, token: j.token, ate: Date.now() + Math.min(Number(j.expiresIn), 600000) };
    return j.token;
  })();
  autenticando = { credencial, pedido };
  try { return await pedido; } finally { if (autenticando?.pedido === pedido) autenticando = null; }
}

export async function consultarNasten(caminho) {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const r = await fetch(BASE + caminho, { headers: { Authorization: "Bearer " + await token() }, signal: AbortSignal.timeout(12000) });
    if (r.status === 401 && !tentativa) { cache = {}; continue; }
    if (!r.ok) throw new Error(`Consulta Nasten falhou (HTTP ${r.status}).`);
    const j = await r.json();
    if (!j.success || !j.data) throw new Error("Resposta de consulta Nasten inválida.");
    return j;
  }
}

function ofertaDo(c) {
  let extras = {}; try { extras = JSON.parse(process.env.NASTEN_OFERTAS || "{}"); } catch {}
  const par = [...Object.entries(OFERTAS_NASTEN), ...Object.entries(OFERTAS_NASTEN_ANTIGAS)].find(([, o]) => o.id === Number(c.sale?.mainOfferId) && o.produto === c.product?.id);
  const chave = extras[c.sale?.mainOfferId] || par?.[0];
  const [plano, ciclo] = String(chave || "").split(":");
  if (!PLANOS[plano]?.precos || !CICLOS[ciclo]) return null;
  return { plano, ciclo };
}

async function organizacaoDa(venda, q) {
  const email = texto(venda.customer?.emails?.[0]?.email || venda.customer?.email).trim().toLowerCase();
  const sck = texto(venda.trackingParameters?.sck);
  if (UUID.test(sck)) {
    const r = await q.query("select m.org_id from membros m join usuarios u on u.id = m.usuario_id where m.org_id = $1 and lower(u.email) = $2", [sck, email]);
    if (r.rows[0]) return r.rows[0].org_id;
    throw new Error("A organização do checkout não pertence ao comprador. Confira o e-mail da compra.");
  }
  // Compra pela landing: só associa pelo e-mail quando ele identifica exatamente uma organização.
  const r = await q.query("select m.org_id from membros m join usuarios u on u.id = m.usuario_id where lower(u.email) = $1 and m.papel = 'dono' limit 2", [email]);
  if (r.rows.length !== 1) throw new Error("Comprador sem organização única. Cadastre-se com o e-mail da compra ou use o checkout do plano dentro da organização.");
  return r.rows[0].org_id;
}

export function fimDoCiclo(data, meses) {
  const fim = new Date(data), dia = fim.getUTCDate();
  fim.setUTCDate(1); fim.setUTCMonth(fim.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth() + 1, 0)).getUTCDate();
  fim.setUTCDate(Math.min(dia, ultimo) + 3); // mesma tolerância de três dias do provedor anterior
  return fim;
}

async function aplicar(c, venda) {
  if (venda.id !== c.transaction.id || venda.saleType !== "producer" || venda.companyId !== empresa()) throw new Error("Venda não pertence à empresa Nasten configurada.");
  const id = venda.id, estorno = ["refund", "chargeback"].includes(venda.status);
  if (!estorno && venda.status !== "paid") {
    if (["pending", "waiting", "preCharge"].includes(venda.status)) throw new Error("Aguardando confirmação do pagamento na Nasten.");
    return { resultado: "ignorado: pagamento não aprovado" };
  }
  const pc = ofertaDo(c);
  return db().transacao(async q => {
    // A chave da transação também deduplica entregas de webhooks diferentes.
    const conhecido = (await q.query("select * from nasten_pagamentos where transacao = $1", [id])).rows[0];
    const org = conhecido?.org_id || await organizacaoDa(venda, q);
    const atual = (await q.query("select * from organizacoes where id = $1 for update", [org])).rows[0];
    const anterior = (await q.query("select * from nasten_pagamentos where transacao = $1", [id])).rows[0];
    if (estorno) {
      // Guarda até estorno que chegou antes do aviso de pagamento.
      if (!anterior && pc) {
        const pagoEm = new Date(venda.aprovedAt || venda.createdAt);
        if (!Number.isFinite(+pagoEm)) throw new Error("Venda sem data válida.");
        await q.query("insert into nasten_pagamentos (transacao, org_id, plano, ciclo, status, pago_em, ate, pago_centavos) values ($1,$2,$3,$4,$5,$6,$6,$7) on conflict do nothing", [id, org, pc.plano, pc.ciclo, venda.status, pagoEm, numero(venda.amount) || 0]);
      }
      await q.query("update nasten_pagamentos set status = $2, verificado_em = now() where transacao = $1", [id, venda.status]);
      if (atual.pagamento_provedor === "nasten" && atual.pagamento_id === id) await q.query("update organizacoes set plano_ate = least(plano_ate, now()) where id = $1", [org]);
      return { org, resultado: "estorno registrado" };
    }
    if (anterior) { await q.query("update nasten_pagamentos set verificado_em = now() where transacao = $1", [id]); return { org, resultado: "pagamento já registrado" }; }
    if (!pc) throw new Error("Oferta Nasten sem plano. Confira NASTEN_OFERTAS.");
    const pagoEm = new Date(venda.aprovedAt), pago = numero(venda.amount), liquido = numero(venda.netAmount);
    if (!Number.isFinite(+pagoEm) || +pagoEm > Date.now() + 300000 || !pago) throw new Error("Venda sem valor ou data de aprovação válida.");
    const ate = fimDoCiclo(pagoEm, CICLOS[pc.ciclo]);
    await q.query("insert into nasten_pagamentos (transacao,org_id,plano,ciclo,status,pago_em,ate,pago_centavos,liquido_centavos) values ($1,$2,$3,$4,'paid',$5,$6,$7,$8)", [id,org,pc.plano,pc.ciclo,pagoEm,ate,pago,liquido]);
    // Um aviso antigo não rebaixa nem prolonga o plano adquirido mais recentemente.
    if (!atual.pagamento_em || pagoEm >= new Date(atual.pagamento_em)) await q.query("update organizacoes set plano=$2,ciclo=$3,plano_ate=$4,pagamento_provedor='nasten',pagamento_id=$5,pagamento_em=$6,pago_centavos=$7,liquido_centavos=$8 where id=$1", [org,pc.plano,pc.ciclo,ate,id,pagoEm,pago,liquido]);
    return { org, resultado: `ativado ${pc.plano}:${pc.ciclo}` };
  });
}

export async function receberAvisoNasten(c) {
  if (!c || typeof c !== "object" || c.scope !== "user" || !UUID.test(c.id) || !/^[a-z0-9_-]{3,100}$/i.test(c.transaction?.id || "")) throw new ErroApi("Aviso Nasten inválido.");
  if (c.transaction.sandbox === true && process.env.NASTEN_SANDBOX !== "sim") return { ignorado: "teste" };
  if (!["transaction_created", "transaction_paid", "transaction_refunded", "transaction_updated", "product_canceled"].includes(c.event)) return { ignorado: "evento" };
  // Sem documento, telefone, cartão ou segredo no histórico: só os identificadores usados na liberação.
  const dados = { id: c.id, event: c.event, transaction: { id: c.transaction.id }, product: { id: texto(c.product?.id) }, sale: { mainOfferId: c.sale?.mainOfferId ?? null } };
  await db().query("insert into nasten_eventos (id,evento,transacao,dados) values ($1,$2,$3,$4) on conflict do nothing", [c.id,c.event,c.transaction.id,JSON.stringify(dados)]);
  setImmediate(() => processarEventosNasten().catch(e => console.error("[nasten]", e.message)));
  return { recebido: true };
}

export async function processarEventosNasten() {
  if (processando) return;
  processando = true;
  try {
    await db().query("update nasten_eventos set status='pendente' where status='processando' and atualizado_em < now() - interval '5 minutes'");
    for (let i = 0; i < 20; i++) {
      const t = (await db().query("update nasten_eventos set status='processando',tentativas=tentativas+1,atualizado_em=now() where id=(select id from nasten_eventos where status='pendente' and executar_em<=now() order by recebido_em for update skip locked limit 1) returning *")).rows[0];
      if (!t) break;
      try {
        const r = t.evento === "product_canceled" ? { org: (await db().query("select org_id from nasten_pagamentos where transacao=$1",[t.transacao])).rows[0]?.org_id, resultado: "cancelado: acesso mantido até o fim do período pago" } : await aplicar(t.dados, (await consultarNasten("/v1/transactions/" + encodeURIComponent(t.transacao))).data);
        await db().query("update nasten_eventos set status='feito',org_id=$2,resultado=$3,atualizado_em=now() where id=$1", [t.id,r.org || null,r.resultado]);
      } catch (e) {
        await db().query("update nasten_eventos set status='pendente',resultado=$2,executar_em=now()+($3||' seconds')::interval,atualizado_em=now() where id=$1", [t.id,String(e.message).slice(0,500),String(Math.min(3600,30 * 2 ** Math.min(t.tentativas,7)))]);
      }
    }
  } finally { processando = false; }
}

// A API não informa a oferta na consulta de uma venda. Na conciliação sem webhook,
// Só reconhece os totais exatos dos planos, incluindo as cobranças anteriores à troca de ofertas.
function ofertaDaVenda(v) {
  const candidatos = Object.entries(OFERTAS_NASTEN).filter(([chave]) => {
    const [plano,ciclo] = chave.split(":"), p = PLANOS[plano];
    const valores = [totalDo(p,ciclo), OFERTAS_NASTEN_ANTIGAS[chave]?.total].filter(Number.isFinite).map(v => Math.round(v*100));
    return (v.TransactionItems || []).some(i => normal(i.name).includes("content post") && normal(i.name).includes(plano) && Number(i.quantity) === 1 && valores.includes(Number(i.amount)));
  });
  return candidatos.length === 1 ? candidatos[0][1] : null;
}

export async function reconciliarNasten() {
  if (!configurada() || conciliando) return;
  conciliando = true;
  try {
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    // Recupera avisos perdidos, inclusive compras antes do cadastro na plataforma.
    for (let offset=0; offset<500; offset+=10) {
      const { data } = await consultarNasten(`/v1/transactions?status=paid&initialDate=${encodeURIComponent(desde)}&offset=${offset}`);
      if (!Array.isArray(data)) throw new Error("Lista Nasten inválida.");
      for (const venda of data) {
        if (venda.saleType !== "producer" || venda.companyId !== empresa()) continue;
        const oferta = ofertaDaVenda(venda); if (!oferta) continue;
        try { await aplicar({ transaction: { id:venda.id },product:{id:oferta.produto},sale:{mainOfferId:oferta.id} },venda); }
        catch (e) { console.error("[nasten conciliação]", venda.id, e.message); }
      }
      if (data.length < 10) break;
    }
    // Também confere pagamentos antigos ainda ativos, para pegar estornos de ciclos anuais.
    const ativos = (await db().query("select * from nasten_pagamentos where status='paid' order by verificado_em limit 20")).rows;
    for (const p of ativos) {
      const oferta = OFERTAS_NASTEN[p.plano+":"+p.ciclo];
      const venda = (await consultarNasten("/v1/transactions/"+encodeURIComponent(p.transacao))).data;
      await aplicar({transaction:{id:p.transacao},product:{id:oferta?.produto},sale:{mainOfferId:oferta?.id}},venda);
    }
  } finally { conciliando = false; }
}
