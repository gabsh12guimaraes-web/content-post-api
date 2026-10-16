// O que antes rodava nos fluxos 01 (ideias), 03 e 05 (criação), 04 (ajuste) e 06 (publicação) do n8n.
import { db } from "../db.js";
import { claude, gerarFoto, gerarClipe, coletarApify, publicarAyrshare, chaveDe, ErroIntegracao } from "../provedores/index.js";
import { guardarDeUrl, apagarArquivos, anexos } from "../arquivos.js";
import { registrar } from "./fila.js";
import { SISTEMA_IDEIAS, SISTEMA_POST, SISTEMA_AJUSTE, idiomaDe } from "./prompts.js";

const ehVideo = formato => ["Reels", "Stories"].includes(formato);
const marcaDe = async org => (await db().query("select * from marcas where org_id = $1", [org])).rows[0] || { org_id: org, pilares: [], redes: [], mood_board: [] };
const postDe = async (org, id) => (await db().query("select * from posts where id = $1 and org_id = $2", [id, org])).rows[0];
const lst = v => (Array.isArray(v) ? v.join(", ") : v || "");

function blocoMarca(m) {
  return ["<marca>", "nome: " + (m.nome || ""), "posicionamento: " + (m.posicionamento || ""), "publico: " + (m.publico || ""),
    "<tom_de_voz>" + (m.tom_de_voz || "") + "</tom_de_voz>", "<idioma>" + idiomaDe(m) + "</idioma>",
    "pilares: " + lst(m.pilares), "redes: " + lst(m.redes), "<cores>" + String(m.cores || "").split("\n").join("; ") + "</cores>",
    "<evitar>" + (m.evitar || "") + "</evitar>", "</marca>"].join("\n");
}

