// Planos e limites de uso. Novas compras pela Nasten; callbacks Kiwify preservados para assinaturas anteriores.
// Os preços precisam ser iguais aos dos produtos criados na Nasten (o cálculo está em PRECOS.md).
// Valores finais por mês. O semestral e o anual são cobrados pelo total do ciclo, sem cupom.
import crypto from "node:crypto";
import { db } from "./db.js";
import { ErroApi } from "./erros.js";
import { CHECKOUT_NASTEN } from "./ofertas.js";

const env = process.env;

export const PLANOS = {
  teste: { nome: "Teste grátis", posts: 3, ideias: 2, modelos: 1, precos: null },
  essencial: { nome: "Essencial", posts: 12, ideias: 8, modelos: 3, precos: { mensal: 177.12, semestral: 169.5, anual: 165.78 } },
  profissional: { nome: "Profissional", posts: 30, ideias: 20, modelos: 8, precos: { mensal: 420.96, semestral: 411.57, anual: 400.95 } },
  agencia: { nome: "Agência", posts: 80, ideias: 50, modelos: 20, precos: { mensal: 1107.36, semestral: 1079.67, anual: 1055.45 } },
};
export const CICLOS = { mensal: 1, semestral: 6, anual: 12 };
const centavos = v => Math.round(v * 100) / 100;
export const totalDo = (p, c) => centavos(p.precos[c] * CICLOS[c]);

// Cobrança ligada só quando COBRANCA=sim (até lá ninguém é bloqueado por limite).
export const cobrancaLigada = () => env.COBRANCA === "sim";
const lerJson = nome => { try { return JSON.parse(env[nome] || "{}"); } catch (e) { return {}; } };
export const isentos = () => (env.EMAILS_ISENTOS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// KIWIFY_CHECKOUT não é usado nos novos checkouts, mesmo que ainda esteja configurado no Railway.
const semCupom = u => { if (!u) return null; try { const x = new URL(u); x.searchParams.delete("coupon"); return x.toString(); } catch (e) { return null; } };
export function catalogo() {
  // A migração foi liberada: variáveis antigas não podem redirecionar novas compras para a Kiwify.
  const links = { ...CHECKOUT_NASTEN, ...lerJson("NASTEN_CHECKOUT") };
  return {
    planos: Object.entries(PLANOS).filter(([, p]) => p.precos).map(([id, p]) => ({
      id, nome: p.nome, posts: p.posts, ideias: p.ideias, modelos: p.modelos,
      ciclos: Object.entries(p.precos).map(([ciclo, porMes]) => {
        // Mantém os campos antigos para painéis já abertos, sem anúncio ou aplicação de desconto.
        return { ciclo, meses: CICLOS[ciclo], porMes, dePorMes: porMes, desconto: 0, cupom: null, total: totalDo(p, ciclo), checkout: semCupom(links[`${id}:${ciclo}`]) };
      }),
    })),
    provedor: "nasten",
    afiliados: env.NASTEN_AFILIADOS || "https://easycontentpost.com.br/afiliados",
    teste: { posts: PLANOS.teste.posts, dias: 7 },
  };
}

// Início do mês no horário de Brasília (UTC−3, sem horário de verão): o limite vira à meia-noite daqui, não do servidor.
export const inicioDoMes = (agora = new Date()) => { const br = new Date(agora.getTime() - 3 * 3600000); return new Date(Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), 1, 3)); };

export async function situacao(org, q = db()) {
  const o = (await q.query(
    `select o.plano, o.ciclo, o.plano_ate, exists (select 1 from membros m join usuarios u on u.id = m.usuario_id
       where m.org_id = o.id and m.papel = 'dono' and lower(u.email) = any($2::text[])) as isenta
     from organizacoes o where o.id = $1`, [org, isentos()])).rows[0];
  if (!o) throw new ErroApi("Organização não encontrada.", 404);
  const plano = PLANOS[o.plano] || PLANOS.teste;
  const desde = o.plano === "teste" ? new Date(0) : inicioDoMes();
  const usos = (await q.query("select tipo, count(*)::int as n from uso where org_id = $1 and criado_em >= $2 group by tipo", [org, desde])).rows;
  const n = t => (usos.find(u => u.tipo === t) || { n: 0 }).n;
  return {
    plano: o.plano, nome: plano.nome, ciclo: o.ciclo, ate: o.plano_ate,
    ativo: o.isenta || new Date(o.plano_ate) > new Date(), isenta: o.isenta, cobranca: cobrancaLigada(),
    posts: { usados: n("post"), limite: plano.posts }, ideias: { usadas: n("ideias"), limite: plano.ideias },
    periodo: o.plano === "teste" ? "teste" : "mes",
  };
}

