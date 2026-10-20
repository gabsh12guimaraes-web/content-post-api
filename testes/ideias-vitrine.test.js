import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";
process.env.DATABASE_URL = "pglite:memoria";
process.env.CHAVE_MESTRA = crypto.randomBytes(32).toString("base64");
process.env.PASTA_ARQUIVOS = fs.mkdtempSync(path.join(os.tmpdir(), "pauta-vitrine-"));
process.env.URL_PUBLICA = "http://teste.local";
const { conectar, db, desconectar } = await import("../src/db.js");
const { criarApp } = await import("../src/app.js");
const { postIncorporavel } = await import("../src/tarefas/exemplos.js");
await import("../src/tarefas/trabalhos.js");
let app, a, b, jpeg, falhar = false, chamadas = [];
const original = globalThis.fetch;
const chamar = async (payload, token) => { const r = await app.inject({ method: "POST", url: "/api", payload, headers: token ? { "x-pauta-token": token } : {} }); return { status: r.statusCode, ...r.json() }; };
const tarefa = async id => { for (let i = 0; i < 200; i++) { const t = await chamar({ acao: "resultadoExemplos", id }, a.token); if (["feito", "erro"].includes(t.status)) return t; await new Promise(r => setTimeout(r, 20)); } throw new Error("Busca não concluiu"); };
const ideia = async (org, referencias = []) => (await db().query("insert into ideias (org_id, titulo, resumo, formato, rede, referencias) values ($1,'Como fazer um bom café','Bastidores do preparo','Reels','Instagram',$2) returning id", [org, referencias])).rows[0].id;
before(async () => {
  await conectar(); app = await criarApp();
  a = await chamar({ acao: "cadastrar", nome: "Ana", email: "ana@vitrine.test", senha: "segredo123", organizacao: "Marca A" });
  b = await chamar({ acao: "cadastrar", nome: "Bia", email: "bia@vitrine.test", senha: "segredo123", organizacao: "Marca B" });
  for (const provedor of ["anthropic", "apify"]) await chamar({ acao: "salvarIntegracao", provedor, valor: "chave_teste_" + provedor }, a.token);
  jpeg = (await sharp({ create: { width: 80, height: 100, channels: 3, background: "#aabbcc" } }).jpeg().toBuffer()).toString("base64");
  globalThis.fetch = async (url, op = {}) => {
    chamadas.push(String(url)); if (falhar) throw new Error("Sem rede");
    if (String(url).includes("anthropic.com")) return Response.json({ content: [{ type: "text", text: JSON.stringify(String(JSON.parse(op.body).system).startsWith("Sugira") ? { hashtags: ["caféespecial", "preparocafe"] } : { indices: [999, -1, 0, 0, 1, 2, 3] }) }], stop_reason: "end_turn" });
    if (String(url).includes("apify.com")) return Response.json([
      { url: "https://www.instagram.com/reel/CafeUm/?igsh=x", caption: "Como preparar café", type: "Video" },
      { url: "https://www.instagram.com/p/CafeDois/", caption: "Café na rotina", type: "Sidecar" },
      { url: "https://www.instagram.com/reel/CafeTres/", caption: "Bastidores do café", type: "Video" },
      { url: "javascript:alert(1)", caption: "Não incorporar" },
    ]);
    throw new Error("Pedido externo inesperado");
  };
});
after(async () => { globalThis.fetch = original; delete process.env.ADMIN_EMAILS; await app.close(); await desconectar(); fs.rmSync(process.env.PASTA_ARQUIVOS, { recursive: true, force: true }); });

test("incorporações aceitam apenas URLs oficiais de publicações, sem links executáveis ou domínios parecidos", () => {
  for (const v of ["javascript:alert(1)", "https://instagram.com.evil.test/p/teste", "https://www.instagram.com/perfil/", "https://user:pass@instagram.com/p/Um/", "https://www.tiktok.com/redirect?x=x"]) assert.equal(postIncorporavel(v), null);
  assert.equal(postIncorporavel("https://instagram.com/reel/ABC_123/?utm=x").embed, "https://www.instagram.com/reel/ABC_123/embed/");
  assert.equal(postIncorporavel("https://www.tiktok.com/@cafe/video/1234567891234567890").embed, "https://www.tiktok.com/player/v1/1234567891234567890?autoplay=0");
});