/* ================= 1. Ideias: coleta nas fontes + Claude ================= */
const ATORES = {
  "Instagram|Perfil": alvo => ["apify~instagram-post-scraper", { username: [alvo], resultsLimit: 20 }],
  "Instagram|Hashtag": alvo => ["apify~instagram-hashtag-scraper", { hashtags: [alvo], resultsLimit: 20 }],
  "TikTok|Perfil": alvo => ["clockworks~tiktok-scraper", { profiles: [alvo], resultsPerPage: 20 }],
  "TikTok|Hashtag": alvo => ["clockworks~tiktok-scraper", { hashtags: [alvo], resultsPerPage: 20 }],
};
async function coletar(org, fontes) {
  const coletaveis = fontes.filter(f => ATORES[`${f.rede}|${f.tipo}`]);
  if (!coletaveis.length) return { refs: [], aviso: "" };
  try { await chaveDe(org, "apify"); } catch (e) { return { refs: [], aviso: "Sem chave da Apify: as ideias vieram só dos temas de interesse." }; }
  const refs = [];
  for (const f of coletaveis) {
    const alvo = String(f.nome).trim().replace(/^[@#]/, "");
    const [ator, input] = ATORES[`${f.rede}|${f.tipo}`](alvo);
    let itens = [];
    try { itens = await coletarApify(org, ator, input); } catch (e) { console.error("[coleta]", f.nome, e.message); continue; }
    const posts = itens.filter(p => p && !p.error && (p.url || p.webVideoUrl));
    if (!posts.length) continue;
    const curt = p => Number(p.likesCount ?? p.diggCount ?? 0), coms = p => Number(p.commentsCount ?? p.commentCount ?? 0);
    const media = posts.reduce((s, p) => s + curt(p) + coms(p), 0) / posts.length || 1;
    const formato = p => (p.webVideoUrl || p.type === "Video") ? "Reels" : p.type === "Sidecar" ? "Carrossel" : "Estatico";
    for (const p of posts) {
      const eng = Math.round((curt(p) + coms(p)) / media * 100) / 100;
      const { rows } = await db().query(
        `insert into coletas (org_id, fonte_id, id_externo, url, texto, formato, curtidas, comentarios, engajamento_relativo, data_post)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (org_id, id_externo) do update set curtidas = excluded.curtidas, comentarios = excluded.comentarios, engajamento_relativo = excluded.engajamento_relativo, coletado_em = now()
         returning id`,
        [org, f.id, String(p.id || p.shortCode || p.url || p.webVideoUrl), p.url || p.webVideoUrl, String(p.caption ?? p.text ?? "").slice(0, 2000), formato(p), curt(p), coms(p), eng,
          String(p.timestamp || p.createTimeISO || "").slice(0, 10) || null]);
      refs.push({ id: rows[0].id, fonte: f.nome, peso: f.peso, rede: f.rede, formato: formato(p), texto: String(p.caption ?? p.text ?? "").slice(0, 400), eng });
    }
    await db().query("update fontes set ultima_coleta = now() where id = $1", [f.id]);
  }
  return { refs, aviso: "" };
}

registrar("ideias", async (org) => {
  const m = await marcaDe(org);
  const fontes = (await db().query("select * from fontes where org_id = $1 and ativa", [org])).rows;
  const { refs, aviso } = await coletar(org, fontes);
  const top = refs.sort((a, b) => b.eng * (b.peso || 3) - a.eng * (a.peso || 3)).slice(0, 60);
  const refMap = {};
  const lista = top.map((r, i) => { const ref = "c" + (i + 1); refMap[ref] = r.id; return { ref, fonte: r.fonte, peso_fonte: r.peso, rede: r.rede, formato: r.formato, texto: r.texto, engajamento_relativo: r.eng }; });
  const interesses = fontes.filter(f => !["Perfil", "Hashtag"].includes(f.tipo)).map(f => f.nome);
  if (!lista.length && !interesses.length) throw new Error("Nenhuma fonte ativa para buscar ideias. Cadastre perfis, hashtags ou temas em Marca e fontes.");
  const recentes = (await db().query("select titulo, status, motivo_descarte from ideias where org_id = $1 and criada_em > now() - interval '90 days'", [org])).rows;
  const user = [blocoMarca(m), "", "<interesses>" + interesses.join(", ") + "</interesses>", "", "<referencias>", JSON.stringify(lista, null, 1), "</referencias>", "",
    "<ideias_existentes>", recentes.map(r => "- " + r.titulo).join("\n"), "</ideias_existentes>", "",
    "<descartes_recentes>", recentes.filter(r => r.status === "Descartada").slice(0, 20).map(r => "- " + r.titulo + (r.motivo_descarte ? " (motivo: " + r.motivo_descarte + ")" : "")).join("\n"), "</descartes_recentes>", "",
    "Gere 10 ideias. Em \"referencias\", use os códigos \"ref\" (c1, c2…) das referências que inspiraram cada ideia."].join("\n");
  const dados = await claude(org, { system: SISTEMA_IDEIAS, content: user, effort: "medium" });
  const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const curto = t => norm(t).split(":")[0].trim();
  const pilares = m.pilares || [], redes = m.redes || [];
  const acharPilar = p => pilares.find(x => norm(x) === norm(p)) || pilares.find(x => curto(x) === curto(p)) || pilares.find(x => norm(x).startsWith(curto(p)) || norm(p).startsWith(curto(x))) || null;
  let criadas = 0;
  for (const i of dados.ideias || []) {
    const pilar = pilares.length ? acharPilar(i.pilar) : i.pilar;
    if (!i.titulo || !["Reels", "Carrossel", "Estatico", "Stories"].includes(i.formato)) continue;
    if (redes.length && !redes.includes(i.rede)) continue;
    if (pilares.length && !pilar) continue;
    const score = Math.max(0, Math.min(10, Number(i.score) || 0));
    await db().query("insert into ideias (org_id, titulo, resumo, formato, rede, pilar, score, por_que, referencias) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [org, String(i.titulo).slice(0, 300), String(i.resumo || ""), i.formato, i.rede || null, pilar, score, String(i.por_que_funciona || ""), (i.referencias || []).map(r => refMap[r]).filter(Boolean)]);
    criadas++;
  }
  return { criadas, aviso };
});

/* ================= 2. Mídias do post: fotos (Mystic) e clipes (Kling 3) ================= */
async function gerarMidias(org, post, c, regerar) {
  const video = ehVideo(post.formato);
  const fotos = { ...(post.fotos || {}) }, clipes = { ...(post.clipes || {}) };
  const velhos = [];
  const precisa = (mapa, n) => (regerar ? regerar.includes(n) : !mapa[n]);
  let falhas = 0;
  if (!video) {
    for (const x of c.prompts_imagem || []) {
      const n = Number(x.slide);
      if (!n || !precisa(fotos, n)) continue;
      try {
        const url = await gerarFoto(org, x.prompt, x.proporcao);
        const id = await guardarDeUrl(org, url, `foto-${n}`);
        if (fotos[n]) velhos.push(fotos[n]);
        fotos[n] = id;
      } catch (e) { if (e instanceof ErroIntegracao && /não está cadastrada/.test(e.message)) throw e; falhas++; console.error("[foto]", e.message); }
    }
  }
  const a = await anexos(org, Object.values(fotos));
  const pedidos = video
    ? (c.cenas || []).map((x, i) => ({ n: Number(x.n) || i + 1, prompt: x.prompt_video || x.visual || post.titulo, duracao: x.duracao_s, proporcao: "9:16" }))
    : (c.slides || []).filter(x => x.usa_video && fotos[x.n] && a.get(fotos[x.n])).slice(0, 3)
      .map(x => ({ n: Number(x.n), prompt: x.prompt_video || x.titulo || post.titulo, duracao: 5, proporcao: "1:1", imagem: a.get(fotos[x.n]).url }));
  for (const p of pedidos) {
    if (!precisa(clipes, p.n)) continue;
    try {
      const url = await gerarClipe(org, p);
      const id = await guardarDeUrl(org, url, `clipe-${p.n}.mp4`);
      if (clipes[p.n]) velhos.push(clipes[p.n]);
      clipes[p.n] = id;
    } catch (e) { if (e instanceof ErroIntegracao && /não está cadastrada/.test(e.message)) throw e; falhas++; console.error("[clipe]", e.message); }
  }
  return { fotos, clipes, velhos, falhas };
}
const avisoFalhas = n => (n ? `${n} imagem(ns) ou clipe(s) não foram gerados pelo Magnific. Peça um ajuste para tentar de novo.` : null);

async function conteudoDaMarca(org, m) {
  const a = await anexos(org, m.mood_board || []);
  return (m.mood_board || []).slice(0, 6).map(id => a.get(id)).filter(Boolean).map(x => x.url);
}

registrar("criar", Object.assign(async (org, { post: id }) => {
  const post = await postDe(org, id);
  if (!post) return { ignorado: "post removido" };
  const m = await marcaDe(org);
  const ideia = post.ideia_id ? (await db().query("select * from ideias where id = $1", [post.ideia_id])).rows[0] : null;
  const user = [blocoMarca(m), "", "<post>", "titulo: " + post.titulo, "rede: " + (post.rede || ""), "formato: " + (post.formato || ""), "pilar: " + (post.pilar || ""),
    "data: " + new Date(post.data_publicacao).toISOString(), "</post>", "", "<ideia>", "resumo: " + ((ideia && ideia.resumo) || post.titulo), "por_que_funciona: " + ((ideia && ideia.por_que) || ""), "</ideia>"].join("\n");
  const mood = await conteudoDaMarca(org, m);
  const content = mood.length ? [{ type: "text", text: "Mood board da marca (referência de estilo):" }, ...mood.map(url => ({ type: "image", source: { type: "url", url } })), { type: "text", text: user }] : user;
  const c = await claude(org, { system: SISTEMA_POST, content, effort: "high" });
  const video = ehVideo(post.formato);
  await db().query("update posts set legenda = $2, hashtags = $3, slides = $4, conteudo = $5, atualizado_em = now() where id = $1",
    [post.id, c.legenda || "", (c.hashtags || []).join(" "), JSON.stringify(video ? c.cenas || [] : c.slides || []), JSON.stringify(c)]);
  // Começa do zero: apaga mídias de uma criação anterior.
  await apagarArquivos(org, [...Object.values(post.fotos || {}), ...Object.values(post.clipes || {}), ...(post.artes || [])]);
  const r = await gerarMidias(org, { ...post, fotos: {}, clipes: {} }, c, null);
  await db().query("update posts set fotos = $2, clipes = $3, artes = '{}', artes_prontas = false, regerar = '{}', status = 'EmRevisao', erro = $4, atualizado_em = now() where id = $1",
    [post.id, JSON.stringify(r.fotos), JSON.stringify(r.clipes), avisoFalhas(r.falhas)]);
  return { fotos: Object.keys(r.fotos).length, clipes: Object.keys(r.clipes).length, falhas: r.falhas };
}, {
  aoFalhar: async (org, { post }, e) => db().query("update posts set status = 'Erro', erro = $3 where id = $1 and org_id = $2", [post, org, "Não consegui criar: " + String(e.message).slice(0, 400)]),
}));

/* ================= 3. Ajuste pedido na revisão ================= */
registrar("ajustar", Object.assign(async (org, { post: id, comentario }) => {
  const post = await postDe(org, id);
  if (!post) return { ignorado: "post removido" };
  const m = await marcaDe(org);
  const atual = { ...(post.conteudo || {}) };
  for (const k of ["alterou_legenda", "alterou_slides", "alterou_imagens", "resumo_mudancas"]) delete atual[k];
  const user = [blocoMarca(m), "", `<versao_atual numero="${post.versao}">`, JSON.stringify(atual, null, 1), "</versao_atual>", "",
    "<historico>", post.historico_ajustes || "", "</historico>", "", "<comentario>", comentario, "</comentario>"].join("\n");
  const c = await claude(org, { system: SISTEMA_AJUSTE, content: user, effort: "medium" });
  const video = ehVideo(post.formato);
  const regerar = (video && !(c.alterou_imagens || []).length ? c.alterou_slides : c.alterou_imagens || []).map(Number).filter(Boolean);
  const r = await gerarMidias(org, post, c, regerar);
  await db().query(`update posts set legenda = $2, hashtags = $3, slides = $4, conteudo = $5, fotos = $6, clipes = $7, versao = versao + 1,
    artes_prontas = false, status = 'EmRevisao', erro = $8, atualizado_em = now() where id = $1`,
    [post.id, c.legenda || "", (c.hashtags || []).join(" "), JSON.stringify(video ? c.cenas || [] : c.slides || []), JSON.stringify(c),
      JSON.stringify(r.fotos), JSON.stringify(r.clipes), avisoFalhas(r.falhas)]);
  await apagarArquivos(org, r.velhos);
  return { resumo: c.resumo_mudancas || "", refeitos: regerar.length };
}, {
  aoFalhar: async (org, { post }, e) => db().query("update posts set status = 'EmRevisao', erro = $3 where id = $1 and org_id = $2", [post, org, "Não consegui aplicar o ajuste: " + String(e.message).slice(0, 400) + ". O post continua na versão anterior."]),
}));

/* ================= 4. Publicação na hora marcada ================= */
const REDES = { Instagram: "instagram", TikTok: "tiktok", LinkedIn: "linkedin", YouTube: "youtube" };
export async function publicarVencidos() {
  // Marca como "Publicando" antes de chamar o Ayrshare, para não publicar duas vezes.
  const { rows } = await db().query(`update posts set status = 'Publicando', atualizado_em = now()
    where id in (select id from posts where status = 'Agendado' and artes_prontas and data_publicacao <= now() + interval '1 minute' order by data_publicacao limit 10 for update skip locked)
    returning *`);
  for (const p of rows) {
    try {
      const a = await anexos(p.org_id, p.artes || []);
      const corpo = { post: [p.legenda, p.hashtags].filter(Boolean).join("\n\n"), platforms: [REDES[p.rede]].filter(Boolean), mediaUrls: (p.artes || []).map(id => a.get(id)).filter(Boolean).map(x => x.url) };
      if (ehVideo(p.formato)) corpo.isVideo = true;
      if (p.rede === "Instagram" && p.formato === "Reels") corpo.instagramOptions = { reels: true, shareReelsFeed: true };
      if (p.rede === "Instagram" && p.formato === "Stories") corpo.instagramOptions = { stories: true };
      if (p.rede === "YouTube") corpo.youTubeOptions = { title: String(p.titulo).slice(0, 100), visibility: "public" };
      const r = await publicarAyrshare(p.org_id, corpo);
      await db().query("update posts set status = $2, link_publicado = $3, id_agendamento = $4, erro = $5, atualizado_em = now() where id = $1",
        [p.id, r.ok ? "Publicado" : "Erro", r.link, r.id, r.ok ? null : "Falhou ao publicar: " + r.erro]);
    } catch (e) {
      await db().query("update posts set status = 'Erro', erro = $2, atualizado_em = now() where id = $1", [p.id, "Falhou ao publicar: " + String(e.message).slice(0, 400)]);
    }
  }
}
