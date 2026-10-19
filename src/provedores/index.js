// Chamadas às APIs externas, sempre com a chave da organização (decifrada só na hora do uso).
import { db } from "../db.js";
import { decifrar } from "../cripto.js";
import { config } from "../config.js";
import { situacao, cobrancaLigada } from "../planos.js";

export class ErroIntegracao extends Error {}
const NOMES = { anthropic: "Claude", magnific: "Magnific", apify: "Apify", zernio: "Zernio" };

export async function chaveDe(org, provedor) {
  const r = (await db().query("select valor_cifrado from integracoes where org_id = $1 and provedor = $2", [org, provedor])).rows[0];
  if (!r) {
    // Planos pagos incluem a IA: sem chave própria, usa a da plataforma (PLATAFORMA_ANTHROPIC, _MAGNIFIC, _APIFY).
    // O Zernio nunca por aqui: a chave da plataforma só é usada por zernioDe, sempre presa ao profile da organização.
    const daPlataforma = provedor === "zernio" ? null : process.env["PLATAFORMA_" + provedor.toUpperCase()];
    if (daPlataforma && cobrancaLigada()) { const s = await situacao(org); if (s.ativo) return daPlataforma; }
  }
  if (!r) throw new ErroIntegracao(`A chave do ${NOMES[provedor]} não está cadastrada. Cadastre em Integrações.`);
  return decifrar(r.valor_cifrado);
}

// Guarda o que cada chamada de IA consumiu (relatório de controle). Uma falha aqui nunca derruba a tarefa.
export async function registrarConsumo(org, provedor, d) {
  try {
    const propria = (await db().query("select 1 from integracoes where org_id = $1 and provedor = $2", [org, provedor])).rows.length > 0;
    await db().query("insert into consumo (org_id, provedor, tipo, entrada, saida, cache_leitura, cache_escrita, quantidade, chave_propria) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [org, provedor, d.tipo || "", d.entrada || 0, d.saida || 0, d.cacheLeitura || 0, d.cacheEscrita || 0, d.quantidade || 0, propria]);
  } catch (e) { console.error("[consumo]", e.message); }
}

async function pedir(url, opcoes, tempoMs = 120000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), tempoMs);
  try {
    const r = await fetch(url, { ...opcoes, signal: ctl.signal });
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch (e) {}
    return { status: r.status, ok: r.ok, json, txt };
  } finally { clearTimeout(t); }
}
const esperar = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Claude ---------- */
export async function claude(org, { system, content, effort = "medium", max_tokens = 16000, tipo = "" }) {
  const chave = await chaveDe(org, "anthropic");
  const r = await pedir("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": chave, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" },
    body: JSON.stringify({ model: config.modeloClaude, max_tokens, output_config: { effort }, fallbacks: "default", system, messages: [{ role: "user", content }] }),
  }, 600000);
  const j = r.json || {};
  const u = j.usage || {};
  if (r.ok && j.type !== "error") await registrarConsumo(org, "anthropic", { tipo, entrada: u.input_tokens, saida: u.output_tokens, cacheLeitura: u.cache_read_input_tokens, cacheEscrita: u.cache_creation_input_tokens, quantidade: 1 });
  if (!r.ok || j.type === "error") throw new ErroIntegracao("falha na API do Claude: " + String((j.error && j.error.message) || r.txt).slice(0, 300));
  if (j.stop_reason === "refusal") throw new ErroIntegracao("o Claude recusou o pedido");
  if (j.stop_reason === "max_tokens") throw new ErroIntegracao("a resposta ficou longa demais e foi cortada");
  const txt = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const dados = extrairJson(txt);
  if (!dados) throw new ErroIntegracao("a resposta do Claude não veio em JSON");
  return dados;
}
// Lê o JSON da resposta mesmo com texto antes ou depois, ou com o conteúdo dividido em vários objetos
// (as listas de cada um são juntadas; nos outros campos vale o primeiro objeto).
export function extrairJson(txt) {
  const objetos = [];
  for (let i = 0; i < txt.length; i++) {
    if (txt[i] !== "{") continue;
    let nivel = 0, aspas = false, escape = false, fim = -1;
    for (let k = i; k < txt.length; k++) {
      const c = txt[k];
      if (aspas) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === '"') aspas = false; continue; }
      if (c === '"') aspas = true;
      else if (c === "{") nivel++;
      else if (c === "}" && --nivel === 0) { fim = k; break; }
    }
    if (fim < 0) break;
    try { const o = JSON.parse(txt.slice(i, fim + 1)); if (o && typeof o === "object" && !Array.isArray(o)) { objetos.push(o); i = fim; } } catch (e) {}
  }
  if (!objetos.length) return null;
  const junto = { ...objetos[0] };
  for (const o of objetos.slice(1)) for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(junto[k]) && Array.isArray(v)) junto[k] = junto[k].concat(v);
    else if (!(k in junto)) junto[k] = v;
  }
  return junto;
}