// Confere o limite antes de gastar IA e registra o uso.
export async function usar(org, tipo, transacao = null) {
  // Conta e registra numa transação com a organização travada: pedidos em paralelo não passam do limite.
  const contar = async tx => {
  await tx.query("select id from organizacoes where id = $1 for update", [org]);
  if (cobrancaLigada()) {
    const s = await situacao(org, tx);
    if (!s.isenta) {
      if (!s.ativo) throw new ErroApi(s.plano === "teste" ? "Seu teste grátis terminou. Escolha um plano para continuar criando." : "Seu plano venceu. Renove para continuar criando.", 402, { plano: true });
      const lim = tipo === "post" ? s.posts : { usados: s.ideias.usadas, limite: s.ideias.limite };
      if (lim.usados >= lim.limite) throw new ErroApi(
        tipo === "post" ? `Você já usou os ${lim.limite} posts ${s.periodo === "teste" ? "do teste" : "do plano neste mês"}. Mude de plano para criar mais.`
          : `Você já usou as ${lim.limite} buscas de ideias ${s.periodo === "teste" ? "do teste" : "do plano neste mês"}.`, 402, { plano: true });
    }
  }
  await tx.query("insert into uso (org_id, tipo) values ($1, $2)", [org, tipo]);
  };
  return transacao ? contar(transacao) : db().transacao(contar);
}
// Quantos modelos da marca (do perfil e montados à mão) a organização pode guardar. Sem cobrança ligada ou isenta, o teto é alto.
export async function limiteModelos(org) {
  const s = await situacao(org);
  const maximo = !cobrancaLigada() || s.isenta ? 30 : (PLANOS[s.plano] || PLANOS.teste).modelos;
  return { maximo, plano: s.nome };
}
// Devolve o uso se a tarefa nem chegou a começar (ex.: erro ao enfileirar).
export async function devolver(org, tipo) {
  await db().query("delete from uso where id = (select id from uso where org_id = $1 and tipo = $2 order by criado_em desc limit 1)", [org, tipo]);
}

/* ---------- Kiwify ---------- */

