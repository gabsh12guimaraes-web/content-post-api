// Acervo licenciado: somente após declarar uma conta Premium/Premium+/Pro, sem geração de IA.
import { createHash } from "node:crypto";
import { db } from "./db.js";
import { chaveDe, registrarConsumo } from "./provedores/index.js";
import { salvarArquivo, apagarArquivos } from "./arquivos.js";
import { falha } from "./erros.js";
import { ehAdmin } from "./admin.js";
import sharp from "sharp";

const PLANOS = new Set(["premium", "premium_plus", "pro"]);
const API = "https://api.magnific.com";
async function conta(org) {
  const chave = await chaveDe(org, "magnific");
  const hash = createHash("sha256").update(chave).digest("hex");
  const propria = (await db().query("select 1 from integracoes where org_id=$1 and provedor='magnific'", [org])).rows.length > 0;
  const plano = (await db().query("select plano from magnific_acervo where chave_hash=$1", [hash])).rows[0]?.plano || "";
  return { chave, hash, propria, plano };
}
export async function situacaoAcervoMagnific(ctx) {
  try {
    const c = await conta(ctx.org);
    return { disponivel: true, ativo: PLANOS.has(c.plano), plano: c.plano, propria: c.propria, podeGerir: ["dono", "admin"].includes(ctx.papel) && (c.propria || ehAdmin(ctx.usuario.email)) };
  } catch { return { disponivel: false, ativo: false, plano: "", podeGerir: false }; }
}
export const acoesAcervoMagnific = {
  async salvarAcervoMagnific(ctx, b) {
    if (b.organizacao && b.organizacao !== ctx.org) falha("A organização mudou. Abra Integrações novamente antes de salvar.", 409);
    const c = await conta(ctx.org);
    if (!["dono", "admin"].includes(ctx.papel) || (!c.propria && !ehAdmin(ctx.usuario.email))) falha("Só quem administra esta conta Magnific pode configurar o acervo.", 403);
    const plano = b.plano || "";
    if (plano && !PLANOS.has(plano)) falha("O acervo sem créditos está disponível apenas em Premium, Premium+ e Pro.");
    await db().query(`insert into magnific_acervo(chave_hash,plano,atualizado_por) values ($1,$2,$3)
      on conflict(chave_hash) do update set plano=excluded.plano,atualizado_por=excluded.atualizado_por,atualizado_em=now()`, [c.hash, plano || null, ctx.usuario.id]);
    return { acervoMagnific: await situacaoAcervoMagnific(ctx) };
  },
};
const urlDoProvedor = valor => {
  try { const u = new URL(valor); return u.protocol === "https:" && !u.username && !u.password && ["freepik.com", "magnific.com", "cdnpk.net"].some(h => u.hostname === h || u.hostname.endsWith("." + h)) ? u.href : null; }
  catch { return null; }
};
export async function criarBuscaAcervo(org) {
  let c;
  try { c = await conta(org); } catch { return null; }
  if (!PLANOS.has(c.plano)) return null;
  let interrompido = false;
  const usados = new Set();
  const pedir = async caminho => {
    if (interrompido) return null;
    let r;
    try { r = await fetch(API + caminho, { headers: { "x-magnific-api-key": c.chave, "Accept-Language": "pt-BR" }, signal: AbortSignal.timeout(30000) }); }
    catch { interrompido = true; return null; }
    if ([401, 402, 403, 429].includes(r.status) || r.status >= 500) { interrompido = true; return null; }
    if (!r.ok) return null;
    return r.json();
  };
  return async ({ texto, vertical = false, post }) => {
    if (interrompido || !String(texto || "").trim()) return null;
    const q = new URLSearchParams({ term: String(texto).trim().slice(0, 240), limit: "5", order: "relevance", "filters[content_type][photo]": "1" });
    if (vertical) q.set("filters[orientation][portrait]", "1");
    const lista = await pedir("/v1/resources?" + q);
    const recurso = (Array.isArray(lista?.data) ? lista.data : []).find(r => /^\d+$/.test(String(r.id)) && r.image?.type === "photo" && !usados.has(String(r.id)));
    if (!recurso) return null;
    const id = String(recurso.id); usados.add(id);
    const existente = (await db().query("select arquivo_id from banco_imagens where org_id=$1 and origem='acervo' and fonte->>'id'=$2", [org, id])).rows[0];
    if (existente) return existente.arquivo_id;
    const download = await pedir(`/v1/resources/${id}/download?image_size=large`);
    const url = urlDoProvedor(download?.data?.url);
    if (!url || !/\.(jpe?g|png|webp)$/i.test(download.data.filename || "")) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok || Number(r.headers.get("content-length")) > 20 * 1024 * 1024) return null;
    const pedacos = []; let tamanho = 0;
    for await (const pedaco of r.body) { tamanho += pedaco.length; if (tamanho > 20 * 1024 * 1024) return null; pedacos.push(pedaco); }
    const dados = Buffer.concat(pedacos);
    const tipo = dados[0] === 0xff && dados[1] === 0xd8 ? "image/jpeg" : dados.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "image/png" : dados.toString("ascii",0,4) === "RIFF" && dados.toString("ascii",8,12) === "WEBP" ? "image/webp" : null;
    if (!tipo) return null;
    const imagem = await sharp(dados).metadata();
    if (!imagem.width || !imagem.height) return null;
    const arquivo = await salvarArquivo(org, { tipo, nome: download.data.filename, dados });
    const fonte = { provedor: "magnific", id, url: urlDoProvedor(recurso.url), autor: String(recurso.author?.name || "").slice(0,200), licencas: (Array.isArray(recurso.licenses) ? recurso.licenses : []).filter(l => l && typeof l === "object").map(l => ({ tipo: String(l.type || "").slice(0,80), url: urlDoProvedor(l.url) })), baixadoEm: new Date().toISOString() };
    try {
      await db().query("insert into banco_imagens(org_id,arquivo_id,nome,descricao,tags,origem,post_id,fonte) values ($1,$2,$3,$4,$5,'acervo',$6,$7)", [org, arquivo, String(recurso.title || "Foto do acervo Magnific").slice(0,80), String(recurso.title || texto).slice(0,400), ["acervo Magnific"], post || null, JSON.stringify(fonte)]);
    } catch (e) {
      await apagarArquivos(org, [arquivo]);
      if (e.code !== "23505") throw e;
      return (await db().query("select arquivo_id from banco_imagens where org_id=$1 and origem='acervo' and fonte->>'id'=$2", [org,id])).rows[0]?.arquivo_id || null;
    }
    await registrarConsumo(org, "magnific", { tipo: "acervo", quantidade: 1 });
    return arquivo;
  };
}
