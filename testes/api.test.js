// Testes de ponta a ponta com Postgres embutido (PGlite) e APIs externas simuladas.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DATABASE_URL = "pglite:memoria";
process.env.CHAVE_MESTRA = crypto.randomBytes(32).toString("base64");
process.env.PASTA_ARQUIVOS = fs.mkdtempSync(path.join(os.tmpdir(), "pauta-arquivos-"));
process.env.URL_PUBLICA = "http://teste.local";
process.env.MAGNIFIC_INTERVALO_MS = "5";

const { conectar, db, desconectar } = await import("../src/db.js");
const { criarApp } = await import("../src/app.js");
await import("../src/tarefas/trabalhos.js");
const { puxar } = await import("../src/tarefas/fila.js");

let app;
const chamar = async (corpo, token) => {
  const r = await app.inject({ method: "POST", url: "/api", payload: corpo, headers: token ? { "x-pauta-token": token } : {} });
  return { status: r.statusCode, ...r.json() };
};
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=", "base64").toString("base64");

before(async () => { await conectar(); app = await criarApp(); });
after(async () => { await app.close(); await desconectar(); });

let ana, anaOrg, bob, carla;

test("cadastro cria conta, organização e marca", async () => {
  const r = await chamar({ acao: "cadastrar", nome: "Ana", email: "Ana@Exemplo.com", senha: "segredo123", organizacao: "Easypeasy" });
  assert.equal(r.status, 200);
  assert.match(r.token, /^[a-f0-9]{64}$/);
  assert.equal(r.organizacao.papel, "dono");
  ana = r.token; anaOrg = r.organizacao.id;
  const l = await chamar({ acao: "listar" }, ana);
  assert.equal(l.marca.Nome, "Easypeasy");
  const dup = await chamar({ acao: "cadastrar", nome: "Outra", email: "ana@exemplo.com", senha: "segredo123", organizacao: "X" });
  assert.equal(dup.status, 400);
});

test("convite leva a pessoa para a organização certa, como editor", async () => {
  const c = await chamar({ acao: "convidar", email: "bob@exemplo.com", papel: "editor" }, ana);
  assert.equal(c.status, 200);
  const v = await chamar({ acao: "verConvite", convite: c.convite });
  assert.equal(v.convite.organizacao, "Easypeasy");
  const errado = await chamar({ acao: "cadastrar", nome: "Bob", email: "outro@exemplo.com", senha: "segredo123", convite: c.convite });
  assert.equal(errado.status, 400);
  const r = await chamar({ acao: "cadastrar", nome: "Bob", email: "bob@exemplo.com", senha: "segredo123", convite: c.convite });
  assert.equal(r.status, 200);
  assert.equal(r.organizacao.id, anaOrg);
  assert.equal(r.organizacao.papel, "editor");
  assert.equal(r.organizacoes.length, 1);
  bob = r.token;
  const de_novo = await chamar({ acao: "verConvite", convite: c.convite });
  assert.equal(de_novo.status, 404);
});

test("só admin e dono cadastram chaves; a chave fica cifrada", async () => {
  const negado = await chamar({ acao: "salvarIntegracao", provedor: "anthropic", valor: "sk-ant-teste-1234567890" }, bob);
  assert.equal(negado.status, 403);
  const ok = await chamar({ acao: "salvarIntegracao", provedor: "anthropic", valor: "sk-ant-teste-1234567890" }, ana);
  assert.equal(ok.status, 200);
  const l = await chamar({ acao: "listarIntegracoes" }, bob);
  const a = l.integracoes.find(i => i.id === "anthropic");
  assert.equal(a.configurada, true);
  assert.equal(a.dica, "…7890");
  assert.equal(JSON.stringify(l).includes("sk-ant-teste"), false);
  const bruto = (await db().query("select valor_cifrado from integracoes")).rows[0].valor_cifrado;
  assert.equal(bruto.includes("sk-ant"), false);
});

