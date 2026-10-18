// Relatório de controle (planilha do Google): uma linha por pessoa em cada organização, com plano, uso e consumo de IA.
// A planilha puxa com =IMPORTDATA("https://.../relatorio.csv?chave=...&formato=br"); sem RELATORIO_CHAVE, a rota não existe.
// formato=br: decimais com vírgula, para a planilha em português ler os valores como número.
import crypto from "node:crypto";
import { db } from "./db.js";
import { PLANOS, totalDo, CICLOS, isentos } from "./planos.js";

// Preço por milhão de tokens e por item, em US$, para estimar o custo (mesmos valores do PRECOS.md).
const CUSTO = { entrada: 4, saida: 20, cacheLeitura: 0.4, cacheEscrita: 5, foto: 0.07, fotoPessoa: 0.07, clipeSegundo: 0.1 };

export const COLUNAS = [
  ["nome", "Nome"], ["email", "E-mail"], ["cadastrado_em", "Cadastro"], ["ultimo_acesso", "Último acesso"],
  ["organizacao", "Organização"], ["papel", "Papel"], ["pessoas_na_org", "Pessoas na organização"], ["org_criada_em", "Organização criada em"],
  ["situacao", "Situação"], ["assinante", "Assinou"], ["plano", "Plano"], ["ciclo", "Ciclo"], ["pago_ate", "Pago até"],
  ["valor_ciclo", "Valor do ciclo (R$)"], ["valor_mensal", "Valor por mês (R$)"], ["ultimo_evento_kiwify", "Último aviso da Kiwify"],
  ["posts_total", "Posts criados (total)"], ["posts_mes", "Posts criados no mês"], ["limite_posts", "Limite de posts/mês"],
  ["buscas_ideias_total", "Buscas de ideias (total)"], ["buscas_ideias_mes", "Buscas de ideias no mês"],
  ["ideias", "Ideias geradas"], ["posts_publicados", "Posts publicados"], ["posts_agendados", "Posts na fila"],
  ["chamadas_claude", "Chamadas ao Claude"], ["tokens_entrada", "Tokens de entrada"], ["tokens_saida", "Tokens de saída"], ["tokens_cache", "Tokens em cache"],
  ["fotos_ia", "Fotos geradas"], ["fotos_com_pessoa", "Fotos com pessoa real"], ["segundos_video", "Segundos de vídeo gerados"],
  ["custo_ia_usd", "Custo de IA estimado (US$)"], ["custo_ia_mes_usd", "Custo de IA no mês (US$)"], ["chave_propria", "Usa chave própria"],
  ["fotos_no_banco", "Fotos no banco"], ["pessoas_cadastradas", "Pessoas cadastradas"],
];

const dataIso = d => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "");
const dinheiro = v => (Math.round(v * 100) / 100).toFixed(2);
const custo = c => (Number(c.entrada) * CUSTO.entrada + Number(c.saida) * CUSTO.saida + Number(c.cache_leitura) * CUSTO.cacheLeitura + Number(c.cache_escrita) * CUSTO.cacheEscrita) / 1e6
  + Number(c.fotos) * CUSTO.foto + Number(c.fotos_pessoa) * CUSTO.fotoPessoa + Number(c.segundos) * CUSTO.clipeSegundo;