test("três referências da ideia são incorporadas sem gastar IA; referências de outra organização não são expostas", async () => {
  const ids = [];
  for (const url of ["https://instagram.com/p/OrigUm/", "https://www.instagram.com/reel/OrigDois/", "https://www.tiktok.com/@cafe/video/1234567891234567890"]) ids.push((await db().query("insert into coletas (org_id,id_externo,url,texto) values ($1,$2,$3,'Café artesanal') returning id", [a.organizacao.id, crypto.randomUUID(), url])).rows[0].id);
  const outro = (await db().query("insert into coletas (org_id,id_externo,url,texto) values ($1,'externo','https://instagram.com/p/OutraMarca/','Outra marca') returning id", [b.organizacao.id])).rows[0].id;
  const id = await ideia(a.organizacao.id, [...ids, outro]); const antes = chamadas.length;
  const r = await chamar({ acao: "exemplosIdeia", id }, a.token); const t = await tarefa(r.id);
  assert.equal(t.status, "feito"); assert.equal(t.resultado.exemplos.length, 3); assert.equal(chamadas.length, antes);
  assert.equal(JSON.stringify(t).includes("OutraMarca"), false);
  assert.equal((await chamar({ acao: "exemplosIdeia", id }, b.token)).status, 404);
  assert.equal((await chamar({ acao: "resultadoExemplos", id: r.id }, b.token)).status, 404);
  assert.equal((await chamar({ acao: "exemplosIdeia", id })).status, 401);
  const cache = await chamar({ acao: "exemplosIdeia", id }, a.token); assert.equal(cache.status, "feito"); assert.equal(cache.resultado.exemplos.length, 3); assert.equal(chamadas.length, antes);
});

test("sem referências, busca e seleciona posts reais, limita a três e não altera o uso de posts", async () => {
  await db().query("delete from coletas where org_id=$1", [a.organizacao.id]); chamadas = [];
  const id = await ideia(a.organizacao.id); const r = await chamar({ acao: "exemplosIdeia", id }, a.token); const t = await tarefa(r.id);
  assert.equal(t.resultado.exemplos.length, 3); assert(chamadas.some(u => u.includes("instagram-hashtag-scraper")));
  assert.deepEqual(t.resultado.exemplos.map(p => p.url), ["https://www.instagram.com/reel/CafeUm/", "https://www.instagram.com/p/CafeDois/", "https://www.instagram.com/reel/CafeTres/"]);
  assert.equal((await db().query("select count(*)::int as n from uso where org_id=$1", [a.organizacao.id])).rows[0].n, 0);
  const antes = chamadas.length; await chamar({ acao: "exemplosIdeia", id }, a.token); assert.equal(chamadas.length, antes);
  falhar = true;
  try { const f = await chamar({ acao: "exemplosIdeia", id, atualizar: true }, a.token); const vazia = await tarefa(f.id); assert.deepEqual(vazia.resultado.exemplos, []); assert(vazia.resultado.aviso); }
  finally { falhar = false; }
});