test("organizações ficam isoladas", async () => {
  const r = await chamar({ acao: "cadastrar", nome: "Carla", email: "carla@exemplo.com", senha: "segredo123", organizacao: "Outra Marca" });
  carla = r.token;
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Ideia da Ana', 'Carrossel', 'Instagram', 8) returning id", [anaOrg])).rows[0].id;
  const ag = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 86400000).toISOString() }, ana);
  assert.equal(ag.status, 200);
  const pc = await chamar({ acao: "pauta" }, carla);
  assert.equal(pc.posts.length, 0);
  assert.equal(pc.ideias.length, 0);
  assert.equal((await chamar({ acao: "removerPost", id: ag.id }, carla)).status, 404);
  assert.equal((await chamar({ acao: "trocarOrganizacao", org: anaOrg }, carla)).status, 403);
  const pa = await chamar({ acao: "pauta" }, bob);
  assert.equal(pa.posts.length, 1);
  assert.equal(pa.ideias[0].Status, "Aprovada");
});

test("artes finais, aprovação e arquivo público", async () => {
  const post = (await chamar({ acao: "pauta" }, ana)).posts[0];
  assert.equal((await chamar({ acao: "aprovarPost", id: post.id }, ana)).status, 400);
  await db().query("update posts set status = 'EmRevisao' where id = $1", [post.id]);
  assert.match((await chamar({ acao: "aprovarPost", id: post.id }, ana)).erro, /artes finais/);
  const s = await chamar({ acao: "salvarArtes", id: post.id, artes: [{ tipo: "image/jpeg", base64: JPG }] }, bob);
  assert.equal(s.status, 200);
  const depois = (await chamar({ acao: "pauta" }, ana)).posts[0];
  assert.equal(depois.ArtesProntas, true);
  const url = new URL(depois.Arquivos[0].url);
  const f = await app.inject({ method: "GET", url: url.pathname });
  assert.equal(f.statusCode, 200);
  assert.equal(f.headers["content-type"], "image/jpeg");
  assert.equal((await app.inject({ method: "GET", url: url.pathname.replace(/[^/]+$/, "errada") })).statusCode, 404);
  assert.equal((await chamar({ acao: "aprovarPost", id: post.id }, bob)).status, 200);
  assert.equal((await chamar({ acao: "pauta" }, ana)).posts[0].Status, "Agendado");
});

test("remover post devolve a ideia para Guardadas", async () => {
  const post = (await chamar({ acao: "pauta" }, ana)).posts[0];
  assert.equal((await chamar({ acao: "removerPost", id: post.id }, ana)).status, 200);
  const p = await chamar({ acao: "pauta" }, ana);
  assert.equal(p.posts.length, 0);
  assert.equal(p.ideias[0].Status, "Guardada");
});

test("cinco senhas erradas bloqueiam o login", async () => {
  for (let i = 0; i < 5; i++) await chamar({ acao: "entrar", email: "carla@exemplo.com", senha: "errada" });
  const r = await chamar({ acao: "entrar", email: "carla@exemplo.com", senha: "segredo123" });
  assert.equal(r.status, 429);
});

test("membros: dono não pode ficar sem dono, editor não remove ninguém", async () => {
  const m = await chamar({ acao: "listarMembros" }, ana);
  const idAna = m.membros.find(x => x.email === "ana@exemplo.com").id;
  const idBob = m.membros.find(x => x.email === "bob@exemplo.com").id;
  assert.equal((await chamar({ acao: "removerMembro", usuario: idAna }, bob)).status, 403);
  assert.equal((await chamar({ acao: "mudarPapel", usuario: idAna, papel: "editor" }, ana)).status, 400);
  assert.equal((await chamar({ acao: "mudarPapel", usuario: idBob, papel: "admin" }, ana)).status, 200);
});