export async function linhasRelatorio() {
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
  const pessoas = (await db().query(`
    select u.nome, u.email, u.criado_em, u.ultimo_acesso, m.papel, o.id as org, o.nome as organizacao, o.criado_em as org_criada_em, o.plano, o.ciclo, o.plano_ate
    from usuarios u left join membros m on m.usuario_id = u.id left join organizacoes o on o.id = m.org_id
    order by u.criado_em desc, o.criado_em`)).rows;
  const porOrg = async (sql, params = []) => new Map((await db().query(sql, params)).rows.map(r => [r.org_id, r]));
  const uso = await porOrg(`select org_id,
      count(*) filter (where tipo = 'post') as posts, count(*) filter (where tipo = 'post' and criado_em >= $1) as posts_mes,
      count(*) filter (where tipo = 'ideias') as ideias, count(*) filter (where tipo = 'ideias' and criado_em >= $1) as ideias_mes
    from uso group by org_id`, [inicioMes]);
  const somaConsumo = cond => `select org_id,
      count(*) filter (where provedor = 'anthropic') as chamadas,
      coalesce(sum(entrada), 0) as entrada, coalesce(sum(saida), 0) as saida, coalesce(sum(cache_leitura), 0) as cache_leitura, coalesce(sum(cache_escrita), 0) as cache_escrita,
      coalesce(sum(quantidade) filter (where provedor = 'magnific' and tipo = 'foto'), 0) as fotos,
      coalesce(sum(quantidade) filter (where provedor = 'magnific' and tipo = 'foto_pessoa'), 0) as fotos_pessoa,
      coalesce(sum(quantidade) filter (where provedor = 'magnific' and tipo = 'clipe'), 0) as segundos,
      bool_or(chave_propria) as propria
    from consumo ${cond} group by org_id`;
  const consumo = await porOrg(somaConsumo(""));
  const consumoMes = await porOrg(somaConsumo("where criado_em >= $1"), [inicioMes]);
  const posts = await porOrg(`select org_id, count(*) filter (where status = 'Publicado') as publicados, count(*) filter (where status in ('Aprovado', 'Agendado', 'Publicando')) as fila from posts group by org_id`);
  const ideias = await porOrg("select org_id, count(*) as n from ideias group by org_id");
  const membros = await porOrg("select org_id, count(*) as n from membros group by org_id");
  const banco = await porOrg("select org_id, count(*) as n from banco_imagens where origem = 'envio' group by org_id");
  const rostos = await porOrg("select org_id, count(*) as n from pessoas group by org_id");
  const kiwify = await porOrg("select distinct on (org_id) org_id, evento, recebido_em from kiwify_eventos where org_id is not null order by org_id, recebido_em desc");
  const donosIsentos = new Set((await db().query(
    "select m.org_id from membros m join usuarios u on u.id = m.usuario_id where m.papel = 'dono' and lower(u.email) = any($1::text[])", [isentos()])).rows.map(r => r.org_id));
  const zero = { posts: 0, posts_mes: 0, ideias: 0, ideias_mes: 0, chamadas: 0, entrada: 0, saida: 0, cache_leitura: 0, cache_escrita: 0, fotos: 0, fotos_pessoa: 0, segundos: 0, propria: false, publicados: 0, fila: 0, n: 0 };
  const de = (mapa, org) => ({ ...zero, ...(mapa.get(org) || {}) });

  return pessoas.map(p => {
    const temOrg = !!p.org, plano = PLANOS[p.plano] || PLANOS.teste, pago = temOrg && p.plano !== "teste";
    const ativo = temOrg && new Date(p.plano_ate) > new Date();
    const isenta = temOrg && donosIsentos.has(p.org);
    const situacao = !temOrg ? "sem organização" : isenta ? "isenta" : pago ? (ativo ? "assinante ativo" : "assinatura vencida") : (ativo ? "teste grátis" : "teste vencido");
    const u = de(uso, p.org), c = de(consumo, p.org), cm = de(consumoMes, p.org), po = de(posts, p.org), k = kiwify.get(p.org);
    const valorCiclo = pago && plano.de && CICLOS[p.ciclo] ? totalDo(plano, p.ciclo) : 0;
    return {
      nome: p.nome, email: p.email, cadastrado_em: dataIso(p.criado_em), ultimo_acesso: dataIso(p.ultimo_acesso),
      organizacao: p.organizacao || "", papel: p.papel || "", pessoas_na_org: temOrg ? de(membros, p.org).n : "", org_criada_em: dataIso(p.org_criada_em),
      situacao, assinante: pago ? "sim" : "não", plano: temOrg ? plano.nome : "", ciclo: p.ciclo || "", pago_ate: temOrg ? dataIso(p.plano_ate) : "",
      valor_ciclo: valorCiclo ? dinheiro(valorCiclo) : "", valor_mensal: valorCiclo ? dinheiro(valorCiclo / CICLOS[p.ciclo]) : "",
      ultimo_evento_kiwify: k ? `${k.evento} em ${dataIso(k.recebido_em)}` : "",
      posts_total: u.posts, posts_mes: u.posts_mes, limite_posts: temOrg ? plano.posts : "", buscas_ideias_total: u.ideias, buscas_ideias_mes: u.ideias_mes,
      ideias: de(ideias, p.org).n, posts_publicados: po.publicados, posts_agendados: po.fila,
      chamadas_claude: c.chamadas, tokens_entrada: c.entrada, tokens_saida: c.saida, tokens_cache: Number(c.cache_leitura) + Number(c.cache_escrita),
      fotos_ia: c.fotos, fotos_com_pessoa: c.fotos_pessoa, segundos_video: c.segundos,
      custo_ia_usd: dinheiro(custo(c)), custo_ia_mes_usd: dinheiro(custo(cm)), chave_propria: c.propria ? "sim" : "não",
      fotos_no_banco: de(banco, p.org).n, pessoas_cadastradas: de(rostos, p.org).n,
    };
  });
}

// CSV para o IMPORTDATA. Textos que começam com = + - @ ganham um apóstrofo para a planilha não rodar como fórmula.
const celula = v => {
  let t = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export async function relatorioCsv({ br = false } = {}) {
  const linhas = await linhasRelatorio();
  const valor = v => (br && typeof v === "string" && /^\d+\.\d+$/.test(v) ? v.replace(".", ",") : v);
  return [COLUNAS.map(c => c[1]), ...linhas.map(l => COLUNAS.map(c => valor(l[c[0]])))].map(l => l.map(celula).join(",")).join("\n") + "\n";
}

export function chaveRelatorioOk(chave) {
  const certa = process.env.RELATORIO_CHAVE || "";
  if (certa.length < 24 || typeof chave !== "string") return false;
  const a = Buffer.from(chave), b = Buffer.from(certa);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
