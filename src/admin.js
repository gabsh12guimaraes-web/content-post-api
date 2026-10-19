// Painel admin da plataforma: usuários, assinaturas, receita e tudo que gera gasto (Claude, Magnific, Apify, Zernio, Railway).
// Só os e-mails de ADMIN_EMAILS entram; a checagem é aqui na API, não só no painel.
import { db } from "./db.js";
import { PLANOS, CICLOS, totalDo, isentos, inicioDoMes } from "./planos.js";
import { CUSTO, KIWIFY, DOLAR, custoDe } from "./custos.js";
import { ErroApi } from "./erros.js";

const admins = () => (process.env.ADMIN_EMAILS || "gabsh12guimaraes@gmail.com").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
export const ehAdmin = email => admins().includes(String(email || "").toLowerCase());

const PROVEDORES = ["anthropic", "magnific", "apify", "zernio"];
const dia = d => new Date(d).toISOString().slice(0, 10);
const r2 = v => Math.round(v * 100) / 100;

export async function painelAdmin(ctx) {
  if (!ctx || !ctx.usuario || !ehAdmin(ctx.usuario.email)) throw new ErroApi("Acesso restrito ao administrador da plataforma.", 403);
  const agora = new Date(), inicioMes = inicioDoMes(agora);
  const d30 = new Date(agora.getTime() - 30 * 86400000), d7 = new Date(agora.getTime() - 7 * 86400000);
  const q = async (sql, p = []) => (await db().query(sql, p)).rows;

  // ---------- usuários e organizações
  const [u] = await q(`select count(*)::int as total, count(*) filter (where criado_em >= $1)::int as novos7, count(*) filter (where criado_em >= $2)::int as novos30,
      count(*) filter (where ultimo_acesso >= $1)::int as ativos7, count(*) filter (where ultimo_acesso >= $2)::int as ativos30 from usuarios`, [d7, d30]);
  const novosPorDia = await q("select to_char(criado_em at time zone 'UTC', 'YYYY-MM-DD') as dia, count(*)::int as n from usuarios where criado_em >= $1 group by 1", [d30]);
  const orgs = await q(`select o.id, o.nome, o.plano, o.ciclo, o.plano_ate, o.criado_em, o.pago_centavos, o.liquido_centavos,
      exists (select 1 from membros m join usuarios us on us.id = m.usuario_id where m.org_id = o.id and m.papel = 'dono' and lower(us.email) = any($1::text[])) as isenta
    from organizacoes o`, [isentos()]);
  const situacao = o => (o.isenta ? "isenta" : o.plano !== "teste" ? (new Date(o.plano_ate) > agora ? "assinante" : "vencida") : (new Date(o.plano_ate) > agora ? "teste" : "teste_vencido"));
  const porSituacao = { assinante: 0, teste: 0, teste_vencido: 0, vencida: 0, isenta: 0 };
  const porPlano = {};
  let mrr = 0, taxasMes = 0;
  const receitaOrg = new Map();
  for (const o of orgs) {
    const s = situacao(o); porSituacao[s]++;
    if (s === "assinante") {
      const p = PLANOS[o.plano], meses = CICLOS[o.ciclo] || 1;
      // Valor real da última cobrança (com cupom e taxas, como a Kiwify mostra); sem ele, o preço de tabela.
      const tabela = p && p.de && CICLOS[o.ciclo] ? totalDo(p, o.ciclo) : 0;
      const total = o.pago_centavos ? o.pago_centavos / 100 : tabela;
      const liquido = o.liquido_centavos ? o.liquido_centavos / 100 : total ? total - (total * KIWIFY.taxa + KIWIFY.fixa) : 0;
      mrr += total / meses; taxasMes += (total - liquido) / meses;
      receitaOrg.set(o.id, liquido / meses);
      const k = `${p ? p.nome : o.plano} ${o.ciclo || ""}`.trim(); porPlano[k] = (porPlano[k] || 0) + 1;
    }
  }

  // ---------- consumo (só o da chave da plataforma é gasto nosso)
  const somas = await q(`select provedor, tipo, chave_propria, estimado,
      to_char(criado_em at time zone 'UTC', 'YYYY-MM-DD') as dia, org_id,
      sum(entrada)::float as entrada, sum(saida)::float as saida, sum(cache_leitura)::float as cache_leitura, sum(cache_escrita)::float as cache_escrita,
      sum(quantidade)::float as quantidade, count(*)::int as chamadas
    from consumo group by 1, 2, 3, 4, 5, 6`);
  const vazio = () => ({ chamadas: 0, entrada: 0, saida: 0, cache: 0, quantidade: 0, usd: 0, usdEstimado: 0 });
  const periodos = { mes: {}, d30: {}, total: {} };
  for (const k of Object.keys(periodos)) for (const p of PROVEDORES) periodos[k][p] = { plataforma: vazio(), propria: vazio() };
  const porTipo = {}, porOrg = new Map(), serie = {};
  for (let k = 29; k >= 0; k--) { const d = dia(agora.getTime() - k * 86400000); serie[d] = Object.fromEntries(PROVEDORES.map(p => [p, 0])); }
  for (const s of somas) {
    if (!PROVEDORES.includes(s.provedor)) continue;
    const usd = custoDe(s.provedor, s.tipo, s), quando = new Date(s.dia + "T12:00:00Z");
    const alvos = ["total"]; if (quando >= d30) alvos.push("d30"); if (s.dia >= dia(inicioMes)) alvos.push("mes");
    for (const k of alvos) {
      const a = periodos[k][s.provedor][s.chave_propria ? "propria" : "plataforma"];
      a.chamadas += s.chamadas; a.entrada += s.entrada; a.saida += s.saida; a.cache += s.cache_leitura + s.cache_escrita; a.quantidade += s.quantidade;
      a.usd += usd; if (s.estimado) a.usdEstimado += usd;
    }
    if (quando >= d30) {
      const t = `${s.provedor}:${s.tipo || "outro"}`;
      porTipo[t] = porTipo[t] || { provedor: s.provedor, tipo: s.tipo || "outro", chamadas: 0, entrada: 0, saida: 0, quantidade: 0, usd: 0 };
      Object.assign(porTipo[t], { chamadas: porTipo[t].chamadas + s.chamadas, entrada: porTipo[t].entrada + s.entrada, saida: porTipo[t].saida + s.saida, quantidade: porTipo[t].quantidade + s.quantidade, usd: porTipo[t].usd + usd });
      if (!s.chave_propria) {
        if (serie[s.dia]) serie[s.dia][s.provedor] += usd;
        porOrg.set(s.org_id, (porOrg.get(s.org_id) || 0) + usd);
      }
    }
  }
  const arred = o => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "number" ? r2(v) : v)));
  // Railway: custo fixo estimado por organização com plano ativo (ou teste ativo) no mês.
  const orgsAtivas = orgs.filter(o => ["assinante", "teste", "isenta"].includes(situacao(o))).length;
  const railwayUsdMes = orgsAtivas * CUSTO.railwayOrgMesBrl / DOLAR;
  const custoMesUsd = PROVEDORES.reduce((s, p) => s + periodos.mes[p].plataforma.usd, 0) + railwayUsdMes;

  const [uso] = await q(`select count(*) filter (where tipo = 'post' and criado_em >= $1)::int as posts30, count(*) filter (where tipo = 'ideias' and criado_em >= $1)::int as ideias30,
      count(*) filter (where tipo = 'post')::int as posts, count(*) filter (where tipo = 'ideias')::int as ideias from uso`, [d30]);
  const [pub] = await q("select count(*) filter (where status = 'Publicado')::int as publicados, count(*) filter (where status = 'Publicado' and atualizado_em >= $1)::int as publicados30 from posts", [d30]);
  const nomes = new Map(orgs.map(o => [o.id, o]));
  const topOrgs = [...new Set([...porOrg.keys(), ...receitaOrg.keys()])].map(id => {
    const o = nomes.get(id) || {}, usd = porOrg.get(id) || 0, receita = receitaOrg.get(id) || 0;
    return { nome: o.nome || "(removida)", situacao: o.id ? situacao(o) : "", plano: o.plano ? (PLANOS[o.plano] || {}).nome || o.plano : "", ciclo: o.ciclo || "", custoUsd30: usd, receitaMesBrl: receita, margemBrl: receita - usd * DOLAR };
  }).sort((a, b) => b.custoUsd30 - a.custoUsd30).slice(0, 25);

  return {
    precos: CUSTO, ...arred({
    geradoEm: agora.toISOString(), dolar: DOLAR,
    usuarios: { ...u, organizacoes: orgs.length, porSituacao, porPlano, novosPorDia: Object.keys(serie).map(d => ({ dia: d, n: (novosPorDia.find(x => x.dia === d) || { n: 0 }).n })) },
    receita: { mrrBrl: mrr, taxasKiwifyMesBrl: taxasMes, liquidaMesBrl: mrr - taxasMes },
    custos: { periodos, railwayUsdMes, orgsAtivas, custoMesUsd, custoMesBrl: custoMesUsd * DOLAR, margemMesBrl: mrr - taxasMes - custoMesUsd * DOLAR },
    serie: Object.entries(serie).map(([d, v]) => ({ dia: d, ...v })),
    porTipo: Object.values(porTipo).sort((a, b) => b.usd - a.usd),
    topOrgs, uso: { ...uso, ...pub },
  }) };
}