test("criar post: Claude escreve, Magnific gera foto, post vai para revisão", async () => {
  await chamar({ acao: "salvarIntegracao", provedor: "magnific", valor: "fpk-teste-abcdefgh" }, ana);
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Carrossel de teste', 'Carrossel', 'Instagram', 7) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 2 * 86400000).toISOString() }, ana);
  const original = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url, op = {}) => {
    pedidos.push(String(url));
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    if (String(url).includes("anthropic.com")) {
      assert.equal(op.headers["x-api-key"], "sk-ant-teste-1234567890");
      return json({ content: [{ type: "text", text: JSON.stringify({ legenda: "Legenda", hashtags: ["#a"], slides: [{ n: 1, titulo: "Capa", texto: "x", usa_imagem: true }, { n: 2, titulo: "Fim", texto: "" }], cenas: [], prompts_imagem: [{ slide: 1, prompt: "a photo", proporcao: "4:5" }] }) }], stop_reason: "end_turn" });
    }
    if (String(url).endsWith("/v1/ai/mystic") && op.method === "POST") return json({ data: { task_id: "t1", status: "CREATED" } });
    if (String(url).includes("/v1/ai/mystic/t1")) return json({ data: { status: "COMPLETED", generated: ["https://cdn.exemplo/foto.jpg"] } });
    if (String(url) === "https://cdn.exemplo/foto.jpg") return new Response(Buffer.from(JPG, "base64"), { headers: { "content-type": "image/jpeg" } });
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "criarPost", id }, bob)).status, 200);
    await puxar();
    for (let k = 0; k < 100; k++) {
      const st = (await db().query("select status from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0].status;
      if (st === "feito" || st === "erro") break;
      await new Promise(r => setTimeout(r, 50));
    }
  } finally { globalThis.fetch = original; }
  const t = (await db().query("select status, erro from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0];
  assert.equal(t.status, "feito", t.erro || "");
  const p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === id);
  assert.equal(p.Status, "EmRevisao");
  assert.equal(p.Legenda, "Legenda");
  assert.equal(p.Fotos.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(p.ImagensSlides)), ["1"]);
  assert.ok(pedidos.some(u => u.includes("api.freepik.com/v1/ai/mystic")));
});

test("importar do Airtable traz marca, fontes, ideias e calendário sem guardar o token", async () => {
  await import("../src/tarefas/importar.js");
  const original = globalThis.fetch;
  const tabelas = {
    Marca: [{ id: "recM", fields: { Nome: "Easypeasy Pay", Pilares: ["Produto"], Redes: ["Instagram"], Idioma: "Português (Brasil)", Logo: [{ url: "https://dl.airtable/logo.png", filename: "logo.png" }] } }],
    Fontes: [{ id: "recF", fields: { Nome: "@concorrente", Tipo: "Perfil", Rede: "Instagram", Peso: 4, Ativa: true } }],
    Ideias: [{ id: "recI", fields: { Titulo: "Ideia importada", Status: "Aprovada", Score: 9, Formato: "Carrossel" } }],
    Calendario: [{ id: "recC", fields: { Titulo: "Post importado", DataPublicacao: new Date(Date.now() + 86400000).toISOString(), Status: "EmRevisao", Formato: "Carrossel", Rede: "Instagram",
      Slides: JSON.stringify([{ n: 1, titulo: "Capa" }]), ImagensSlides: JSON.stringify({ 1: "x" }), Fotos: [{ url: "https://dl.airtable/foto.jpg", filename: "foto.jpg" }], Ideia: ["recI"] } }],
  };
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    const m = u.match(/api\.airtable\.com\/v0\/app[A-Za-z0-9]{14}\/([^?]+)/);
    if (m) { assert.equal(op.headers.authorization, "Bearer patTESTE1234567890abcdef"); return new Response(JSON.stringify({ records: tabelas[decodeURIComponent(m[1])] || [] })); }
    if (u.startsWith("https://dl.airtable/")) return new Response(Buffer.from(JPG, "base64"), { headers: { "content-type": u.endsWith(".png") ? "image/png" : "image/jpeg" } });
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "importarAirtable", base: "app0V0dEQB4ksFTUV", token: "patTESTE1234567890abcdef" }, bob)).status, 200); // bob virou admin no teste anterior
    await puxar();
    for (let k = 0; k < 100; k++) {
      const st = (await db().query("select status from tarefas where tipo = 'importar' order by criado_em desc limit 1")).rows[0].status;
      if (st === "feito" || st === "erro") break;
      await new Promise(r => setTimeout(r, 50));
    }
  } finally { globalThis.fetch = original; }
  const t = (await db().query("select status, erro, payload from tarefas where tipo = 'importar' order by criado_em desc limit 1")).rows[0];
  assert.equal(t.status, "feito", t.erro || "");
  assert.equal(t.payload.token, undefined);
  assert.deepEqual(t.payload.resultado, { marca: 1, fontes: 1, ideias: 1, posts: 1 });
  const l = await chamar({ acao: "listar" }, ana);
  assert.equal(l.marca.Nome, "Easypeasy Pay");
  assert.equal(l.marca.Logo.length, 1);
  const p = await chamar({ acao: "pauta" }, ana);
  const post = p.posts.find(x => x.Titulo === "Post importado");
  assert.equal(post.Fotos.length, 1);
  assert.equal(post.Ideia.length, 1);
  assert.equal(JSON.stringify(p).includes("patTESTE"), false);
});
