// Marca, fontes, ideias e calendário da organização selecionada.
import { db } from "../db.js";
import { falha, exigirId, texto, UUID } from "../erros.js";
import { salvarArquivo, guardarDeUrl, apagarArquivos, anexos } from "../arquivos.js";
import { marcaParaPainel, fonteParaPainel, ideiaParaPainel, postsParaPainel } from "../formato.js";
import { enfileirar } from "../tarefas/fila.js";
import { cifrar } from "../cripto.js";
import { podeGerir } from "./conta.js";
import { publicarJa, REDES_PUBLICACAO, escolherDoBanco } from "../tarefas/trabalhos.js";
import { redesConectadas } from "../provedores/index.js";
import { usar, devolver, limiteModelos } from "../planos.js";

const LOGOS = ["Logo", "LogoDark", "SimboloLight", "SimboloDark"];
const STATUS_IDEIA = ["Sugerida", "Aprovada", "Descartada", "Guardada"];
const LIMITE_AJUSTES = 3;
const doBase64 = (b64, max = 25 * 1024 * 1024) => {
  if (typeof b64 !== "string" || !b64.length) falha("Arquivo vazio.");
  const dados = Buffer.from(b64, "base64");
  if (dados.length > max) falha(`Arquivo grande demais (máximo ${Math.round(max / 1048576)} MB).`);
  return dados;
};
async function postDaOrg(org, id) {
  const p = (await db().query("select * from posts where id = $1 and org_id = $2", [exigirId(id), org])).rows[0];
  if (!p) falha("Post não encontrado.", 404);
  return p;
}
// Respostas dadas no painel antes de criar. Só valores conhecidos passam.
function limparBriefing(r) {
  r = r && typeof r === "object" ? r : {};
  const um = (v, lista) => (lista.includes(v) ? v : undefined);
  const br = {
    capa: um(r.capa, ["foto", "video", "texto"]), fundo: um(r.fundo, ["fotos", "videos", "misto", "texto"]),
    slides: r.slides === "auto" ? "auto" : (Number(r.slides) >= 2 && Number(r.slides) <= 10 ? Number(r.slides) : undefined),
    objetivo: um(r.objetivo, ["engajar", "educar", "vender", "institucional"]),
    duracao: [15, 30, 45].includes(Number(r.duracao)) ? Number(r.duracao) : undefined,
    cenas: r.cenas === "auto" ? "auto" : (Number(r.cenas) >= 2 && Number(r.cenas) <= 8 ? Number(r.cenas) : undefined),
    textoNaTela: um(r.textoNaTela, ["sim", "nao"]), observacoes: texto(r.observacoes, 1000) || undefined,
    story: um(r.story, ["imagem", "sequencia", "continuo", "varios"]),
    imagens: um(r.imagens, ["ia", "banco", "misto"]),
    banco: Array.isArray(r.banco) ? r.banco.filter(x => UUID.test(String(x))).slice(0, 20) : undefined,
    pessoa: UUID.test(String(r.pessoa || "")) ? String(r.pessoa) : undefined,
  };
  Object.keys(br).forEach(k => br[k] === undefined && delete br[k]);
  return br;
}
// Modelos do perfil da organização, com os exemplos já como anexos (prévia leve).
async function modelosDaMarca(org, m) {
  const { rows } = await db().query("select id, nome, spec, diag, exemplos, status, erro, criado_em from modelos_marca where org_id = $1 order by criado_em desc", [org]);
  const a = await anexos(org, rows.flatMap(r => r.exemplos || []));
  const lim = await limiteModelos(org);
  return { modelos: rows.map(r => ({ id: r.id, nome: r.nome, spec: r.spec, diag: r.diag || null, status: r.status, erro: r.erro, exemplos: (r.exemplos || []).map(id => a.get(id)).filter(Boolean) })),
    modeloPadrao: (m && m.modelo_padrao) || null, limiteModelos: { usados: rows.length, ...lim } };
}
// Cabe mais um modelo no plano?
async function conferirLimiteModelos(org) {
  const total = (await db().query("select count(*)::int as n from modelos_marca where org_id = $1", [org])).rows[0].n;
  const lim = await limiteModelos(org);
  if (total >= lim.maximo) falha(`O plano ${lim.plano} guarda até ${lim.maximo} modelo${lim.maximo === 1 ? "" : "s"}. Remova um ou mude de plano para salvar mais.`, 402, { plano: true });
}
// Diagramação válida (a mesma da revisão). Num modelo salvo, "escala" é o tamanho do texto de todas as imagens.
function limparDiag(d = {}, { modelo = false } = {}) {
  const um = (v, lista) => (lista.includes(v) ? v : lista[0]);
  const diag = {
    alinhar: um(d.alinhar, ["esquerda", "centro", "direita"]),
    posicao: um(d.posicao, ["auto", "topo", "meio", "base"]),
    ...(d.modelo === "proprio" && UUID.test(String(d.proprio || "")) ? { proprio: String(d.proprio) } : {}),
    modelo: um(d.modelo, ["foto", "video", "proprio", "editorial", "lateral", "impacto", "minimal", "manchete", "cinema", "claro", "escuro"]),
    fonte: um(d.fonte, ["auto", "poppins", "anton", "bebas", "archivo", "playfair", "dmserif"]),
    fundo: um(d.fundo, ["auto", "claro", "escuro", "marca"]),
    v: 3, // versão da diagramação: "auto" no fundo usa o padrão de cada modelo; Reels e Stories têm o modelo "video"
    logo: um(d.logo, ["auto", "light", "dark", "simLight", "simDark", "nenhum"]),
    logoPos: um(d.logoPos, ["te", "tc", "td", "be", "bc", "bd"]),
  };
  // Tamanho do texto por slide ou cena: de 0,6 a 1,6; o 1 (tamanho do modelo) não precisa ser guardado.
  const escalas = {};
  for (const [n, v] of Object.entries(d.escalas && typeof d.escalas === "object" ? d.escalas : {})) {
    const k = parseInt(n, 10), x = Math.round(Number(v) * 100) / 100;
    if (k >= 1 && k <= 20 && x >= 0.6 && x <= 1.6 && x !== 1) escalas[k] = x;
  }
  if (!modelo && Object.keys(escalas).length) diag.escalas = escalas;
  const e = Math.round(Number(d.escala) * 100) / 100;
  if (modelo && e >= 0.6 && e <= 1.6 && e !== 1) diag.escala = e;
  if (diag.modelo === "proprio" && !diag.proprio) diag.modelo = "foto";
  if (modelo && diag.modelo === "video") diag.modelo = "foto";
  return diag;
}
const anexosIds = lista => (Array.isArray(lista) ? lista : []).map(a => a && a.id).filter(id => UUID.test(String(id || "")));