test("vitrine pública expõe somente IA escolhida pelo admin; arquivos privados e de outras organizações ficam fora", async () => {
  const cadastrar = async (token, ia) => { const r = await chamar({ acao: "enviarImagemBanco", tipo: "image/jpeg", base64: jpeg, nome: "foto.jpg", descrever: false }, token); if (ia) await db().query("update banco_imagens set origem='ia' where id=$1", [r.id]); return r.id; };
  const meu = await cadastrar(a.token, true), privado = await cadastrar(b.token, true), manual = await cadastrar(a.token, false);
  assert.deepEqual((await chamar({ acao: "vitrineLogin" })).midias, []);
  assert.equal((await chamar({ acao: "publicarMidiaLogin", id: meu, publicar: true, admin: true }, a.token)).status, 403);
  process.env.ADMIN_EMAILS = "ana@vitrine.test";
  assert.equal((await chamar({ acao: "publicarMidiaLogin", id: privado, publicar: true }, a.token)).status, 404);
  assert.equal((await chamar({ acao: "publicarMidiaLogin", id: manual, publicar: true }, a.token)).status, 404);
  assert.equal((await chamar({ acao: "publicarMidiaLogin", id: meu, publicar: true }, a.token)).status, 200);
  const r = await chamar({ acao: "vitrineLogin" }); assert.equal(r.midias.length, 1); assert.equal(r.midias[0].tipo, "image/jpeg");
  const texto = JSON.stringify(r); assert.equal(texto.includes("chave"), false); assert.equal(texto.includes(a.organizacao.id), false); assert.equal(texto.includes(b.organizacao.id), false); assert.equal(texto.includes("/f/"), false);
  const url = new URL(r.midias[0].url), prev = new URL(r.midias[0].previa);
  assert.equal((await app.inject({ method: "GET", url: url.pathname })).statusCode, 200);
  assert.match((await app.inject({ method: "GET", url: prev.pathname + prev.search })).headers["content-type"], /image\/webp/);
  const idPrivado = (await db().query("select arquivo_id from banco_imagens where id=$1", [privado])).rows[0].arquivo_id;
  assert.equal((await app.inject({ method: "GET", url: "/vitrine/" + idPrivado })).statusCode, 404);
  await chamar({ acao: "publicarMidiaLogin", id: meu, publicar: false }, a.token);
  assert.deepEqual((await chamar({ acao: "vitrineLogin" })).midias, []); assert.equal((await app.inject({ method: "GET", url: url.pathname })).statusCode, 404);
});

test("vídeos da vitrine preservam Range para Safari e saem do login ao remover do banco", async () => {
  const mp4 = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=80x100:r=1:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
  const v = await chamar({ acao: "enviarImagemBanco", tipo: "video/mp4", base64: mp4.toString("base64"), nome: "video.mp4", descrever: false }, a.token);
  await db().query("update banco_imagens set origem='ia' where id=$1", [v.id]); await chamar({ acao: "publicarMidiaLogin", id: v.id, publicar: true }, a.token);
  const m = (await chamar({ acao: "vitrineLogin" })).midias[0]; const url = new URL(m.url);
  const range = await app.inject({ method: "GET", url: url.pathname, headers: { range: "bytes=0-31" } }); assert.equal(range.statusCode, 206); assert.equal(range.rawPayload.length, 32); assert.match(range.headers["content-range"], /^bytes 0-31\//);
  assert.equal((await app.inject({ method: "GET", url: url.pathname, headers: { range: "bytes=999999999-" } })).statusCode, 416);
  await chamar({ acao: "removerImagemBanco", id: v.id }, a.token);
  assert.equal((await app.inject({ method: "GET", url: url.pathname })).statusCode, 404);
});

test("a limpeza automática preserva a seleção pública da vitrine", async () => {
  const { guardarNoBanco, LIMITE_BANCO_IA } = await import("../src/tarefas/trabalhos.js");
  const { salvarArquivo } = await import("../src/arquivos.js");
  const anterior = LIMITE_BANCO_IA.imagem; LIMITE_BANCO_IA.imagem = 1;
  try {
    const id = (await chamar({ acao: "listarBanco" }, a.token)).imagens.find(i => i.origem === "ia").id;
    await chamar({ acao: "publicarMidiaLogin", id, publicar: true }, a.token);
    for (let n = 0; n < 2; n++) { const arquivo = await salvarArquivo(a.organizacao.id, { tipo: "image/jpeg", nome: "nova.jpg", dados: Buffer.from(jpeg, "base64") }); await guardarNoBanco(a.organizacao.id, arquivo, { nome: "Nova imagem" }); }
    assert.equal((await db().query("select publico_login from banco_imagens where id=$1", [id])).rows[0]?.publico_login, true);
    assert.equal((await chamar({ acao: "vitrineLogin" })).midias.length, 1);
  } finally { LIMITE_BANCO_IA.imagem = anterior; }
});
