// Servidor HTTP: POST /api (todas as ações do painel), GET /f/:id/:chave (arquivos) e GET /saude.
import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { db } from "./db.js";
import { hashToken } from "./cripto.js";
import { ErroApi } from "./erros.js";
import { lerArquivo } from "./arquivos.js";
import { acoesConta, acoesOrg } from "./acoes/conta.js";
import { acoesPauta } from "./acoes/pauta.js";
import { ErroIntegracao } from "./provedores/index.js";

const PUBLICAS = new Set(["cadastrar", "entrar", "verConvite"]);
const SEM_ORG = new Set(["eu", "sair", "trocarSenha", "aceitarConvite", "criarOrganizacao", "trocarOrganizacao"]);
const TODAS = { ...acoesConta, ...acoesOrg, ...acoesPauta };

// Limite simples por IP para login e cadastro (evita tentativa de senha em massa).
const tentativas = new Map();
function limitar(ip, acao) {
  const chave = ip + "|" + acao, agora = Date.now();
  const lista = (tentativas.get(chave) || []).filter(t => agora - t < 10 * 60000);
  lista.push(agora); tentativas.set(chave, lista);
  if (lista.length > 30) throw new ErroApi("Muitas tentativas deste endereço. Espere alguns minutos.", 429);
}

async function contexto(req) {
  const bruto = String(req.headers["x-pauta-token"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  if (!/^[a-f0-9]{64}$/.test(bruto)) return null;
  const s = (await db().query(
    `select s.id, s.org_atual, u.id as usuario_id, u.email, u.nome from sessoes s join usuarios u on u.id = s.usuario_id
     where s.token_hash = $1 and s.expira_em > now()`, [hashToken(bruto)])).rows[0];
  if (!s) return null;
  const membros = (await db().query("select org_id, papel from membros where usuario_id = $1", [s.usuario_id])).rows;
  const m = membros.find(x => x.org_id === s.org_atual) || membros[0] || null;
  if (m && m.org_id !== s.org_atual) await db().query("update sessoes set org_atual = $2 where id = $1", [s.id, m.org_id]);
  return { sessao: s.id, usuario: { id: s.usuario_id, email: s.email, nome: s.nome }, org: m ? m.org_id : null, papel: m ? m.papel : null };
}

export async function criarApp() {
  const app = Fastify({ logger: false, bodyLimit: 90 * 1024 * 1024, trustProxy: true });
  await app.register(cors, { origin: config.origens, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["content-type", "x-pauta-token", "authorization"], maxAge: 600 });

  app.get("/saude", async () => ({ ok: true }));

  app.get("/f/:id/:chave", async (req, rep) => {
    const { id, chave } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return rep.code(404).send("não encontrado");
    const a = await lerArquivo(id, chave);
    if (!a) return rep.code(404).send("não encontrado");
    return rep.header("content-type", a.tipo).header("cache-control", "public, max-age=31536000, immutable")
      .header("access-control-allow-origin", "*").header("content-disposition", `inline; filename="${a.nome}"`).send(a.dados);
  });

  app.post("/api", async (req, rep) => {
    const b = (req.body && typeof req.body === "object") ? req.body : {};
    const acao = String(b.acao || "");
    try {
      const fn = TODAS[acao];
      if (!fn) throw new ErroApi("Ação desconhecida.");
      let ctx = null;
      if (PUBLICAS.has(acao)) limitar(req.ip, acao);
      else {
        ctx = await contexto(req);
        if (!ctx) throw new ErroApi("Sua sessão expirou. Entre de novo.", 401, { login: true });
        if (!SEM_ORG.has(acao) && !ctx.org) throw new ErroApi("Crie uma organização ou aceite um convite para começar.", 409, { semOrganizacao: true });
      }
      const r = await fn(ctx, b);
      return { ok: true, ...(r || {}) };
    } catch (e) {
      if (e instanceof ErroApi) return rep.code(e.status).send({ ok: false, erro: e.message, ...e.extra });
      if (e instanceof ErroIntegracao) return rep.code(400).send({ ok: false, erro: e.message });
      console.error(`[api ${acao}]`, e);
      return rep.code(500).send({ ok: false, erro: "Erro interno. Tente de novo; se continuar, avise o suporte." });
    }
  });
  return app;
}