/* ---------- Magnific (fotos Mystic e clipes Kling 3) ---------- */
const MAGNIFIC = "https://api.freepik.com";
async function tarefaMagnific(org, criar, ver, corpo, { intervalo = 15000, limiteMs = 40 * 60000 } = {}) {
  const chave = await chaveDe(org, "magnific");
  const h = { "content-type": "application/json", "x-freepik-api-key": chave };
  let r = await pedir(MAGNIFIC + criar, { method: "POST", headers: h, body: JSON.stringify(corpo) });
  if (r.status === 503) { await esperar(5000); r = await pedir(MAGNIFIC + criar, { method: "POST", headers: h, body: JSON.stringify(corpo) }); }
  const id = r.json && r.json.data && r.json.data.task_id;
  if (!r.ok || !id) throw new ErroIntegracao("o Magnific recusou o pedido: " + String((r.json && (r.json.message || JSON.stringify(r.json.invalid_params || ""))) || r.txt).slice(0, 300));
  intervalo = Number(process.env.MAGNIFIC_INTERVALO_MS) || intervalo; // os testes encurtam a espera
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    await esperar(intervalo);
    const v = await pedir(`${MAGNIFIC}${ver}/${id}`, { headers: h });
    const d = (v.json && v.json.data) || {};
    if (d.status === "COMPLETED") { const url = (d.generated || [])[0]; if (!url) throw new ErroIntegracao("o Magnific terminou sem arquivo"); return url; }
    if (d.status === "FAILED") throw new ErroIntegracao("o Magnific não conseguiu gerar este item");
  }
  throw new ErroIntegracao("o Magnific demorou demais");
}
const PROPORCAO = { "4:5": "social_post_4_5", "1:1": "square_1_1", "9:16": "social_story_9_16", "16:9": "widescreen_16_9" };
export const gerarFoto = (org, prompt, proporcao) =>
  tarefaMagnific(org, "/v1/ai/mystic", "/v1/ai/mystic", { prompt, aspect_ratio: PROPORCAO[proporcao] || "social_post_4_5" }, { intervalo: 10000, limiteMs: 15 * 60000 })
    .then(async url => { await registrarConsumo(org, "magnific", { tipo: "foto", quantidade: 1 }); return url; });
// Foto com uma pessoa real: o Seedream 4.5 Edit recebe a foto de rosto como referência e põe a pessoa na cena do prompt.
const PROPORCAO_SEEDREAM = { "4:5": "traditional_3_4", "1:1": "square_1_1", "9:16": "social_story_9_16", "16:9": "widescreen_16_9" };
export async function gerarFotoComPessoa(org, prompt, proporcao, rosto) {
  const corpo = { prompt, reference_images: [rosto], aspect_ratio: PROPORCAO_SEEDREAM[proporcao] || "traditional_3_4", enable_safety_checker: true };
  const ir = c => tarefaMagnific(org, "/v1/ai/text-to-image/seedream-v4-5-edit", "/v1/ai/text-to-image/seedream-v4-5-edit", c, { intervalo: 10000, limiteMs: 15 * 60000 });
  try { const url = await ir(corpo); await registrarConsumo(org, "magnific", { tipo: "foto_pessoa", quantidade: 1 }); return url; }
  catch (e) {
    // Se o Magnific não aceitar a proporção, gera na proporção padrão (a arte recorta depois).
    if (e instanceof ErroIntegracao && /aspect/i.test(e.message)) { delete corpo.aspect_ratio; const url = await ir(corpo); await registrarConsumo(org, "magnific", { tipo: "foto_pessoa", quantidade: 1 }); return url; }
    throw e;
  }
}
export async function gerarClipe(org, { prompt, duracao, proporcao, imagem }) {
  const segundos = Math.min(10, Math.max(3, Math.round(Number(duracao) || 5)));
  const url = await tarefaMagnific(org, "/v1/ai/video/kling-v3-std", "/v1/ai/video/kling-v3",
    Object.assign({ prompt, duration: String(segundos), aspect_ratio: proporcao, generate_audio: false, cfg_scale: 0.5 }, imagem ? { start_image_url: imagem } : {}),
    { intervalo: 20000 });
  await registrarConsumo(org, "magnific", { tipo: "clipe", quantidade: segundos }); // quantidade = segundos de vídeo
  return url;
}