// A Kiwify assina cada aviso: ?signature= é o HMAC-SHA1 (hex) do corpo, com o token do webhook.
export function assinaturaKiwifyOk(corpoBruto, assinatura) {
  const token = env.KIWIFY_TOKEN;
  if (!token || !assinatura) return false;
  const esperado = crypto.createHmac("sha1", token).update(corpoBruto || "").digest("hex");
  const a = Buffer.from(String(assinatura)), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Produto da Kiwify → plano e ciclo. KIWIFY_PRODUTOS = {"<id do produto>": "profissional:anual"}; sem isso, pelo nome.
function planoDoProduto(produto, assinatura) {
  const mapa = lerJson("KIWIFY_PRODUTOS");
  const porId = mapa[produto.product_id] || mapa[(assinatura.plan || {}).id];
  if (porId) { const [p, c] = String(porId).split(":"); if (PLANOS[p] && CICLOS[c]) return { plano: p, ciclo: c }; }
  const nome = ((produto.product_name || "") + " " + ((assinatura.plan || {}).name || "")).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const plano = ["agencia", "profissional", "essencial"].find(p => nome.includes(p));
  const freq = String((assinatura.plan || {}).frequency || "").toLowerCase();
  const ciclo = /anual|annual|yearly/.test(nome + freq) ? "anual" : /semestr|semiannual|biannual/.test(nome + freq) ? "semestral" : "mensal";
  return plano ? { plano, ciclo } : null;
}

async function orgDoPedido(c) {
  const sck = String(((c.TrackingParameters || {}).sck) || "");
  if (/^[0-9a-f-]{36}$/i.test(sck)) {
    const r = (await db().query("select id from organizacoes where id = $1", [sck])).rows[0];
    if (r) return r.id;
  }
  const email = String(((c.Customer || {}).email) || "").trim().toLowerCase();
  if (!email) return null;
  const r = (await db().query(
    "select m.org_id from membros m join usuarios u on u.id = m.usuario_id where lower(u.email) = $1 and m.papel = 'dono' order by m.org_id limit 1", [email])).rows[0];
  return r ? r.org_id : null;
}

// Valor da Kiwify em centavos ("8990" ou 8990); se vier com ponto ou vírgula, está em reais.
const emCentavos = v => {
  if (v === null || v === undefined || v === "") return null;
  const t = String(v).trim(), n = Number(t.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return /[.,]/.test(t) ? Math.round(n * 100) : Math.round(n);
};
// O que a cobrança rendeu de verdade (com cupom): pago pelo cliente e líquido depois das taxas da Kiwify.
const valoresDa = c => { const m = c.Commissions || {}; return { pago: emCentavos(m.charge_amount ?? m.product_base_price), liquido: emCentavos(m.my_commission ?? m.settlement_amount) }; };
async function guardarValores(org, c) {
  const v = valoresDa(c);
  if (org && (v.pago || v.liquido)) await db().query("update organizacoes set pago_centavos = coalesce($2, pago_centavos), liquido_centavos = coalesce($3, liquido_centavos) where id = $1 and pagamento_provedor is distinct from 'nasten'", [org, v.pago, v.liquido]);
}
export async function avisoKiwify(c) {
  const evento = String(c.webhook_event_type || c.order_status || "").toLowerCase();
  const pedido = String(c.order_id || c.order_ref || "");
  const sub = c.Subscription || {};
  const pago = ["order_approved", "subscription_renewed", "paid", "approved"].includes(evento);
  const chave = `${pedido}|${evento}|${sub.charges ? JSON.stringify(sub.charges).length : ""}|${c.approved_date || c.updated_at || ""}`;
  const org = await orgDoPedido(c);
  // Inclui o reenvio de valores de uma cobrança antiga: não sobrescreve a receita da Nasten.
  if (org && (await db().query("select pagamento_provedor from organizacoes where id = $1", [org])).rows[0]?.pagamento_provedor === "nasten") return { resultado: "ignorado: organização migrada para Nasten" };
  const ja = (await db().query("select 1 from kiwify_eventos where chave = $1", [chave])).rows[0];
  // Aviso repetido não mexe no plano, mas ainda grava o valor pago (reenviar o aviso na Kiwify corrige uma venda antiga).
  if (ja) { if (pago) await guardarValores(await orgDoPedido(c), c); return { repetido: true }; }
  let resultado = "ignorado";
  if (org) {
    const estorno = ["order_refunded", "chargeback", "refunded", "chargedback"].includes(evento);
    const cancelado = ["subscription_canceled", "canceled"].includes(evento);
    if (pago) {
      const pc = planoDoProduto(c.Product || {}, sub);
      if (pc) {
        // Pago até a próxima cobrança (ou o ciclo inteiro), com 3 dias de folga para o cartão passar.
        const prox = Date.parse(sub.next_payment || "");
        const ate = prox && prox > Date.now() ? new Date(prox) : new Date(Date.now() + CICLOS[pc.ciclo] * 30.5 * 86400000);
        ate.setDate(ate.getDate() + 3);
        await db().query("update organizacoes set plano = $2, ciclo = $3, plano_ate = $4, kiwify_assinatura = coalesce($5, kiwify_assinatura), pagamento_provedor = 'kiwify', pagamento_id = $6 where id = $1 and pagamento_provedor is distinct from 'nasten'",
          [org, pc.plano, pc.ciclo, ate, sub.id || null, pedido || null]);
        await guardarValores(org, c);
        resultado = `ativado ${pc.plano}:${pc.ciclo} até ${ate.toISOString().slice(0, 10)}`;
      } else resultado = "produto sem plano";
    } else if (estorno) {
      await db().query("update organizacoes set plano_ate = now() where id = $1 and pagamento_provedor is distinct from 'nasten'", [org]);
      resultado = "encerrado (estorno)";
    } else if (cancelado) resultado = "cancelado: segue até o fim do período pago";
  } else resultado = "organização não encontrada";
  await db().query("insert into kiwify_eventos (chave, evento, org_id, resultado) values ($1, $2, $3, $4) on conflict (chave) do nothing", [chave, evento || "?", org, resultado]);
  return { resultado };
}
