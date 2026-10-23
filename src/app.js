// Servidor HTTP: POST /api (todas as ações do painel), GET /f/:id/:chave (arquivos) e GET /saude.
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import zlib from "node:zlib";
import { config } from "./config.js";
import { db } from "./db.js";
import { hashToken } from "./cripto.js";
import { ErroApi, UUID } from "./erros.js";
import { infoArquivo, lerPedaco } from "./arquivos.js";
import { acoesConta, acoesOrg } from "./acoes/conta.js";
import { acoesPauta, guardarEnvioNoBanco } from "./acoes/pauta.js";
import path from "node:path";
import { acoesMegaBrain } from "./mega-brain.js";
import { acoesTipografia } from "./tipografia.js";
import { acoesAcervoMagnific } from "./acervo-magnific.js";
import { ErroIntegracao } from "./provedores/index.js";
import { relatorioCsv, chaveRelatorioOk } from "./relatorio.js";
import { painelAdmin } from "./admin.js";
import { catalogo, situacao, assinaturaKiwifyOk, avisoKiwify } from "./planos.js";
import { midiasLogin, arquivoLogin } from "./vitrine.js";
import { assinaturaNastenOk, receberAvisoNasten } from "./nasten.js";
import { acoesEmail, confirmacaoPendente } from "./autenticacao-email.js";
import { acoesSinsalabim } from "./sinsalabim.js";

const PUBLICAS = new Set(["cadastrar", "entrar", "verConvite", "planos", "vitrineLogin", ...Object.keys(acoesEmail)]);
const SEM_ORG = new Set(["eu", "sair", "trocarSenha", "aceitarConvite", "criarOrganizacao", "trocarOrganizacao", "painelAdmin"]);
const acoesPlano = {
  async vitrineLogin() { return { midias: await midiasLogin() }; },
  async planos() { return catalogo(); },
  // Painel admin da plataforma (só ADMIN_EMAILS).
  painelAdmin,
  // Plano da organização, uso do mês e links de checkout já com a organização (sck) e o e-mail preenchidos.
  async plano(ctx) {
    const c = catalogo(), s = await situacao(ctx.org);
    const link = u => { if (!u) return null; const x = new URL(u); x.searchParams.set("sck", ctx.org); x.searchParams.set("email", ctx.usuario.email); return x.toString(); };
    c.planos.forEach(p => p.ciclos.forEach(k => { k.checkout = link(k.checkout); }));
    return { situacao: s, ...c };
  },
};
const TODAS = { ...acoesConta, ...acoesOrg, ...acoesPauta, ...acoesPlano, ...acoesMegaBrain, ...acoesTipografia, ...acoesAcervoMagnific, ...acoesEmail, ...acoesSinsalabim };

// Limite simples por IP para login e cadastro (evita tentativa de senha em massa).
const tentativas = new Map();
function limitar(ip, acao) {
  const chave = ip + "|" + acao, agora = Date.now();
  const lista = (tentativas.get(chave) || []).filter(t => agora - t < 10 * 60000);
  lista.push(agora); tentativas.set(chave, lista);
  if (tentativas.size > 5000) for (const [k, v] of tentativas) if (!v.length || agora - v[v.length - 1] > 10 * 60000) tentativas.delete(k);
  if (lista.length > 30) throw new ErroApi("Muitas tentativas deste endereço. Espere alguns minutos.", 429);
}

