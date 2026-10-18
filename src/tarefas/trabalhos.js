// O que antes rodava nos fluxos 01 (ideias), 03 e 05 (criação), 04 (ajuste) e 06 (publicação) do n8n.
import { db } from "../db.js";
import { claude, gerarFoto, gerarClipe, coletarApify, publicarZernio, chaveDe, ErroIntegracao } from "../provedores/index.js";
import { guardarDeUrl, apagarArquivos, anexos } from "../arquivos.js";
import { registrar } from "./fila.js";
import { SISTEMA_IDEIAS, SISTEMA_POST, SISTEMA_AJUSTE, SISTEMA_ESCOLHA_BANCO, idiomaDe, briefingTexto } from "./prompts.js";
import { devolver } from "../planos.js";
import { lerArquivo } from "../arquivos.js";

// Story em imagem estática segue o caminho das fotos (1 imagem vertical); os outros stories e os Reels são vídeo.
const ehStoryImagem = post => post.formato === "Stories" && post.briefing && post.briefing.story === "imagem";
const ehVideo = (formato, post) => ["Reels", "Stories"].includes(formato) && !(post && ehStoryImagem(post));
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

registrar("ideias", async (org, pedido = {}) => {
  const FORMATOS = ["Reels", "Carrossel", "Estatico", "Stories"];
  const quantidade = Math.max(1, Math.min(20, Number(pedido.quantidade) || 10));
  const formatos = (Array.isArray(pedido.formatos) ? pedido.formatos : []).filter(f => FORMATOS.includes(f));
  const tema = String(pedido.tema || "").trim().slice(0, 300);
  const m = await marcaDe(org);
  const fontes = (await db().query("select * from fontes where org_id = $1 and ativa", [org])).rows;
  const { refs, aviso } = await coletar(org, fontes);
  const top = refs.sort((a, b) => b.eng * (b.peso || 3) - a.eng * (a.peso || 3)).slice(0, 60);
  const refMap = {};
  const lista = top.map((r, i) => { const ref = "c" + (i + 1); refMap[ref] = r.id; return { ref, fonte: r.fonte, peso_fonte: r.peso, rede: r.rede, formato: r.formato, texto: r.texto, engajamento_relativo: r.eng }; });
  const interesses = fontes.filter(f => !["Perfil", "Hashtag"].includes(f.tipo)).map(f => f.nome);
  if (!lista.length && !interesses.length && !tema) throw new Error("Nenhuma fonte ativa para buscar ideias. Cadastre perfis, hashtags ou temas em Marca e fontes, ou informe um tema.");
  const recentes = (await db().query("select titulo, status, motivo_descarte from ideias where org_id = $1 and criada_em > now() - interval '90 days'", [org])).rows;
  const user = [blocoMarca(m), "", "<interesses>" + interesses.join(", ") + "</interesses>", tema ? "\n<tema_pedido>" + tema + "</tema_pedido>" : "", "", "<referencias>", JSON.stringify(lista, null, 1), "</referencias>", "",
    "<ideias_existentes>", recentes.map(r => "- " + r.titulo).join("\n"), "</ideias_existentes>", "",
    "<descartes_recentes>", recentes.filter(r => r.status === "Descartada").slice(0, 20).map(r => "- " + r.titulo + (r.motivo_descarte ? " (motivo: " + r.motivo_descarte + ")" : "")).join("\n"), "</descartes_recentes>", "",
    "Gere " + quantidade + " ideias." + (formatos.length ? " Use apenas estes formatos: " + formatos.join(", ") + "." : " Misture os formatos.") + (tema ? " Todas sobre o tema em <tema_pedido>." : "") +
    " Em \"referencias\", use os códigos \"ref\" (c1, c2…) das referências que inspiraram cada ideia."].join("\n");
  const dados = await claude(org, { system: SISTEMA_IDEIAS, content: user, effort: "medium" });
  const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const curto = t => norm(t).split(":")[0].trim();
  const pilares = m.pilares || [], redes = m.redes || [];
  const acharPilar = p => pilares.find(x => norm(x) === norm(p)) || pilares.find(x => curto(x) === curto(p)) || pilares.find(x => norm(x).startsWith(curto(p)) || norm(p).startsWith(curto(x))) || null;
  let criadas = 0;
  for (const i of dados.ideias || []) {
    const pilar = pilares.length ? acharPilar(i.pilar) : i.pilar;
    if (!i.titulo || !(formatos.length ? formatos : FORMATOS).includes(i.formato)) continue;
    if (redes.length && !redes.includes(i.rede)) continue;
    if (pilares.length && !pilar) continue;
    const score = Math.max(0, Math.min(10, Number(i.score) || 0));
    await db().query("insert into ideias (org_id, titulo, resumo, formato, rede, pilar, score, por_que, referencias) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [org, String(i.titulo).slice(0, 300), String(i.resumo || ""), i.formato, i.rede || null, pilar, score, String(i.por_que_funciona || ""), (i.referencias || []).map(r => refMap[r]).filter(Boolean)]);
    criadas++;
  }
  return { criadas, aviso };
});

registrar("descreverImagem", async (org, { imagem }) => {
  const r = (await db().query("select b.*, a.tipo, a.chave from banco_imagens b join arquivos a on a.id = b.arquivo_id where b.id = $1 and b.org_id = $2", [imagem, org])).rows[0];
  if (!r) return { ignorado: "imagem removida" };
  const arq = await lerArquivo(r.arquivo_id, r.chave);
  if (!arq || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(arq.tipo) || arq.dados.length > 3700000) return { ignorado: "formato ou tamanho fora do que o Claude lê" };
  const c = await claude(org, {
    system: 'Você descreve fotos do banco de imagens de uma marca para uma IA escolher a foto certa para cada post. Responda APENAS com JSON: {"nome":"até 5 palavras","descricao":"uma frase objetiva com o que aparece: produto, cor, material, modelo, cenário","tags":["até 6 palavras-chave curtas"]}. Em português do Brasil. Não invente marca, preço ou tamanho.',
    content: [{ type: "image", source: { type: "base64", media_type: arq.tipo, data: arq.dados.toString("base64") } }, { type: "text", text: "Descreva esta foto." + (r.nome ? " Nome dado pela pessoa: " + r.nome : "") }],
    effort: "low", max_tokens: 800,
  });
  await db().query("update banco_imagens set nome = case when nome = '' then $3 else nome end, descricao = case when descricao = '' then $4 else descricao end, tags = case when cardinality(tags) = 0 then $5 else tags end where id = $1 and org_id = $2",
    [imagem, org, String(c.nome || "").slice(0, 80), String(c.descricao || "").slice(0, 400), (Array.isArray(c.tags) ? c.tags : []).map(t => String(t).slice(0, 30)).slice(0, 8)]);
  return { ok: true };
});

/* ================= 2. Mídias do post: fotos (Mystic) e clipes (Kling 3) ================= */
// Limite do que a IA guarda no banco; acima disso saem as mais antigas que nenhum post usa.
export const LIMITE_BANCO_IA = { imagem: 500, video: 80 };
// Cada foto ou clipe gerado também vai para o banco da marca, para reutilizar depois (sem gastar créditos).
export async function guardarNoBanco(org, arquivo, { nome, descricao, video, post }) {
  try {
    await db().query("insert into banco_imagens (org_id, arquivo_id, nome, descricao, tags, origem, post_id) values ($1, $2, $3, $4, $5, 'ia', $6)",
      [org, arquivo, String(nome || "").slice(0, 80), String(descricao || "").slice(0, 400), ["gerada por IA", video ? "vídeo" : "foto"], post || null]);
    const tipo = video ? "video/%" : "image/%", limite = video ? LIMITE_BANCO_IA.video : LIMITE_BANCO_IA.imagem;
    const { rows } = await db().query(`delete from banco_imagens where id in (
        select b.id from banco_imagens b join arquivos a on a.id = b.arquivo_id
        where b.org_id = $1 and b.origem = 'ia' and a.tipo like $2
          and not exists (select 1 from posts p where p.org_id = $1 and (
            exists (select 1 from jsonb_each_text(p.fotos) f where f.value = b.arquivo_id::text) or
            exists (select 1 from jsonb_each_text(p.clipes) c where c.value = b.arquivo_id::text)))
        order by b.criado_em desc offset $3)
      returning arquivo_id`, [org, tipo, limite]);
    if (rows.length) await apagarArquivos(org, rows.map(r => r.arquivo_id));
  } catch (e) { console.error("[banco]", e.message); }
}
const nomeNoBanco = (post, n) => (String(post.titulo || "Post").slice(0, 64) + " · " + n).slice(0, 80);
async function gerarMidias(org, post, c, regerar) {
  const video = ehVideo(post.formato, post);
  const fotos = { ...(post.fotos || {}) }, clipes = { ...(post.clipes || {}) };
  const velhos = [];
  const precisa = (mapa, n) => (regerar ? regerar.includes(n) : !mapa[n]);
  let falhas = 0, semCredito = false;
  // Sem crédito no Magnific, não adianta tentar as outras imagens: conta como falha e segue.
  const falhou = (tipo, e) => { if (e instanceof ErroIntegracao && /não está cadastrada/.test(e.message)) throw e; falhas++; if (/insufficient credits|sem cr[ée]dito/i.test(e.message)) semCredito = true; console.error("[" + tipo + "]", e.message); };
  if (!video) {
    for (const x of c.prompts_imagem || []) {
      const n = Number(x.slide);
      if (!n || !precisa(fotos, n)) continue;
      if (semCredito) { falhas++; continue; }
      try {
        const url = await gerarFoto(org, x.prompt, x.proporcao);
        const id = await guardarDeUrl(org, url, `foto-${n}`);
        await guardarNoBanco(org, id, { nome: nomeNoBanco(post, n), descricao: x.prompt, post: post.id });
        if (fotos[n]) velhos.push(fotos[n]);
        fotos[n] = id;
      } catch (e) { falhou("foto", e); }
    }
  }
  const a = await anexos(org, Object.values(fotos));
  const pedidos = video
    ? (c.cenas || []).map((x, i) => { const n = Number(x.n) || i + 1, f = fotos[n] && a.get(fotos[n]); return { n, prompt: x.prompt_video || x.visual || post.titulo, duracao: x.duracao_s, proporcao: "9:16", ...(f ? { imagem: f.url } : {}) }; })
    : (c.slides || []).filter(x => x.usa_video && fotos[x.n] && a.get(fotos[x.n])).slice(0, 10)
      .map(x => ({ n: Number(x.n), prompt: x.prompt_video || x.titulo || post.titulo, duracao: 5, proporcao: "1:1", imagem: a.get(fotos[x.n]).url }));
  for (const p of pedidos) {
    if (!precisa(clipes, p.n)) continue;
    if (semCredito) { falhas++; continue; }
    try {
      const url = await gerarClipe(org, p);
      const id = await guardarDeUrl(org, url, `clipe-${p.n}.mp4`);
      await guardarNoBanco(org, id, { nome: nomeNoBanco(post, p.n), descricao: p.prompt, video: true, post: post.id });
      if (clipes[p.n]) velhos.push(clipes[p.n]);
      clipes[p.n] = id;
    } catch (e) { falhou("clipe", e); }
  }
  return { fotos, clipes, velhos, falhas, semCredito };
}
const avisoFalhas = (n, semCredito) => (!n ? null : semCredito
  ? `A conta do Magnific está sem créditos: ${n} imagem(ns) ou clipe(s) não foram gerados. Adicione créditos no Magnific e peça um ajuste com "Gerar uma imagem nova", ou use fotos do Banco de imagens.`
  : `${n} imagem(ns) ou clipe(s) não foram gerados pelo Magnific. Peça um ajuste para tentar de novo.`);

// Mood board vai em base64, lido direto do disco (o Claude não baixa links de terceiros).
async function moodBoard(org, m) {
  const a = await anexos(org, m.mood_board || []);
  const blocos = [];
  for (const id of (m.mood_board || []).slice(0, 6)) {
    const x = a.get(id); if (!x) continue;
    const arq = await lerArquivo(id, new URL(x.url).pathname.split("/").pop());
    if (!arq || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(arq.tipo) || arq.dados.length > 3700000) continue;
    blocos.push({ type: "image", source: { type: "base64", media_type: arq.tipo, data: arq.dados.toString("base64") } });
  }
  return blocos;
}

// Fotos do banco que vão para o Claude: as escolhidas no briefing ou as mais recentes. Devolve o bloco de texto e o mapa código → arquivo.
async function bancoParaPost(org, briefing) {
  const modo = briefing && briefing.imagens;
  if (!["banco", "misto"].includes(modo)) return { texto: "", mapa: {} };
  const escolhidas = Array.isArray(briefing.banco) ? briefing.banco.filter(x => /^[0-9a-f-]{36}$/i.test(String(x))) : [];
  const { rows } = escolhidas.length
    ? await db().query("select b.*, a.tipo from banco_imagens b join arquivos a on a.id = b.arquivo_id where b.org_id = $1 and b.id = any($2::uuid[]) order by b.criado_em desc", [org, escolhidas])
    : await db().query("select b.*, a.tipo from banco_imagens b join arquivos a on a.id = b.arquivo_id where b.org_id = $1 order by (b.origem = 'envio') desc, b.criado_em desc limit 40", [org]);
  if (!rows.length) return { texto: "", mapa: {}, vazio: true };
  const mapa = {}; let nf = 0, nv = 0;
  const linhas = rows.map(r => {
    const video = /^video\//.test(r.tipo), cod = video ? "v" + (++nv) : "b" + (++nf);
    mapa[cod] = { arquivo: r.arquivo_id, video };
    return `${cod}${video ? " [vídeo]" : ""}: ${[r.nome, r.descricao, (r.tags || []).join(", ")].filter(Boolean).join(" · ") || (video ? "vídeo sem descrição" : "foto sem descrição")}`;
  });
  return { texto: ["<banco_de_imagens>", ...linhas, "</banco_de_imagens>"].join("\n"), mapa };
}
// A IA escolhe, no banco, as fotos e vídeos que combinam com o post (botão "IA escolhe" no briefing). Devolve os ids do banco, os melhores primeiro.
export async function escolherDoBanco(org, post, briefing) {
  const { rows } = await db().query("select b.*, a.tipo from banco_imagens b join arquivos a on a.id = b.arquivo_id where b.org_id = $1 order by (b.origem = 'envio') desc, b.criado_em desc limit 200", [org]);
  if (!rows.length) return { ids: [], motivo: "" };
  const ids = {}; let nf = 0, nv = 0;
  const linhas = rows.map(r => {
    const video = /^video\//.test(r.tipo), cod = video ? "v" + (++nv) : "b" + (++nf);
    ids[cod] = r.id;
    return `${cod}${video ? " [vídeo]" : ""}: ${[r.nome, r.descricao, (r.tags || []).join(", ")].filter(Boolean).join(" · ") || "sem descrição"}`;
  });
  const m = await marcaDe(org);
  const ideia = post.ideia_id ? (await db().query("select resumo from ideias where id = $1", [post.ideia_id])).rows[0] : null;
  const slides = ehVideo(post.formato, { ...post, briefing }) ? Number(briefing.cenas) || 6 : post.formato === "Estatico" || ehStoryImagem({ ...post, briefing }) ? 2 : Number(briefing.slides) || 8;
  const user = [blocoMarca(m), "", "<post>", "titulo: " + post.titulo, "formato: " + (post.formato || ""), "pilar: " + (post.pilar || ""), "</post>", "",
    "<ideia>" + ((ideia && ideia.resumo) || post.titulo) + "</ideia>", "", briefingTexto(briefing, post.formato), "", "<banco_de_imagens>", ...linhas, "</banco_de_imagens>"].join("\n");
  const c = await claude(org, { system: SISTEMA_ESCOLHA_BANCO.replace("{{maximo}}", String(Math.min(20, slides))), content: user, effort: "low", max_tokens: 2000 });
  const escolhidas = [...new Set((Array.isArray(c.escolhidas) ? c.escolhidas : []).map(x => ids[String(x).trim()]).filter(Boolean))].slice(0, 20);
  return { ids: escolhidas, motivo: String(c.motivo || "").slice(0, 300) };
}
// Troca o código do banco (b3 foto, v2 vídeo) pelo arquivo, nos slides ou cenas, e devolve fotos e clipes já resolvidos.
export function aplicarBanco(c, mapa) {
  const fotos = {}, clipes = {};
  for (const lista of [c.slides || [], c.cenas || []]) lista.forEach((s, i) => {
    const x = s && mapa[String(s.imagem_banco || "").trim()];
    if (!x) return;
    const n = Number(s.n) || i + 1;
    if (x.video) { clipes[n] = x.arquivo; s.usa_video = true; } else { fotos[n] = x.arquivo; s.usa_imagem = true; }
  });
  if (Object.keys(fotos).length || Object.keys(clipes).length) c.prompts_imagem = (c.prompts_imagem || []).filter(p => !fotos[Number(p.slide)] && !clipes[Number(p.slide)]);
  return { fotos, clipes };
}
registrar("criar", Object.assign(async (org, { post: id }) => {
  const post = await postDe(org, id);
  if (!post) return { ignorado: "post removido" };
  const m = await marcaDe(org);
  const ideia = post.ideia_id ? (await db().query("select * from ideias where id = $1", [post.ideia_id])).rows[0] : null;
  const user = [blocoMarca(m), "", "<post>", "titulo: " + post.titulo, "rede: " + (post.rede || ""), "formato: " + (post.formato || ""), "pilar: " + (post.pilar || ""),
    "data: " + new Date(post.data_publicacao).toISOString(), "</post>", "", "<ideia>", "resumo: " + ((ideia && ideia.resumo) || post.titulo), "por_que_funciona: " + ((ideia && ideia.por_que) || ""), "</ideia>", "", briefingTexto(post.briefing, post.formato)].join("\n");
  const banco = await bancoParaPost(org, post.briefing);
  if (banco.vazio) throw new Error("o banco de imagens está vazio. Envie fotos em Marca e fontes › Banco de imagens ou escolha gerar com IA");
  const pedidoUsuario = banco.texto ? user + "\n\n" + banco.texto : user;
  const mood = await moodBoard(org, m);
  const content = mood.length ? [{ type: "text", text: "Mood board da marca (referência de estilo):" }, ...mood, { type: "text", text: pedidoUsuario }] : pedidoUsuario;
  const c = await claude(org, { system: SISTEMA_POST, content, effort: "high" });
  const video = ehVideo(post.formato, post);
  await db().query("update posts set legenda = $2, hashtags = $3, slides = $4, conteudo = $5, atualizado_em = now() where id = $1",
    [post.id, c.legenda || "", (c.hashtags || []).join(" "), JSON.stringify(video ? c.cenas || [] : c.slides || []), JSON.stringify(c)]);
  // Começa do zero: apaga mídias de uma criação anterior.
  await apagarArquivos(org, [...Object.values(post.fotos || {}), ...Object.values(post.clipes || {}), ...(post.artes || [])]);
  const doBanco = aplicarBanco(c, banco.mapa);
  const r = await gerarMidias(org, { ...post, fotos: doBanco.fotos, clipes: doBanco.clipes }, c, null);
  await db().query("update posts set fotos = $2, clipes = $3, artes = '{}', artes_prontas = false, regerar = '{}', status = 'EmRevisao', erro = $4, atualizado_em = now() where id = $1",
    [post.id, JSON.stringify(r.fotos), JSON.stringify(r.clipes), avisoFalhas(r.falhas, r.semCredito)]);
  return { fotos: Object.keys(r.fotos).length, clipes: Object.keys(r.clipes).length, falhas: r.falhas };
}, {
  aoFalhar: async (org, { post }, e) => {
    await db().query("update posts set status = 'Erro', erro = $3 where id = $1 and org_id = $2", [post, org, "Não consegui criar: " + String(e.message).slice(0, 400)]);
    // Post que não saiu não conta no limite do plano.
    await devolver(org, "post");
  },
}));

/* ================= 3. Ajuste pedido na revisão ================= */
registrar("ajustar", Object.assign(async (org, { post: id, comentario, slide = 0, novaImagem = false }) => {
  const post = await postDe(org, id);
  if (!post) return { ignorado: "post removido" };
  const m = await marcaDe(org);
  const atual = { ...(post.conteudo || {}) };
  for (const k of ["alterou_legenda", "alterou_slides", "alterou_imagens", "resumo_mudancas"]) delete atual[k];
  const user = [blocoMarca(m), "", `<versao_atual numero="${post.versao}">`, JSON.stringify(atual, null, 1), "</versao_atual>", "",
    "<historico>", post.historico_ajustes || "", "</historico>", "", "<comentario>", comentario, "</comentario>"].join("\n");
  const c = await claude(org, { system: SISTEMA_AJUSTE, content: user, effort: "medium" });
  const video = ehVideo(post.formato, post);
  let regerar = (video && !(c.alterou_imagens || []).length ? c.alterou_slides : c.alterou_imagens || []).map(Number).filter(Boolean);
  if (novaImagem && !slide) regerar = [...new Set(regerar.concat((c.slides || c.cenas || []).filter(s => s.usa_imagem || s.usa_video || video).map((s, i) => Number(s.n) || i + 1)))];
  if (slide) {
    // Só o slide escolhido muda: o resto volta a ser o da versão atual.
    const chave = video ? "cenas" : "slides";
    const velhos = atual[chave] || [], novos = c[chave] || [];
    const num = (s, i) => Number(s && s.n) || i + 1;
    c[chave] = velhos.map((v, i) => num(v, i) === slide ? (novos.find((n, k) => num(n, k) === slide) || v) : v);
    if (atual.prompts_imagem && c.prompts_imagem && typeof atual.prompts_imagem === "object") {
      const pa = atual.prompts_imagem, pn = c.prompts_imagem;
      c.prompts_imagem = Array.isArray(pa) ? pa.map((x, i) => (num(x, i) === slide ? (Array.isArray(pn) ? pn.find((y, k) => num(y, k) === slide) : null) || x : x)) : { ...pa, [slide]: pn[slide] ?? pa[slide] };
    }
    c.legenda = atual.legenda; c.hashtags = atual.hashtags;
    regerar = novaImagem ? [slide] : regerar.filter(n => n === slide);
  }
  const r = await gerarMidias(org, post, c, regerar);
  await db().query(`update posts set legenda = $2, hashtags = $3, slides = $4, conteudo = $5, fotos = $6, clipes = $7, versao = versao + 1,
    artes_prontas = false, status = 'EmRevisao', erro = $8, atualizado_em = now() where id = $1`,
    [post.id, c.legenda || "", (c.hashtags || []).join(" "), JSON.stringify(video ? c.cenas || [] : c.slides || []), JSON.stringify(c),
      JSON.stringify(r.fotos), JSON.stringify(r.clipes), avisoFalhas(r.falhas, r.semCredito)]);
  await apagarArquivos(org, r.velhos);
  return { resumo: c.resumo_mudancas || "", refeitos: regerar.length };
}, {
  aoFalhar: async (org, { post }, e) => db().query("update posts set status = 'EmRevisao', erro = $3 where id = $1 and org_id = $2", [post, org, "Não consegui aplicar o ajuste: " + String(e.message).slice(0, 400) + ". O post continua na versão anterior."]),
}));

/* ================= 4. Publicação na hora marcada ================= */
const REDES = { Instagram: "instagram", Facebook: "facebook", TikTok: "tiktok", X: "twitter", Threads: "threads", LinkedIn: "linkedin", YouTube: "youtube" };
export const REDES_PUBLICACAO = Object.keys(REDES);
// Corta o texto no limite da rede, sem partir palavra.
const cortar = (t, n) => { t = String(t || "").trim(); if (t.length <= n) return t; const c = t.slice(0, n - 1); const i = c.lastIndexOf(" "); return (i > n * 0.6 ? c.slice(0, i) : c).replace(/[\s.,;:!?-]+$/, "") + "…"; };
// O que cada rede recebe: texto no limite dela, as mídias que ela aceita e as opções do Zernio.
export function conteudoPara(nome, p, midias) {
  const legenda = [p.legenda, p.hashtags].filter(Boolean).join("\n\n");
  const videos = midias.filter(m => m.type === "video"), imagens = midias.filter(m => m.type === "image");
  const story = p.formato === "Stories";
  if (story && !["Instagram", "Facebook"].includes(nome)) return { erro: "Stories só vão para o Instagram e o Facebook" };
  switch (nome) {
    case "Instagram": return { midias, legenda: story ? "" : legenda, opcoes: story ? { contentType: "story" } : null };
    case "Facebook": {
      const m = imagens.length && videos.length ? imagens : midias; // o Facebook não mistura fotos e vídeo
      if (story) return { midias: m.slice(0, 1), legenda: "", opcoes: { contentType: "story" } };
      if (p.formato === "Reels" && videos.length === 1 && !imagens.length) return { midias: videos, legenda, opcoes: { contentType: "reel", title: cortar(p.titulo, 100) } };
      return { midias: m.slice(0, 10), legenda, opcoes: null };
    }
    case "X": return { midias: videos.length ? videos.slice(0, 1) : imagens.slice(0, 4), legenda: cortar(legenda, 280), opcoes: null };
    case "Threads": return { midias: (imagens.length && videos.length ? imagens : midias).slice(0, 10), legenda: cortar(legenda, 500), opcoes: null };
    case "TikTok": {
      // A pessoa revisa a prévia e aprova no painel antes de publicar; as artes são feitas com IA.
      const base = { privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, content_preview_confirmed: true, express_consent_given: true };
      if (videos.length) return { midias: videos.slice(0, 1), legenda: cortar(legenda, 2200), opcoes: { tiktokSettings: { ...base, allow_duet: true, allow_stitch: true, video_made_with_ai: true } } };
      if (imagens.length) return { midias: imagens.slice(0, 35), legenda: cortar(p.titulo, 90), opcoes: { tiktokSettings: { ...base, media_type: "photo", photo_cover_index: 0, description: cortar(legenda, 4000), auto_add_music: true } } };
      return { erro: "o TikTok precisa de vídeo ou fotos" };
    }
    case "YouTube": return videos.length ? { midias: videos.slice(0, 1), legenda, opcoes: { title: cortar(p.titulo, 100), visibility: "public" } } : { erro: "o YouTube precisa de vídeo" };
    default: return { midias, legenda, opcoes: null };
  }
}
export async function publicarVencidos() {
  // Marca como "Publicando" antes de chamar o Zernio, para não publicar duas vezes.
  const { rows } = await db().query(`update posts set status = 'Publicando', atualizado_em = now()
    where id in (select id from posts where status = 'Agendado' and artes_prontas and data_publicacao <= now() + interval '1 minute' order by data_publicacao limit 10 for update skip locked)
    returning *`);
  for (const p of rows) await publicarPost(p);
}
// "Publicar agora" do painel: só posts Agendados com as artes prontas.
export async function publicarJa(org, id) {
  const { rows } = await db().query(`update posts set status = 'Publicando', atualizado_em = now()
    where id = $1 and org_id = $2 and status = 'Agendado' and artes_prontas returning *`, [id, org]);
  if (rows[0]) setImmediate(() => publicarPost(rows[0]).catch(e => console.error("[publicar]", e)));
  return !!rows[0];
}
async function publicarPost(p) {
  {
    try {
      const a = await anexos(p.org_id, p.artes || []);
      const midias = (p.artes || []).map(id => a.get(id)).filter(Boolean).map(x => ({ type: String(x.type).startsWith("video/") ? "video" : "image", url: x.url }));
      // Uma publicação por rede: se uma falhar, as outras seguem.
      const redes = (p.redes && p.redes.length ? p.redes : [p.rede]).filter(r => REDES[r]);
      if (!redes.length) throw new Error("escolha pelo menos uma rede para publicar");
      const links = { ...(p.links || {}) }, falhas = [], ids = [];
      for (const nome of redes) {
        if (links[nome]) continue; // já saiu nessa rede numa tentativa anterior
        const c = conteudoPara(nome, p, midias);
        if (c.erro) { falhas.push(`${nome}: ${c.erro}`); continue; }
        const r = await publicarZernio(p.org_id, { rede: REDES[nome], midias: c.midias, legenda: c.legenda, opcoes: c.opcoes, chave: `pauta-${p.id}-${p.versao}-${REDES[nome]}` });
        if (r.id) ids.push(r.id);
        if (r.ok) links[nome] = r.link || "publicado"; else falhas.push(`${nome}: ${r.erro}`);
      }
      const saiu = Object.keys(links).length > 0;
      const primeiro = Object.values(links).find(l => /^https?:/.test(l)) || null;
      await db().query("update posts set status = $2, link_publicado = $3, id_agendamento = $4, erro = $5, links = $6, atualizado_em = now() where id = $1",
        [p.id, saiu ? "Publicado" : "Erro", primeiro, ids.join(","), falhas.length ? (saiu ? "Não publicou em " : "Falhou ao publicar em ") + falhas.join(" · ").slice(0, 700) : null, JSON.stringify(links)]);
    } catch (e) {
      await db().query("update posts set status = 'Erro', erro = $2, atualizado_em = now() where id = $1", [p.id, "Falhou ao publicar: " + String(e.message).slice(0, 400)]);
    }
  }
}