export const acoesPauta = {
  async listar(ctx) {
    const m = (await db().query("select * from marcas where org_id = $1", [ctx.org])).rows[0];
    const fontes = (await db().query("select * from fontes where org_id = $1 order by nome", [ctx.org])).rows;
    return { marca: await marcaParaPainel(m), fontes: fontes.map(fonteParaPainel), ...(await modelosDaMarca(ctx.org, m)) };
  },

  /* ---------- modelos do perfil (a partir dos posts que a marca já publica) ---------- */
  async listarModelos(ctx) {
    const m = (await db().query("select modelo_padrao from marcas where org_id = $1", [ctx.org])).rows[0];
    return modelosDaMarca(ctx.org, m);
  },
  async criarModelo(ctx, b) {
    const instagram = b.instagram === true;
    const imagens = Array.isArray(b.imagens) ? b.imagens.slice(0, 8) : [];
    if (!instagram && imagens.length < 2) falha("Envie pelo menos 2 posts seus (até 8) para a IA entender o estilo.");
    await conferirLimiteModelos(ctx.org);
    if ((await db().query("select 1 from modelos_marca where org_id = $1 and status = 'gerando'", [ctx.org])).rows.length) falha("Já tem um modelo sendo criado. Espere ele ficar pronto.");
    const exemplos = [];
    for (const [k, im] of imagens.entries()) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(im.tipo)) falha("Envie os posts em JPG, PNG ou WEBP.");
      exemplos.push(await salvarArquivo(ctx.org, { tipo: im.tipo, nome: `exemplo-${k + 1}`, dados: doBase64(im.base64, 8 * 1024 * 1024) }));
    }
    const { rows } = await db().query("insert into modelos_marca (org_id, nome, exemplos) values ($1, $2, $3) returning id", [ctx.org, texto(b.nome, 40), exemplos]);
    await enfileirar(ctx.org, "criarModelo", { modelo: rows[0].id, instagram }, ctx.usuario.id);
    return { id: rows[0].id };
  },
  // Modelo montado à mão no editor da marca (sem IA): cria um novo ou atualiza um que já existe.
  async salvarModeloMarca(ctx, b) {
    const diag = limparDiag(b.diagramacao, { modelo: true }), nome = texto(b.nome, 40) || "Modelo da marca";
    if (diag.proprio && !(await db().query("select 1 from modelos_marca where id = $1 and org_id = $2 and spec is not null", [diag.proprio, ctx.org])).rows.length) { delete diag.proprio; diag.modelo = "foto"; }
    if (b.id) {
      const r = await db().query("update modelos_marca set nome = $3, diag = $4 where id = $1 and org_id = $2 and diag is not null returning id", [exigirId(b.id), ctx.org, nome, JSON.stringify(diag)]);
      if (!r.rows.length) falha("Modelo não encontrado.", 404);
      return { id: r.rows[0].id };
    }
    await conferirLimiteModelos(ctx.org);
    const { rows } = await db().query("insert into modelos_marca (org_id, nome, diag, status) values ($1, $2, $3, 'pronto') returning id", [ctx.org, nome, JSON.stringify(diag)]);
    if (b.padrao) await acoesPauta.modeloPadrao(ctx, { id: rows[0].id });
    return { id: rows[0].id };
  },
  async removerModelo(ctx, b) {
    const r = (await db().query("delete from modelos_marca where id = $1 and org_id = $2 returning exemplos", [exigirId(b.id), ctx.org])).rows[0];
    if (!r) falha("Modelo não encontrado.", 404);
    await apagarArquivos(ctx.org, r.exemplos || []);
    return {};
  },
  async modeloPadrao(ctx, b) {
    const id = b.id ? exigirId(b.id) : null;
    if (id && !(await db().query("select 1 from modelos_marca where id = $1 and org_id = $2 and status = 'pronto'", [id, ctx.org])).rows.length) falha("Modelo não encontrado.", 404);
    await db().query("insert into marcas (org_id) values ($1) on conflict (org_id) do nothing", [ctx.org]);
    await db().query("update marcas set modelo_padrao = $2 where org_id = $1", [ctx.org, id]);
    return {};
  },

  async salvarMarca(ctx, b) {
    const c = b.campos || {};
    const map = { Nome: "nome", Posicionamento: "posicionamento", Publico: "publico", TomDeVoz: "tom_de_voz", Evitar: "evitar", ExemplosBons: "exemplos", Cores: "cores", Idioma: "idioma", Perfil: "perfil" };
    const sets = [], vals = [ctx.org];
    const por = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    for (const [k, col] of Object.entries(map)) if (c[k] !== undefined) por(col, texto(c[k], 5000));
    if (c.Pilares !== undefined) por("pilares", (Array.isArray(c.Pilares) ? c.Pilares : []).map(x => texto(x, 300)).filter(Boolean).slice(0, 20));
    if (c.Redes !== undefined) por("redes", (Array.isArray(c.Redes) ? c.Redes : []).map(x => texto(x, 50)).filter(Boolean).slice(0, 10));
    if (c.FrequenciaSemanal !== undefined) por("frequencia_semanal", c.FrequenciaSemanal === null || c.FrequenciaSemanal === "" ? null : Math.max(0, Math.min(50, parseInt(c.FrequenciaSemanal, 10) || 0)));
    const atual = (await db().query("select logos, mood_board from marcas where org_id = $1", [ctx.org])).rows[0] || { logos: {}, mood_board: [] };
    const logos = { ...(atual.logos || {}) };
    let mudouLogos = false;
    for (const k of LOGOS) {
      if (c[k] === undefined) continue;
      const lista = Array.isArray(c[k]) ? c[k] : [];
      const comUrl = lista.find(a => a && typeof a.url === "string" && /^https:\/\//i.test(a.url) && !a.id);
      if (!lista.length) { if (logos[k]) await apagarArquivos(ctx.org, [logos[k]]); delete logos[k]; mudouLogos = true; }
      else if (comUrl) { const novo = await guardarDeUrl(ctx.org, comUrl.url, k); if (logos[k]) await apagarArquivos(ctx.org, [logos[k]]); logos[k] = novo; mudouLogos = true; }
    }
    if (mudouLogos) por("logos", JSON.stringify(logos));
    if (c.MoodBoard !== undefined) {
      const manter = anexosIds(c.MoodBoard).filter(id => (atual.mood_board || []).includes(id));
      await apagarArquivos(ctx.org, (atual.mood_board || []).filter(id => !manter.includes(id)));
      por("mood_board", manter);
    }
    if (!sets.length) falha("Nada para salvar.");
    await db().query(`insert into marcas (org_id) values ($1) on conflict (org_id) do nothing`, [ctx.org]);
    await db().query(`update marcas set ${sets.join(", ")}, atualizado_em = now() where org_id = $1`, vals);
    return { id: ctx.org };
  },

  async enviarArquivoMarca(ctx, b) {
    const campo = b.campo;
    if (![...LOGOS, "MoodBoard"].includes(campo)) falha("Campo inválido.");
    if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(b.tipo)) falha("Envie PNG, JPG, WEBP ou SVG.");
    const id = await salvarArquivo(ctx.org, { tipo: b.tipo, nome: b.nome, dados: doBase64(b.base64, 5 * 1024 * 1024) });
    await db().query(`insert into marcas (org_id) values ($1) on conflict (org_id) do nothing`, [ctx.org]);
    const m = (await db().query("select logos, mood_board from marcas where org_id = $1", [ctx.org])).rows[0];
    if (campo === "MoodBoard") {
      if ((m.mood_board || []).length >= 20) { await apagarArquivos(ctx.org, [id]); falha("O mood board aceita até 20 imagens."); }
      await db().query("update marcas set mood_board = array_append(mood_board, $2::uuid), atualizado_em = now() where org_id = $1", [ctx.org, id]);
    } else {
      const antigo = (m.logos || {})[campo];
      await db().query("update marcas set logos = logos || jsonb_build_object($2::text, $3::text), atualizado_em = now() where org_id = $1", [ctx.org, campo, id]);
      if (antigo) await apagarArquivos(ctx.org, [antigo]);
    }
    return { id };
  },

  /* ---------- pessoas (foto de rosto para posts humanizados) ---------- */
  async listarPessoas(ctx) {
    const { rows } = await db().query("select * from pessoas where org_id = $1 order by criado_em desc", [ctx.org]);
    const a = await anexos(ctx.org, rows.map(r => r.arquivo_id));
    return { pessoas: rows.map(r => ({ id: r.id, nome: r.nome, arquivo: a.get(r.arquivo_id) || null })).filter(x => x.arquivo) };
  },
  async enviarPessoa(ctx, b) {
    if (b.autorizado !== true) falha("Confirme que você tem autorização desta pessoa para usar a imagem dela.");
    if (!["image/png", "image/jpeg", "image/webp"].includes(b.tipo)) falha("Envie a foto em JPG, PNG ou WEBP.");
    const total = (await db().query("select count(*)::int as n from pessoas where org_id = $1", [ctx.org])).rows[0].n;
    if (total >= 30) falha("Cadastre até 30 pessoas. Remova alguma para enviar outra.");
    const arquivo = await salvarArquivo(ctx.org, { tipo: b.tipo, nome: b.nome || "rosto", dados: doBase64(b.base64, 8 * 1024 * 1024) });
    const { rows } = await db().query("insert into pessoas (org_id, arquivo_id, nome, autorizado_por) values ($1, $2, $3, $4) returning id", [ctx.org, arquivo, texto(b.nome, 60), ctx.usuario.id]);
    return { id: rows[0].id };
  },
  async removerPessoa(ctx, b) {
    const r = (await db().query("delete from pessoas where id = $1 and org_id = $2 returning arquivo_id", [exigirId(b.id), ctx.org])).rows[0];
    if (!r) falha("Pessoa não encontrada.", 404);
    await apagarArquivos(ctx.org, [r.arquivo_id]);
    return {};
  },

  /* ---------- banco de imagens ---------- */
  async listarBanco(ctx) {
    const { rows } = await db().query("select * from banco_imagens where org_id = $1 order by criado_em desc", [ctx.org]);
    const a = await anexos(ctx.org, rows.map(r => r.arquivo_id));
    const tarefas = (await db().query("select payload->>'imagem' as id from tarefas where org_id = $1 and tipo = 'descreverImagem' and status in ('pendente', 'rodando')", [ctx.org])).rows.map(r => r.id);
    return { imagens: rows.map(r => ({ id: r.id, nome: r.nome, descricao: r.descricao, tags: r.tags || [], origem: r.origem || "envio", post: r.post_id || null, arquivo: a.get(r.arquivo_id) || null, descrevendo: tarefas.includes(r.id) })).filter(x => x.arquivo) };
  },
  async enviarImagemBanco(ctx, b) {
    if (!["image/png", "image/jpeg", "image/webp", "video/mp4"].includes(b.tipo)) falha("Envie fotos em JPG, PNG ou WEBP, ou vídeos em MP4.");
    const total = (await db().query("select count(*)::int as n from banco_imagens where org_id = $1 and origem = 'envio'", [ctx.org])).rows[0].n;
    if (total >= 300) falha("O banco aceita até 300 arquivos enviados. Remova alguns para enviar novos.");
    const video = b.tipo === "video/mp4";
    const arquivo = await salvarArquivo(ctx.org, { tipo: b.tipo, nome: b.nome, dados: doBase64(b.base64, (video ? 25 : 8) * 1024 * 1024) });
    const nome = texto(b.titulo, 80);
    const { rows } = await db().query("insert into banco_imagens (org_id, arquivo_id, nome) values ($1, $2, $3) returning id", [ctx.org, arquivo, nome]);
    // A IA descreve a foto em segundo plano (nome, descrição e etiquetas). Se não houver chave do Claude, fica para a pessoa preencher.
    if (b.descrever !== false && !video) await enfileirar(ctx.org, "descreverImagem", { imagem: rows[0].id }, ctx.usuario.id);
    return { id: rows[0].id };
  },
  async salvarImagemBanco(ctx, b) {
    const id = exigirId(b.id);
    const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(",")).map(t => texto(t, 30)).filter(Boolean).slice(0, 8);
    const r = await db().query("update banco_imagens set nome = $3, descricao = $4, tags = $5 where id = $1 and org_id = $2", [id, ctx.org, texto(b.nome, 80), texto(b.descricao, 400), tags]);
    if (!r.rowCount) falha("Foto não encontrada.", 404);
    return {};
  },
  async removerImagemBanco(ctx, b) {
    const id = exigirId(b.id);
    const r = (await db().query("delete from banco_imagens where id = $1 and org_id = $2 returning arquivo_id", [id, ctx.org])).rows[0];
    if (!r) falha("Foto não encontrada.", 404);
    // O arquivo só some se nenhum post estiver usando a foto.
    const emUso = (await db().query("select 1 from posts where org_id = $1 and (exists (select 1 from jsonb_each_text(fotos) f where f.value = $2::text) or exists (select 1 from jsonb_each_text(clipes) c where c.value = $2::text)) limit 1", [ctx.org, r.arquivo_id])).rows.length;
    if (!emUso) await apagarArquivos(ctx.org, [r.arquivo_id]);
    return {};
  },
  // Troca a foto de um slide por uma do banco, sem IA.
  async trocarFotoSlide(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    if (["Publicando", "Publicado"].includes(p.status)) falha("Este post já foi publicado.");
    const n = parseInt(b.slide, 10); if (!(n >= 1 && n <= 20)) falha("Slide inválido.");
    const img = (await db().query("select b.arquivo_id, a.tipo from banco_imagens b join arquivos a on a.id = b.arquivo_id where b.id = $1 and b.org_id = $2", [exigirId(b.imagem), ctx.org])).rows[0];
    if (!img) falha("Foto não encontrada no banco.", 404);
    const video = /^video\//.test(img.tipo);
    const fotos = { ...(p.fotos || {}) }, clipes = { ...(p.clipes || {}) }, mapa = video ? clipes : fotos, outro = video ? fotos : clipes;
    // Cada slide tem uma mídia só: trocar por vídeo tira a foto (e vice-versa), senão a antiga continua valendo.
    const antigas = [mapa[n], outro[n]].filter(x => x && x !== img.arquivo_id);
    mapa[n] = img.arquivo_id; delete outro[n];
    const marcar = lista => (Array.isArray(lista) ? lista : []).map((s, i) => ((Number(s.n) || i + 1) === n ? { ...s, ...(video ? { usa_video: true } : { usa_imagem: true }) } : s));
    const conteudo = { ...(p.conteudo || {}) };
    for (const k of ["slides", "cenas"]) if (Array.isArray(conteudo[k])) conteudo[k] = marcar(conteudo[k]);
    await db().query("update posts set fotos = $2, clipes = $3, slides = $4, conteudo = $5, artes_prontas = false, atualizado_em = now() where id = $1",
      [p.id, JSON.stringify(fotos), JSON.stringify(clipes), JSON.stringify(marcar(p.slides)), JSON.stringify(conteudo)]);
    // Só apaga o que nenhuma outra tela do post usa mais.
    const emUso = new Set([...Object.values(fotos), ...Object.values(clipes), ...(p.artes || [])]);
    const soltas = antigas.filter(x => !emUso.has(x));
    if (soltas.length) await apagarArquivos(ctx.org, soltas);
    return {};
  },

  async salvarFonte(ctx, b) {
    const c = b.campos || {};
    const cols = { Nome: "nome", Tipo: "tipo", Categoria: "categoria", Rede: "rede", URL: "url" };
    const dados = {};
    for (const [k, col] of Object.entries(cols)) if (c[k] !== undefined) dados[col] = c[k] === null ? null : texto(c[k], 500);
    if (c.Peso !== undefined) dados.peso = Math.max(1, Math.min(5, parseInt(c.Peso, 10) || 3));
    if (c.Ativa !== undefined) dados.ativa = !!c.Ativa;
    if (b.id) {
      const id = exigirId(b.id);
      const chaves = Object.keys(dados);
      if (!chaves.length) falha("Nada para salvar.");
      const r = await db().query(`update fontes set ${chaves.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and org_id = $2`, [id, ctx.org, ...chaves.map(k => dados[k])]);
      if (!r.rowCount) falha("Fonte não encontrada.", 404);
      return { id };
    }
    if (!dados.nome) falha("Preencha o nome da fonte.");
    const chaves = Object.keys(dados);
    const r = await db().query(`insert into fontes (org_id, ${chaves.join(", ")}) values ($1, ${chaves.map((_, i) => `$${i + 2}`).join(", ")}) returning id`, [ctx.org, ...chaves.map(k => dados[k])]);
    return { id: r.rows[0].id };
  },

  async removerFonte(ctx, b) {
    await db().query("delete from fontes where id = $1 and org_id = $2", [exigirId(b.id), ctx.org]);
    return {};
  },

  async pauta(ctx) {
    const ideias = (await db().query("select * from ideias where org_id = $1 and criada_em > now() - interval '90 days' order by score desc limit 300", [ctx.org])).rows;
    const posts = (await db().query("select * from posts where org_id = $1 and data_publicacao > now() - interval '60 days' order by data_publicacao limit 500", [ctx.org])).rows;
    const porIdeia = {};
    for (const p of posts) if (p.ideia_id) (porIdeia[p.ideia_id] ||= []).push(p.id);
    const tarefas = (await db().query("select id, tipo, status, payload - 'token' as payload, erro, criado_em, terminado_em from tarefas where org_id = $1 and criado_em > now() - interval '1 day' order by criado_em desc limit 30", [ctx.org])).rows;
    return { ideias: ideias.map(i => ideiaParaPainel(i, porIdeia[i.id] || [])), posts: await postsParaPainel(ctx.org, posts), tarefas };
  },

  async salvarIdeia(ctx, b) {
    const c = b.campos || {};
    const id = exigirId(b.id);
    if (c.Status !== undefined && !STATUS_IDEIA.includes(c.Status)) falha("Status inválido.");
    const r = await db().query(
      "update ideias set status = coalesce($3, status), motivo_descarte = coalesce($4, motivo_descarte) where id = $1 and org_id = $2",
      [id, ctx.org, c.Status ?? null, c.MotivoDescarte === undefined ? null : texto(c.MotivoDescarte, 500)]);
    if (!r.rowCount) falha("Ideia não encontrada.", 404);
    return {};
  },

  async agendarIdeia(ctx, b) {
    const id = exigirId(b.id);
    const i = (await db().query("select * from ideias where id = $1 and org_id = $2", [id, ctx.org])).rows[0];
    if (!i) falha("Ideia não encontrada.", 404);
    const quando = Date.parse(b.data || "");
    if (!quando) falha("Escolha a data e o horário.");
    if (quando < Date.now() + 10 * 60000) falha("Escolha uma data e um horário no futuro.");
    const post = await db().transacao(async tx => {
      const p = (await tx.query(
        "insert into posts (org_id, ideia_id, titulo, data_publicacao, rede, formato, pilar) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [ctx.org, id, i.titulo, new Date(quando), i.rede, i.formato, i.pilar])).rows[0].id;
      await tx.query("update ideias set status = 'Aprovada' where id = $1", [id]);
      return p;
    });
    return { id: post };
  },

  async reagendarPost(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    const quando = Date.parse(b.data || "");
    if (!quando || quando < Date.now() + 10 * 60000) falha("Escolha uma data e um horário no futuro.");
    if (p.status === "Publicado") falha("Este post já foi publicado.");
    await db().query("update posts set data_publicacao = $2, atualizado_em = now() where id = $1", [p.id, new Date(quando)]);
    return {};
  },

  async removerPost(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    if (p.status === "Publicado") falha("Post publicado não sai do calendário.");
    if (p.status === "Publicando") falha("Este post está sendo publicado agora. Espere terminar.");
    await db().transacao(async tx => {
      if (p.ideia_id) await tx.query("update ideias set status = 'Guardada' where id = $1 and org_id = $2", [p.ideia_id, ctx.org]);
      await tx.query("delete from posts where id = $1", [p.id]);
    });
    await apagarArquivos(ctx.org, [...Object.values(p.fotos || {}), ...Object.values(p.clipes || {}), ...(p.artes || [])]);
    return {};
  },

  async salvarArtes(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    if (["Publicando", "Publicado"].includes(p.status)) falha("Este post já foi publicado ou está sendo publicado.");
    const artes = Array.isArray(b.artes) ? b.artes : [];
    if (!artes.length || artes.length > 10) falha("Envie de 1 a 10 artes.");
    const ids = [];
    try {
      for (let i = 0; i < artes.length; i++) {
        const a = artes[i];
        const tipo = ["image/png", "video/mp4"].includes(a.tipo) ? a.tipo : "image/jpeg";
        const ext = { "image/png": ".png", "video/mp4": ".mp4", "image/jpeg": ".jpg" }[tipo];
        ids.push(await salvarArquivo(ctx.org, { tipo, nome: (artes.length === 1 && tipo === "video/mp4" ? "video" : "slide-" + String(i + 1).padStart(2, "0")) + ext, dados: doBase64(a.base64) }));
      }
    } catch (e) { await apagarArquivos(ctx.org, ids); throw e; }
    await db().query("update posts set artes = $2, artes_prontas = true, atualizado_em = now() where id = $1", [p.id, ids]);
    await apagarArquivos(ctx.org, p.artes || []);
    return { enviadas: ids.length };
  },

  async salvarDiagramacao(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    const diag = limparDiag(b.diagramacao);
    await db().query("update posts set diagramacao = $2, artes_prontas = case when $3 then false else artes_prontas end, atualizado_em = now() where id = $1", [p.id, JSON.stringify(diag), !!b.refazer]);
    return {};
  },

  async aprovarPost(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    if (!["EmRevisao"].includes(p.status)) falha("Este post não está esperando revisão.");
    if (!p.artes_prontas) falha(["Reels", "Stories"].includes(p.formato) ? "Gere o vídeo final antes de aprovar." : "Gere as artes finais antes de aprovar.");
    if (new Date(p.data_publicacao) < new Date()) falha("A data de publicação já passou. Mude a data antes de aprovar.");
    await db().query("update posts set status = 'Agendado', erro = null, atualizado_em = now() where id = $1", [p.id]);
    await db().query("insert into revisoes (org_id, post_id, versao, decisao, usuario_id) values ($1, $2, $3, 'Aprovado', $4)", [ctx.org, p.id, p.versao, ctx.usuario.id]);
    return {};
  },

  // Textos editados no painel depois do post pronto. Mantém os outros campos de cada slide (prompt, usa_imagem...).
  async salvarTextos(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    if (!["EmRevisao", "Agendado", "Erro"].includes(p.status)) falha("Este post não pode ser editado agora.");
    const novos = Array.isArray(b.slides) ? b.slides.slice(0, 12) : [];
    if (!novos.length) falha("Slides inválidos.");
    const atuais = Array.isArray(p.slides) ? p.slides : [];
    const slides = novos.map((n, i) => {
      const num = Number(n && n.n) || i + 1;
      const velho = atuais.find((x, k) => (Number(x.n) || k + 1) === num) || { n: num };
      return { ...velho, titulo: texto(n && n.titulo, 300), texto: texto(n && n.texto, 1500) };
    });
    const legenda = texto(b.legenda, 2200), hashtags = texto(b.hashtags, 600);
    // Reels e stories em vídeo guardam o roteiro em "cenas"; o resto, em "slides".
    const emCenas = ["Reels", "Stories"].includes(p.formato) && !(p.briefing && ["imagem", "sequencia"].includes(p.briefing.story));
    const conteudo = { ...(p.conteudo || {}), [emCenas ? "cenas" : "slides"]: slides, legenda, hashtags: hashtags.split(/\s+/).filter(Boolean) };
    await db().query("update posts set slides = $2, legenda = $3, hashtags = $4, conteudo = $5, artes_prontas = false, atualizado_em = now() where id = $1",
      [p.id, JSON.stringify(slides), legenda, hashtags, JSON.stringify(conteudo)]);
    return {};
  },

  // Redes onde o post vai ser publicado.
  async salvarRedes(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    if (["Publicando", "Publicado"].includes(p.status)) falha("Este post já foi publicado.");
    const redes = [...new Set((Array.isArray(b.redes) ? b.redes : []).filter(r => REDES_PUBLICACAO.includes(r)))];
    if (!redes.length) falha("Escolha pelo menos uma rede.");
    await db().query("update posts set redes = $2, atualizado_em = now() where id = $1", [p.id, redes]);
    return { redes };
  },
  // Opções de publicação: Reels de teste no Instagram (só para quem não segue; "MANUAL" ou "SS_PERFORMANCE" = compartilha
  // sozinho com os seguidores se for bem) e o selo de conteúdo feito com IA.
  async salvarPublicacao(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    if (["Publicando", "Publicado"].includes(p.status)) falha("Este post já foi publicado.");
    const pub = { ...(p.publicacao || {}) };
    if (b.reelTeste !== undefined) { if (["MANUAL", "SS_PERFORMANCE"].includes(b.reelTeste)) pub.reelTeste = b.reelTeste; else delete pub.reelTeste; }
    if (b.conteudoIa !== undefined) pub.conteudoIa = !!b.conteudoIa;
    await db().query("update posts set publicacao = $2, atualizado_em = now() where id = $1", [p.id, JSON.stringify(pub)]);
    return { publicacao: pub };
  },
  // Redes com conta conectada no Zernio da organização (o painel mostra só o que dá para usar).
  async redesConectadas(ctx) { return { redes: await redesConectadas(ctx.org) }; },

  async ajustarPost(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    const comentario = texto(b.comentario, 2000);
    if (!comentario) falha("Escreva o que você quer mudar.");
    if (!["EmRevisao", "Agendado"].includes(p.status)) falha("Este post não está em revisão.");
    if (p.versao - 1 >= LIMITE_AJUSTES) falha(`Este post já teve ${p.versao - 1} ajustes. Remova do calendário e agende a ideia de novo para refazer do zero.`);
    await db().query("update posts set status = 'Ajustes', historico_ajustes = trim(historico_ajustes || E'\\n' || $2), atualizado_em = now() where id = $1", [p.id, `v${p.versao}: ${comentario}`]);
    await db().query("insert into revisoes (org_id, post_id, versao, decisao, comentario, usuario_id) values ($1, $2, $3, 'PediuAjuste', $4, $5)", [ctx.org, p.id, p.versao, comentario, ctx.usuario.id]);
    // Ajuste em um slide só: o trabalho garante que os outros slides, a legenda e as hashtags não mudam.
    const slide = Math.max(0, Math.min(20, parseInt(b.slide, 10) || 0));
    await enfileirar(ctx.org, "ajustar", { post: p.id, comentario, slide, novaImagem: !!b.novaImagem }, ctx.usuario.id);
    return {};
  },

  async buscarIdeias(ctx, b) {
    const rodando = await db().query("select 1 from tarefas where org_id = $1 and tipo = 'ideias' and status in ('pendente', 'rodando')", [ctx.org]);
    if (rodando.rows.length) falha("Já estou buscando ideias para esta organização. Aguarde terminar.");
    // Pedido opcional do painel: tema, quantas ideias e quais formatos.
    const FORMATOS = ["Reels", "Carrossel", "Estatico", "Stories"];
    const pedido = {
      tema: texto(b.tema, 300),
      quantidade: Math.max(1, Math.min(20, parseInt(b.quantidade, 10) || 10)),
      formatos: (Array.isArray(b.formatos) ? b.formatos : []).filter(f => FORMATOS.includes(f)),
    };
    await usar(ctx.org, "ideias");
    try { await enfileirar(ctx.org, "ideias", pedido, ctx.usuario.id); } catch (e) { await devolver(ctx.org, "ideias"); throw e; }
    return {};
  },

  async publicarAgora(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    if (p.status !== "Agendado") falha("Só posts agendados podem ser publicados agora.");
    if (!p.artes_prontas) falha("Gere as artes finais antes de publicar.");
    if (!(await publicarJa(ctx.org, p.id))) falha("Este post já está sendo publicado.");
    return {};
  },

  // Traz marca, fontes, ideias e calendário de uma base do Airtable. O token não fica salvo.
  async importarAirtable(ctx, b) {
    if (!podeGerir(ctx.papel)) falha("Só donos e administradores podem importar.", 403);
    const base = texto(b.base, 30), token = String(b.token || "").trim();
    if (!/^app[A-Za-z0-9]{14}$/.test(base)) falha("O ID da base começa com app e tem 17 caracteres.");
    if (token.length < 20 || /\s/.test(token)) falha("Cole o token do Airtable inteiro.");
    const rodando = await db().query("select 1 from tarefas where org_id = $1 and tipo = 'importar' and status in ('pendente', 'rodando')", [ctx.org]);
    if (rodando.rows.length) falha("Já tem uma importação em andamento.");
    await enfileirar(ctx.org, "importar", { token: cifrar(token), base }, ctx.usuario.id);
    return {};
  },

  // Botão "IA escolhe" no briefing: a IA marca no banco as fotos e vídeos que têm a ver com o post. Não conta como post do plano.
  async escolherBanco(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    const total = (await db().query("select count(*)::int as n from banco_imagens where org_id = $1", [ctx.org])).rows[0].n;
    if (!total) falha("O banco de imagens está vazio. Envie fotos em Banco de imagens e vídeos.");
    return await escolherDoBanco(ctx.org, p, limparBriefing(b.briefing));
  },

  async criarPost(ctx, b) {
    const p = await postDaOrg(ctx.org, b.id);
    if (!["Planejado", "Erro"].includes(p.status)) falha("Este post já foi criado.");
    const br = limparBriefing(b.briefing);
    if (br.pessoa) {
      const pe = (await db().query("select nome from pessoas where id = $1 and org_id = $2", [br.pessoa, ctx.org])).rows[0];
      if (!pe) falha("Essa pessoa não está mais cadastrada. Escolha outra ou envie a foto de novo.");
      if (pe.nome) br.pessoaNome = pe.nome;
    }
    // Marca "EmCriacao" antes de cobrar: um clique duplo (ou duas abas) não cria nem cobra duas vezes.
    const tomou = await db().query("update posts set status = 'EmCriacao', erro = null, briefing = $2, atualizado_em = now() where id = $1 and status in ('Planejado', 'Erro') returning id", [p.id, Object.keys(br).length ? JSON.stringify(br) : null]);
    if (!tomou.rows.length) falha("Este post já está sendo criado.");
    const voltar = () => db().query("update posts set status = $2 where id = $1 and status = 'EmCriacao'", [p.id, p.status]);
    try { await usar(ctx.org, "post"); } catch (e) { await voltar(); throw e; }
    try { await enfileirar(ctx.org, "criar", { post: p.id }, ctx.usuario.id); } catch (e) { await devolver(ctx.org, "post"); await voltar(); throw e; }
    return {};
  },
};