async function contexto(req) {
  const bruto = String(req.headers["x-pauta-token"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  if (!/^[a-f0-9]{64}$/.test(bruto)) return null;
  const s = (await db().query(
    `select s.id, s.org_atual, u.id as usuario_id, u.email, u.nome, u.email_confirmado_em, u.exigir_confirmacao_email from sessoes s join usuarios u on u.id = s.usuario_id
     where s.token_hash = $1 and s.expira_em > now()`, [hashToken(bruto)])).rows[0];
  if (!s) return null;
  const membros = (await db().query("select org_id, papel from membros where usuario_id = $1", [s.usuario_id])).rows;
  const m = membros.find(x => x.org_id === s.org_atual) || membros[0] || null;
  if (m && m.org_id !== s.org_atual) await db().query("update sessoes set org_atual = $2 where id = $1", [s.id, m.org_id]);
  return { sessao: s.id, usuario: { id: s.usuario_id, email: s.email, nome: s.nome, confirmacaoPendente: confirmacaoPendente(s) }, org: m ? m.org_id : null, papel: m ? m.papel : null };
}

const LIMITE_VIDEO_BRUTO = 1536 * 1024 * 1024; // 1,5 GB: cobre alguns minutos de 4K do iPhone
export async function criarApp() {
  const app = Fastify({ logger: false, bodyLimit: 90 * 1024 * 1024, trustProxy: Number(process.env.PROXIES_CONFIAVEIS || 1) });
  // Respostas em JSON e CSV vão comprimidas (a pauta cai de ~300 KB para ~40 KB no celular).
  await app.register(compress, { global: true, threshold: 1024, encodings: ["br", "gzip"], brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } } });
  await app.register(cors, { origin: config.origens, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["content-type", "x-pauta-token", "authorization"], maxAge: 600 });

  // Guarda o corpo bruto: as assinaturas dos provedores usam exatamente os bytes recebidos.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, corpo, pronto) => {
    req.corpoBruto = corpo;
    if (!corpo) return pronto(null, {});
    try { pronto(null, JSON.parse(corpo)); } catch (e) { e.statusCode = 400; pronto(e); }
  });

  app.get("/saude", async () => ({ ok: true }));

  app.post("/nasten", { bodyLimit: 256 * 1024 }, async (req, rep) => {
    // A Nasten testa a URL sem assinatura durante o cadastro. Esse ping não processa pagamentos.
    if (req.body?.test === true && Object.keys(req.body).length === 1) return { ok: true, teste: true };
    if (!assinaturaNastenOk(req.corpoBruto, req.headers["signature-hmac"])) return rep.code(401).send({ ok: false });
    try { return rep.code(202).send({ ok: true, ...(await receberAvisoNasten(req.body)) }); }
    catch (e) { return rep.code(e instanceof ErroApi ? e.status : 500).send({ ok: false }); }
  });

  // Relatório de controle para a planilha do Google (IMPORTDATA). Só existe com RELATORIO_CHAVE configurada.
  app.get("/relatorio.csv", async (req, rep) => {
    if (!process.env.RELATORIO_CHAVE) return rep.code(404).send("não encontrado");
    try { limitar(req.ip, "relatorio"); } catch (e) { return rep.code(429).send("muitas tentativas"); }
    if (!chaveRelatorioOk(req.query.chave)) return rep.code(401).send("chave inválida");
    return rep.header("content-type", "text/csv; charset=utf-8").header("cache-control", "no-store").send(await relatorioCsv({ br: req.query.formato === "br" }));
  });

  // Avisos da Kiwify (compra aprovada, renovação, cancelamento, estorno).
  app.post("/kiwify", async (req, rep) => {
    if (!assinaturaKiwifyOk(req.corpoBruto, req.query.signature)) return rep.code(401).send({ ok: false });
    try { return { ok: true, ...(await avisoKiwify(req.body || {})) }; }
    catch (e) { console.error("[kiwify]", e); return rep.code(500).send({ ok: false }); }
  });

  // Arquivos aos pedaços (Range): o vídeo começa a tocar com o primeiro pedaço, sem baixar o arquivo inteiro (o iPhone exige isso).
  // Efeitos sonoros do Sinsalabim (gerados, sem direitos de terceiros): o Shotstack e a prévia buscam aqui.
  const SFX = new Map(["whoosh", "pop"].map(n => [n + ".mp3", new URL(`./sfx/${n}.mp3`, import.meta.url)]));
  app.get("/sfx/:nome", { compress: false }, async (req, rep) => {
    const arq = SFX.get(req.params.nome); if (!arq) return rep.code(404).send("não encontrado");
    const fs = await import("node:fs/promises");
    return rep.header("content-type", "audio/mpeg").header("cache-control", "public, max-age=31536000, immutable").header("access-control-allow-origin", "*").send(await fs.readFile(arq));
  });
  app.get("/f/:id/:chave", { compress: false }, async (req, rep) => {
    const { id, chave } = req.params;
    if (!UUID.test(id)) return rep.code(404).send("não encontrado");
    const a = await infoArquivo(id, chave, { previa: req.query.v === "p" });
    if (!a) return rep.code(404).send("não encontrado");
    rep.header("content-type", a.tipo).header("cache-control", "public, max-age=31536000, immutable").header("accept-ranges", "bytes")
      .header("access-control-allow-origin", "*").header("access-control-expose-headers", "content-range, content-length, accept-ranges")
      .header("content-disposition", `inline; filename="${a.nome}"`);
    const total = a.tamanho, m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || "").trim());
    if (m && (m[1] || m[2])) {
      let ini = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2])), fim = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (ini >= total || ini > fim) return rep.code(416).header("content-range", `bytes */${total}`).send();
      return rep.code(206).header("content-range", `bytes ${ini}-${fim}/${total}`).header("content-length", fim - ini + 1).send(lerPedaco(a.arq, ini, fim));
    }
    return rep.header("content-length", total).send(lerPedaco(a.arq, 0, Math.max(0, total - 1)));
  });

  app.get("/vitrine/:id", { compress: false }, async (req, rep) => {
    if (!UUID.test(req.params.id)) return rep.code(404).send("não encontrado");
    const item = await arquivoLogin(req.params.id); if (!item) return rep.code(404).send("não encontrado");
    const a = await infoArquivo(item.id, item.chave, { previa: req.query.v === "p" });
    if (!a) return rep.code(404).send("não encontrado");
    rep.header("content-type", a.tipo).header("cache-control", "public, max-age=60").header("accept-ranges", "bytes").header("access-control-allow-origin", "*");
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || "")), total = a.tamanho;
    if (m && (m[1] || m[2])) {
      const ini = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2])), fim = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (ini >= total || ini > fim) return rep.code(416).header("content-range", `bytes */${total}`).send();
      return rep.code(206).header("content-range", `bytes ${ini}-${fim}/${total}`).header("content-length", fim - ini + 1).send(lerPedaco(a.arq, ini, fim));
    }
    return rep.header("content-length", total).send(lerPedaco(a.arq, 0, total - 1));
  });

  // Vídeo grande (ex.: .mov 4K do iPhone, de centenas de MB) chega como arquivo, sem base64, e é gravado no disco
  // enquanto chega (não fica na memória); depois o servidor converte para MP4.
  app.addContentTypeParser("application/octet-stream", (req, payload, pronto) => pronto(null, payload));
  app.post("/video", async (req, rep) => {
    const os = await import("node:os"), fsp = await import("node:fs/promises"), { createWriteStream } = await import("node:fs"), { pipeline } = await import("node:stream/promises");
    let pasta = null;
    try {
      const ctx = await contexto(req);
      if (!ctx) throw new ErroApi("Sua sessão expirou. Entre de novo.", 401, { login: true });
      if (ctx.usuario.confirmacaoPendente) throw new ErroApi("Confirme seu e-mail para continuar.", 403, { confirmarEmail: true });
      if (!ctx.org) throw new ErroApi("Crie uma organização ou aceite um convite para começar.", 409, { semOrganizacao: true });
      const declarado = Number(req.headers["content-length"] || 0);
      if (declarado > LIMITE_VIDEO_BRUTO) throw new ErroApi(`O vídeo tem ${Math.round(declarado / 1048576)} MB; o limite é de ${Math.round(LIMITE_VIDEO_BRUTO / 1048576)} MB.`, 413);
      pasta = await fsp.mkdtemp(path.join(os.tmpdir(), "envio-"));
      const destino = path.join(pasta, "video");
      let recebido = 0;
      await pipeline(req.body, async function* (fonte) { for await (const pedaco of fonte) { recebido += pedaco.length; if (recebido > LIMITE_VIDEO_BRUTO) throw new ErroApi("O vídeo passou do limite de tamanho.", 413); yield pedaco; } }, createWriteStream(destino));
      if (!recebido) throw new ErroApi("Arquivo vazio.");
      const q = req.query || {}, t0 = Date.now();
      const r = await guardarEnvioNoBanco(ctx, { caminho: destino, tipo: String(q.tipo || ""), nome: String(q.nome || "video"), titulo: String(q.titulo || ""), descrever: false });
      console.log(`[video] envio de ${(recebido / 1048576).toFixed(0)} MB convertido em ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      return { ok: true, ...r };
    } catch (e) {
      req.body?.resume?.(); // descarta o resto do envio se parou antes
      if (e instanceof ErroApi) return rep.code(e.status).send({ ok: false, erro: e.message, ...e.extra });
      if (e && Number(e.status) >= 400 && Number(e.status) < 500 && e.message) return rep.code(Number(e.status)).send({ ok: false, erro: e.message });
      console.error("[video envio]", e);
      return rep.code(500).send({ ok: false, erro: "Não consegui converter o vídeo. Tente de novo; se continuar, exporte em MP4." });
    } finally { if (pasta) await fsp.rm(pasta, { recursive: true, force: true }).catch(() => {}); }
  });

  app.post("/api", async (req, rep) => {
    const b = (req.body && typeof req.body === "object") ? req.body : {};
    const acao = String(b.acao || "");
    try {
      const fn = Object.hasOwn(TODAS, acao) ? TODAS[acao] : null;
      if (!fn) throw new ErroApi("Ação desconhecida.");
      let ctx = null;
      if (PUBLICAS.has(acao)) limitar(req.ip, acao);
      else {
        ctx = await contexto(req);
        if (!ctx) throw new ErroApi("Sua sessão expirou. Entre de novo.", 401, { login: true });
        if (ctx.usuario.confirmacaoPendente && !["eu", "sair", "trocarSenha"].includes(acao)) throw new ErroApi("Confirme seu e-mail para continuar.", 403, { confirmarEmail: true });
        if (!SEM_ORG.has(acao) && !ctx.org) throw new ErroApi("Crie uma organização ou aceite um convite para começar.", 409, { semOrganizacao: true });
      }
      const t0 = Date.now(), r = await fn(ctx, b), ms = Date.now() - t0;
      if (ms > 3000) console.log(`[lento] ${acao} ${(ms / 1000).toFixed(1)} s`); // para achar o que pesa no uso real
      return { ok: true, ...(r || {}) };
    } catch (e) {
      if (e instanceof ErroApi) return rep.code(e.status).send({ ok: false, erro: e.message, ...e.extra });
      if (e instanceof ErroIntegracao) return rep.code(400).send({ ok: false, erro: e.message });
      // erros de validação com motivo (ex.: arquivo grande demais, imagem que não abre) chegam ao painel como são
      if (e && Number(e.status) >= 400 && Number(e.status) < 500 && e.message) return rep.code(Number(e.status)).send({ ok: false, erro: e.message });
      console.error(`[api ${acao}]`, e);
      return rep.code(500).send({ ok: false, erro: "Erro interno. Tente de novo; se continuar, avise o suporte." });
    }
  });
  return app;
}
