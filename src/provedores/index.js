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
    // Planos pagos incluem a IA: sem chave própria, usa a da plataforma (PLATAFORMA_ANTHROPIC, _MAGNIFIC, _APIFY, _ZERNIO).
    const daPlataforma = process.env["PLATAFORMA_" + provedor.toUpperCase()];
    if (daPlataforma && cobrancaLigada()) { const s = await situacao(org); if (s.ativo) return daPlataforma; }
  }
  if (!r) throw new ErroIntegracao(`A chave do ${NOMES[provedor]} não está cadastrada. Cadastre em Integrações.`);
  return decifrar(r.valor_cifrado);
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
export async function claude(org, { system, content, effort = "medium", max_tokens = 16000 }) {
  const chave = await chaveDe(org, "anthropic");
  const r = await pedir("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": chave, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" },
    body: JSON.stringify({ model: config.modeloClaude, max_tokens, output_config: { effort }, fallbacks: "default", system, messages: [{ role: "user", content }] }),
  }, 600000);
  const j = r.json || {};
  if (!r.ok || j.type === "error") throw new ErroIntegracao("falha na API do Claude: " + String((j.error && j.error.message) || r.txt).slice(0, 300));
  if (j.stop_reason === "refusal") throw new ErroIntegracao("o Claude recusou o pedido");
  if (j.stop_reason === "max_tokens") throw new ErroIntegracao("a resposta ficou longa demais e foi cortada");
  const txt = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new ErroIntegracao("a resposta do Claude não veio em JSON");
  return JSON.parse(m[0]);
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
  tarefaMagnific(org, "/v1/ai/mystic", "/v1/ai/mystic", { prompt, aspect_ratio: PROPORCAO[proporcao] || "social_post_4_5" }, { intervalo: 10000, limiteMs: 15 * 60000 });
export const gerarClipe = (org, { prompt, duracao, proporcao, imagem }) =>
  tarefaMagnific(org, "/v1/ai/video/kling-v3-std", "/v1/ai/video/kling-v3",
    Object.assign({ prompt, duration: String(Math.min(10, Math.max(3, Math.round(Number(duracao) || 5)))), aspect_ratio: proporcao, generate_audio: false, cfg_scale: 0.5 }, imagem ? { start_image_url: imagem } : {}),
    { intervalo: 20000 });

/* ---------- Apify (coleta das fontes) ---------- */
export async function coletarApify(org, actor, input) {
  const chave = await chaveDe(org, "apify");
  const r = await pedir(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${chave}` }, body: JSON.stringify(input),
  }, 300000);
  if (!r.ok) throw new ErroIntegracao("a Apify recusou a coleta: " + String((r.json && r.json.error && r.json.error.message) || r.txt).slice(0, 200));
  return Array.isArray(r.json) ? r.json : [];
}

/* ---------- Zernio (publicação) ---------- */
const ZERNIO = "https://zernio.com/api/v1";
// Publica na hora: acha a conta da rede, cria o post com publishNow e acompanha até publicar ou falhar.
export async function publicarZernio(org, { rede, midias, legenda, opcoes, chave: idPedido }) {
  const chave = await chaveDe(org, "zernio");
  const h = { "content-type": "application/json", authorization: `Bearer ${chave}` };
  const contas = await pedir(`${ZERNIO}/accounts`, { headers: h });
  if (contas.status === 401 || contas.status === 403) return { ok: false, erro: "o Zernio recusou a chave. Confira em Integrações." };
  const conta = ((contas.json && contas.json.accounts) || []).find(c => c.platform === rede && c.isActive !== false);
  if (!conta) return { ok: false, erro: `nenhuma conta de ${rede || "rede"} conectada no Zernio` };
  if (!midias.length) return { ok: false, erro: "o post não tem artes finais" };
  const destino = { platform: rede, accountId: conta._id };
  if (opcoes) destino.platformSpecificData = opcoes;
  const r = await pedir(`${ZERNIO}/posts`, {
    method: "POST", headers: { ...h, "x-request-id": idPedido },
    body: JSON.stringify({ content: legenda, mediaItems: midias.slice(0, 10), platforms: [destino], publishNow: true }),
  }, 300000);
  const ler = j => { const post = (j && j.post) || {}; const p = (post.platforms || [])[0] || {}; return { post, p }; };
  let { post, p } = ler(r.json);
  if (!post._id) return { ok: false, erro: "o Zernio recusou o post: " + String((r.json && (r.json.error || r.json.message)) || r.txt).slice(0, 300) };
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
    anthropic: () => pedir("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": chave, "anthropic-version": "2023-06-01" } }),
    magnific: () => pedir(MAGNIFIC + "/v1/ai/mystic", { headers: { "x-freepik-api-key": chave } }),
    apify: () => pedir("https://api.apify.com/v2/users/me", { headers: { authorization: `Bearer ${chave}` } }),
    zernio: () => pedir(ZERNIO + "/accounts", { headers: { authorization: `Bearer ${chave}` } }),
  }[provedor];
  try {
    const r = await teste();
    if (r.ok) return { ok: true, mensagem: "Chave funcionando." };
    if (r.status === 401 || r.status === 403) return { ok: false, mensagem: "A chave foi recusada. Confira se copiou inteira e se está ativa." };
    return { ok: false, mensagem: `O serviço respondeu ${r.status}. Tente de novo em alguns minutos.` };
  } catch (e) { return { ok: false, mensagem: "Não consegui falar com o serviço agora." }; }
}