/* ---------- Apify (coleta das fontes) ---------- */
export async function coletarApify(org, actor, input) {
  const chave = await chaveDe(org, "apify");
  const r = await pedir(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${chave}` }, body: JSON.stringify(input),
  }, 300000);
  if (!r.ok) throw new ErroIntegracao("a Apify recusou a coleta: " + String((r.json && r.json.error && r.json.error.message) || r.txt).slice(0, 200));
  const itens = Array.isArray(r.json) ? r.json : [];
  await registrarConsumo(org, "apify", { tipo: "coleta", quantidade: itens.length });
  return itens;
}

/* ---------- Zernio (publicação) ---------- */
const ZERNIO = "https://zernio.com/api/v1";
// Nomes do painel para as plataformas do Zernio.
const NOMES_REDE = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", twitter: "X", threads: "Threads", linkedin: "LinkedIn", youtube: "YouTube" };
// Redes que o cliente conecta pelo painel (nome do painel → plataforma do Zernio).
export const REDES_CONECTAVEIS = { Instagram: "instagram", Facebook: "facebook", TikTok: "tiktok", X: "twitter", Threads: "threads" };

// Com que conta do Zernio a organização publica:
// - chave própria cadastrada em Integrações: a conta Zernio do cliente, com todas as contas dela;
// - senão, a conta da plataforma (PLATAFORMA_ZERNIO), só para planos ativos e só com as contas do profile da organização.
// A chave da plataforma nunca sai daqui sem o profile; sem profile, nada é listado nem publicado.
export async function zernioDe(org) {
  const propria = (await db().query("select 1 from integracoes where org_id = $1 and provedor = 'zernio'", [org])).rows.length > 0;
  if (propria) return { modo: "propria", chave: await chaveDe(org, "zernio"), perfil: null };
  const daPlataforma = process.env.PLATAFORMA_ZERNIO;
  if (!daPlataforma || !cobrancaLigada()) throw new ErroIntegracao("A chave do Zernio não está cadastrada. Cadastre em Integrações.");
  if (!(await situacao(org)).ativo) throw new ErroIntegracao("Seu plano não está ativo. Renove para publicar nas redes conectadas.");
  const perfil = (await db().query("select zernio_profile from organizacoes where id = $1", [org])).rows[0]?.zernio_profile || null;
  return { modo: "plataforma", chave: daPlataforma, perfil };
}
const cabecalho = z => ({ authorization: `Bearer ${z.chave}` });
const motivoZernio = r => String((r.json && (r.json.error || r.json.message)) || r.txt || r.status).slice(0, 300);
const perfilDaConta = c => String((c.profileId && c.profileId._id) || c.profileId || "");
// Contas que a organização pode usar. No modo plataforma, só as do profile dela: filtradas no pedido e conferidas aqui de novo.
async function contasZernio(z) {
  if (z.modo === "plataforma" && !z.perfil) return { ok: true, status: 200, contas: [] };
  const r = await pedir(`${ZERNIO}/accounts${z.perfil ? "?profileId=" + encodeURIComponent(z.perfil) : ""}`, { headers: cabecalho(z) });
  if (!r.ok) return { ok: false, status: r.status, contas: [] };
  const todas = (r.json && r.json.accounts) || [];
  return { ok: true, status: r.status, contas: z.perfil ? todas.filter(c => perfilDaConta(c) === z.perfil) : todas };
}
export async function redesConectadas(org) {
  let z; try { z = await zernioDe(org); } catch (e) { return null; }
  const r = await contasZernio(z);
  if (!r.ok) return null;
  return [...new Set(r.contas.filter(c => c.isActive !== false).map(c => NOMES_REDE[c.platform]).filter(Boolean))];
}
// Lista da seção "Redes conectadas" do painel. modo null = a organização ainda não tem como publicar.
export async function contasConectadas(org) {
  let z; try { z = await zernioDe(org); } catch (e) { return { modo: null, contas: [], aviso: e.message }; }
  const r = await contasZernio(z);
  if (!r.ok) return { modo: z.modo, contas: [], aviso: z.modo === "propria" ? "O Zernio recusou a chave. Confira em Integrações." : "Não consegui falar com o Zernio agora." };
  const contas = r.contas.filter(c => NOMES_REDE[c.platform]).map(c => ({
    id: c._id, rede: NOMES_REDE[c.platform], usuario: c.username || "", nome: c.displayName || "",
    ativa: c.isActive !== false, reconectar: !!c.needsReconnection,
  }));
  return { modo: z.modo, contas };
}
// Cria o profile da organização na conta da plataforma (externalId = id da organização) e guarda o id.
async function criarPerfil(org, z) {
  const nome = (await db().query("select nome from organizacoes where id = $1", [org])).rows[0].nome;
  const r = await pedir(`${ZERNIO}/profiles`, {
    method: "POST", headers: { ...cabecalho(z), "content-type": "application/json", "idempotency-key": "content-post-org-" + org },
    body: JSON.stringify({ name: `${String(nome).slice(0, 60)} · ${org.slice(0, 8)}`, description: "Content Post", externalId: org }),
  });
  let id = r.json && r.json.profile && r.json.profile._id;
  if (!id && (r.status === 409 || r.status === 422)) {
    // Já existe (uma tentativa anterior criou): acha pelo externalId.
    const l = await pedir(`${ZERNIO}/profiles?externalId=${encodeURIComponent(org)}`, { headers: cabecalho(z) });
    id = (((l.json && l.json.profiles) || []).find(p => p.externalId === org) || {})._id;
  }
  if (!id) throw new ErroIntegracao("Não consegui preparar a conexão no Zernio: " + motivoZernio(r));
  // Se duas pessoas conectarem ao mesmo tempo, vale o primeiro profile gravado.
  await db().query("update organizacoes set zernio_profile = $2 where id = $1 and zernio_profile is null", [org, String(id)]);
  return (await db().query("select zernio_profile from organizacoes where id = $1", [org])).rows[0].zernio_profile;
}
const SO_PELA_PROPRIA = "Esta organização publica pela própria conta do Zernio: conecte e desconecte as redes em zernio.com. Para fazer por aqui, remova a chave do Zernio em Integrações.";
// Link para o cliente autorizar uma rede; a conta conectada entra no profile da organização.
export async function linkConexao(org, nomeRede, voltar) {
  const plataforma = REDES_CONECTAVEIS[nomeRede];
  if (!plataforma) throw new ErroIntegracao("Rede desconhecida.");
  const z = await zernioDe(org);
  if (z.modo !== "plataforma") throw new ErroIntegracao(SO_PELA_PROPRIA);
  const perfil = z.perfil || await criarPerfil(org, z);
  // Pede só a permissão de publicar: a tela de autorização da rede mostra uma lista menor.
  const q = new URLSearchParams({ profileId: perfil, scopes: "posting" });
  if (voltar) q.set("redirect_url", voltar);
  const r = await pedir(`${ZERNIO}/connect/${plataforma}?${q}`, { headers: cabecalho(z) });
  const url = r.json && r.json.authUrl;
  if (!r.ok || !/^https:\/\//.test(url || "")) throw new ErroIntegracao(`O Zernio não abriu a conexão com o ${nomeRede}: ${motivoZernio(r)}`);
  return url;
}
export async function desconectarConta(org, id) {
  const z = await zernioDe(org);
  if (z.modo !== "plataforma") throw new ErroIntegracao(SO_PELA_PROPRIA);
  const { contas } = await contasZernio(z);
  if (!contas.some(c => c._id === id)) throw new ErroIntegracao("Esta conta não está conectada nesta organização.");
  const r = await pedir(`${ZERNIO}/accounts/${encodeURIComponent(id)}`, { method: "DELETE", headers: cabecalho(z) });
  if (!r.ok && r.status !== 404) throw new ErroIntegracao("O Zernio não desconectou a conta: " + motivoZernio(r));
}
// Publica na hora: acha a conta da rede, cria o post com publishNow e acompanha até publicar ou falhar.
// idExistente: post já criado no Zernio numa tentativa anterior (só confere o resultado, não cria outro).
// aoCriar(id): chamado assim que o Zernio aceita o post, para guardar o id antes de esperar a confirmação.
export async function publicarZernio(org, { rede, midias, legenda, opcoes, chave: idPedido, idExistente = null, aoCriar = null }) {
  const z = await zernioDe(org);
  const h = { "content-type": "application/json", ...cabecalho(z) };
  const contas = await contasZernio(z);
  if (contas.status === 401 || contas.status === 403) return { ok: false, erro: z.modo === "propria" ? "o Zernio recusou a chave. Confira em Integrações." : "o Zernio recusou o pedido da plataforma. Avise o suporte." };
  const conta = contas.contas.find(c => c.platform === rede && c.isActive !== false);
  if (!conta) return { ok: false, erro: z.modo === "plataforma" ? `nenhuma conta de ${NOMES_REDE[rede] || rede || "rede"} conectada. Conecte em Integrações › Redes conectadas` : `nenhuma conta de ${rede || "rede"} conectada no Zernio` };
  if (!midias.length) return { ok: false, erro: "o post não tem artes finais" };
  const ler = j => { const post = (j && j.post) || {}; const p = (post.platforms || [])[0] || {}; return { post, p }; };
  let post, p;
  if (idExistente) {
    ({ post, p } = ler((await pedir(`${ZERNIO}/posts/${idExistente}`, { headers: h })).json));
    if (!post._id) return { ok: false, erro: "não achei no Zernio o post enviado antes", sumiu: true };
  } else {
    const destino = { platform: rede, accountId: conta._id };
    if (opcoes) destino.platformSpecificData = opcoes;
    const r = await pedir(`${ZERNIO}/posts`, {
      method: "POST", headers: { ...h, "x-request-id": idPedido },
      body: JSON.stringify({ content: legenda, mediaItems: midias.slice(0, 10), platforms: [destino], publishNow: true }),
    }, 300000);
    ({ post, p } = ler(r.json));
    if (!post._id) return { ok: false, erro: "o Zernio recusou o post: " + String((r.json && (r.json.error || r.json.message)) || r.txt).slice(0, 300) };
    await registrarConsumo(org, "zernio", { tipo: "publicacao", quantidade: 1 });
    if (aoCriar) await aoCriar(post._id);
  }
  const intervalo = Number(process.env.ZERNIO_INTERVALO_MS) || 15000; // os testes encurtam a espera
  for (let k = 0; k < 40 && !["published", "failed", "partial"].includes(post.status); k++) {
    await esperar(intervalo);
    const v = await pedir(`${ZERNIO}/posts/${post._id}`, { headers: h });
    ({ post, p } = ler(v.json));
    if (!post._id) break;
  }
  const ok = post.status === "published" || p.status === "published";
  return { ok, link: p.platformPostUrl || null, id: post._id || "", erro: ok ? "" : String(p.errorMessage || "o Zernio não confirmou a publicação").slice(0, 400) };
}

/* ---------- teste das chaves (não gasta créditos) ---------- */
export async function testar(org, provedor) {
  let chave;
  try { chave = await chaveDe(org, provedor); } catch (e) { return { ok: false, mensagem: e.message }; }
  const teste = {
    // Conta os tokens de uma mensagem curta: não gasta crédito e confere a chave e o modelo usado pela plataforma.
    anthropic: () => pedir("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": chave, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: config.modeloClaude, messages: [{ role: "user", content: "oi" }] }) }),
    // Consulta uma tarefa que não existe: a chave é conferida antes, então 404 quer dizer chave aceita.
    magnific: () => pedir(MAGNIFIC + "/v1/ai/mystic/00000000-0000-0000-0000-000000000000", { headers: { "x-freepik-api-key": chave } }),
    apify: () => pedir("https://api.apify.com/v2/users/me", { headers: { authorization: `Bearer ${chave}` } }),
    zernio: () => pedir(ZERNIO + "/accounts", { headers: { authorization: `Bearer ${chave}` } }),
  }[provedor];
  try {
    const r = await teste();
    if (r.ok || (provedor === "magnific" && r.status === 404)) return { ok: true, mensagem: "Chave funcionando." };
    if (r.status === 401 || r.status === 403) return { ok: false, mensagem: "A chave foi recusada. Confira se copiou inteira e se está ativa." };
    const motivo = String((r.json && ((r.json.error && (r.json.error.message || r.json.error)) || r.json.message)) || r.txt || "").replace(/\s+/g, " ").slice(0, 220);
    if (provedor === "anthropic" && /workspace/i.test(motivo)) return { ok: false, mensagem: "Esta chave não está ligada a um workspace da Anthropic. No console.anthropic.com, abra Settings › Workspaces, entre em um workspace (pode ser o Default), crie a chave em API keys e cole aqui." };
    if (provedor === "anthropic" && r.status === 400 && /credit|balance/i.test(motivo)) return { ok: false, mensagem: "A chave funciona, mas a conta da Anthropic está sem créditos. Adicione créditos em console.anthropic.com › Billing." };
    return { ok: false, mensagem: `O serviço respondeu ${r.status}${motivo ? ": " + motivo : ""}` };
  } catch (e) { return { ok: false, mensagem: "Não consegui falar com o serviço agora." }; }
}
