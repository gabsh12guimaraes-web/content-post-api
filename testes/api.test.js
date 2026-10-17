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
  let corpoClaude = null;
  assert.equal((await chamar({ acao: "enviarArquivoMarca", campo: "MoodBoard", tipo: "image/jpeg", nome: "mood.jpg", base64: JPG }, ana)).status, 200);
  globalThis.fetch = async (url, op = {}) => {
    pedidos.push(String(url));
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    if (String(url).includes("anthropic.com")) {
      assert.equal(op.headers["x-api-key"], "sk-ant-teste-1234567890");
      corpoClaude = JSON.parse(op.body);
      return json({ content: [{ type: "text", text: JSON.stringify({ legenda: "Legenda", hashtags: ["#a"], slides: [{ n: 1, titulo: "Capa", texto: "x", usa_imagem: true }, { n: 2, titulo: "Fim", texto: "" }], cenas: [], prompts_imagem: [{ slide: 1, prompt: "a photo", proporcao: "4:5" }] }) }], stop_reason: "end_turn" });
    }
    if (String(url).endsWith("/v1/ai/mystic") && op.method === "POST") return json({ data: { task_id: "t1", status: "CREATED" } });
    if (String(url).includes("/v1/ai/mystic/t1")) return json({ data: { status: "COMPLETED", generated: ["https://cdn.exemplo/foto.jpg"] } });
    if (String(url) === "https://cdn.exemplo/foto.jpg") return new Response(Buffer.from(JPG, "base64"), { headers: { "content-type": "image/jpeg" } });
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "criarPost", id, briefing: { capa: "video", fundo: "misto", slides: "7", objetivo: "educar", hack: "x" } }, bob)).status, 200);
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
  // Briefing e mood board chegam ao Claude; o mood board vai em base64, sem link.
  const conteudo = corpoClaude.messages[0].content;
  const textoFinal = conteudo[conteudo.length - 1].text;
  assert.ok(textoFinal.includes("<briefing>"));
  assert.ok(textoFinal.includes("capa (slide 1) em vídeo"));
  assert.ok(textoFinal.includes("exatamente 7 slides"));
  assert.equal(conteudo.find(b => b.type === "image").source.type, "base64");
  assert.equal(JSON.parse(p.Briefing).hack, undefined);
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

test("buscar ideias guarda o pedido; mudar data e publicar agora", async () => {
  assert.equal((await chamar({ acao: "buscarIdeias", tema: "golpes", quantidade: 5, formatos: ["Reels", "Inventado"] }, ana)).status, 200);
  const t = (await db().query("select payload from tarefas where tipo = 'ideias' order by criado_em desc limit 1")).rows[0];
  assert.deepEqual(t.payload, { tema: "golpes", quantidade: 5, formatos: ["Reels"] });
  await db().query("delete from tarefas where tipo = 'ideias'");

  await chamar({ acao: "salvarIntegracao", provedor: "zernio", valor: "sk_zernio_teste_1234" }, ana);
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Para publicar', 'Estatico', 'Instagram', 7) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 5 * 86400000).toISOString() }, ana);
  const nova = new Date(Date.now() + 9 * 86400000).toISOString();
  assert.equal((await chamar({ acao: "reagendarPost", id, data: nova }, bob)).status, 200);
  assert.equal(new Date((await db().query("select data_publicacao from posts where id = $1", [id])).rows[0].data_publicacao).toISOString(), nova);
  assert.equal((await chamar({ acao: "publicarAgora", id }, ana)).status, 400); // ainda não está agendado
  await chamar({ acao: "salvarArtes", id, artes: [{ tipo: "image/jpeg", base64: JPG }] }, ana);
  await db().query("update posts set status = 'Agendado' where id = $1", [id]);
  const original = globalThis.fetch;
  let corpoZernio = null;
  process.env.ZERNIO_INTERVALO_MS = "5";
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    if (u.endsWith("zernio.com/api/v1/accounts")) return new Response(JSON.stringify({ accounts: [{ _id: "acc1", platform: "instagram", username: "easypeasy", isActive: true }] }));
    if (u.endsWith("zernio.com/api/v1/posts")) { corpoZernio = JSON.parse(op.body); return new Response(JSON.stringify({ message: "ok", post: { _id: "z1", status: "publishing", platforms: [{ platform: "instagram", status: "publishing" }] } }), { status: 201 }); }
    if (u.endsWith("zernio.com/api/v1/posts/z1")) return new Response(JSON.stringify({ post: { _id: "z1", status: "published", platforms: [{ platform: "instagram", status: "published", platformPostUrl: "https://instagram.com/p/teste" }] } }));
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "publicarAgora", id }, ana)).status, 200);
    for (let k = 0; k < 100; k++) { if ((await db().query("select status from posts where id = $1", [id])).rows[0].status !== "Publicando") break; await new Promise(r => setTimeout(r, 30)); }
  } finally { globalThis.fetch = original; }
  const p = (await db().query("select status, link_publicado from posts where id = $1", [id])).rows[0];
  assert.equal(p.status, "Publicado");
  assert.equal(p.link_publicado, "https://instagram.com/p/teste");
  assert.deepEqual(corpoZernio.platforms, [{ platform: "instagram", accountId: "acc1" }]);
  assert.equal(corpoZernio.publishNow, true);
  assert.deepEqual(corpoZernio.mediaItems.map(m => m.type), ["image"]);
});

test("planos: limite do teste, aviso da Kiwify ativa o plano e assinatura falsa é recusada", async () => {
  const r = await chamar({ acao: "cadastrar", nome: "Duda", email: "duda@exemplo.com", senha: "segredo123", organizacao: "Loja da Duda" });
  const duda = r.token, org = r.organizacao.id;
  const cat = await chamar({ acao: "planos" });
  assert.equal(cat.planos.length, 3);
  assert.equal(cat.planos.find(p => p.id === "profissional").ciclos.find(c => c.ciclo === "anual").total, 729 * 12);

  process.env.COBRANCA = "sim";
  try {
    for (let k = 0; k < 2; k++) {
      assert.equal((await chamar({ acao: "buscarIdeias" }, duda)).status, 200, "busca " + k);
      await db().query("update tarefas set status = 'feito' where org_id = $1", [org]);
    }
    const bloqueio = await chamar({ acao: "buscarIdeias" }, duda);
    assert.equal(bloqueio.status, 402);
    assert.equal(bloqueio.plano, true);

    // Assinatura errada: nada muda.
    process.env.KIWIFY_TOKEN = "tok-teste";
    const corpo = JSON.stringify({ order_id: "ped-1", webhook_event_type: "order_approved", order_status: "paid",
      Product: { product_id: "p1", product_name: "Content Post Profissional Anual" }, Customer: { email: "outra@pessoa.com" },
      TrackingParameters: { sck: org }, Subscription: { id: "sub-1", plan: { name: "Anual", frequency: "yearly" } } });
    const ruim = await app.inject({ method: "POST", url: "/kiwify?signature=abc", payload: corpo, headers: { "content-type": "application/json" } });
    assert.equal(ruim.statusCode, 401);
    const sig = crypto.createHmac("sha1", "tok-teste").update(corpo).digest("hex");
    const bom = await app.inject({ method: "POST", url: "/kiwify?signature=" + sig, payload: corpo, headers: { "content-type": "application/json" } });
    assert.equal(bom.statusCode, 200);
    assert.match(bom.json().resultado, /ativado profissional:anual/);
    const de_novo = await app.inject({ method: "POST", url: "/kiwify?signature=" + sig, payload: corpo, headers: { "content-type": "application/json" } });
    assert.equal(de_novo.json().repetido, true);

    const p = await chamar({ acao: "plano" }, duda);
    assert.equal(p.situacao.plano, "profissional");
    assert.equal(p.situacao.ativo, true);
    assert.equal(p.situacao.ideias.usadas, 2, "no plano pago contam as buscas do mês");
    assert.equal(p.situacao.ideias.limite, 20);
    assert.match(p.planos[0].ciclos[0].checkout || "sem-link", /sem-link|sck=/);
  } finally { delete process.env.COBRANCA; delete process.env.KIWIFY_TOKEN; }
});

test("editar textos depois de pronto e ajustar um slide só", async () => {
  const p0 = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.Legenda === "Legenda" && x.Status === "EmRevisao");
  assert.ok(p0, "post do teste de criação");
  const brutos = JSON.parse(p0.Slides);
  brutos[0].titulo = "Capa editada"; brutos[0].prompt_secreto = "não deveria entrar";
  assert.equal((await chamar({ acao: "salvarTextos", id: p0.id, slides: brutos, legenda: "Legenda nova", hashtags: "#x #y" }, bob)).status, 200);
  let p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === p0.id);
  const s1 = JSON.parse(p.Slides);
  assert.equal(s1[0].titulo, "Capa editada");
  assert.equal(s1[0].usa_imagem, true, "mantém os outros campos do slide");
  assert.equal(s1[0].prompt_secreto, undefined, "não aceita campos novos");
  assert.equal(p.Legenda, "Legenda nova");

  const original = globalThis.fetch, pedidos = [];
  globalThis.fetch = async (url, op = {}) => {
    pedidos.push(String(url));
    if (String(url).includes("anthropic.com")) return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({
      legenda: "Claude mudou a legenda", hashtags: ["#z"], cenas: [], prompts_imagem: [{ slide: 1, prompt: "outra", proporcao: "4:5" }],
      slides: [{ n: 1, titulo: "Claude mudou a capa", texto: "x", usa_imagem: true }, { n: 2, titulo: "Fim novo", texto: "agora com texto" }],
      alterou_legenda: true, alterou_slides: [1, 2], alterou_imagens: [1], resumo_mudancas: "mudou tudo" }) }], stop_reason: "end_turn" }), { headers: { "content-type": "application/json" } });
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "ajustarPost", id: p0.id, comentario: "[Ajuste somente no slide 2.] melhore o fim", slide: 2 }, bob)).status, 200);
    await puxar();
    for (let k = 0; k < 100; k++) {
      const st = (await db().query("select status from tarefas where tipo = 'ajustar' order by criado_em desc limit 1")).rows[0].status;
      if (st === "feito" || st === "erro") break;
      await new Promise(r => setTimeout(r, 50));
    }
  } finally { globalThis.fetch = original; }
  const t = (await db().query("select status, erro from tarefas where tipo = 'ajustar' order by criado_em desc limit 1")).rows[0];
  assert.equal(t.status, "feito", t.erro || "");
  p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === p0.id);
  const s2 = JSON.parse(p.Slides);
  assert.equal(s2[0].titulo, "Capa editada", "slide 1 não muda");
  assert.equal(s2[1].titulo, "Fim novo", "slide 2 muda");
  assert.equal(p.Legenda, "Legenda nova", "legenda não muda");
  assert.ok(!pedidos.some(u => u.includes("/v1/ai/mystic")), "não gera imagem de outro slide");
});

test("story em imagem estática gera 1 foto vertical e nenhum clipe", async () => {
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Story de teste', 'Stories', 'Instagram', 7) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 3 * 86400000).toISOString() }, ana);
  const original = globalThis.fetch, pedidos = [];
  let corpoClaude = null, corpoMystic = null;
  globalThis.fetch = async (url, op = {}) => {
    pedidos.push(String(url));
    const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (String(url).includes("anthropic.com")) {
      corpoClaude = JSON.parse(op.body);
      return json({ content: [{ type: "text", text: JSON.stringify({ legenda: "", hashtags: [], cenas: [], slides: [{ n: 1, titulo: "Vem aí", texto: "", usa_imagem: true }], prompts_imagem: [{ slide: 1, prompt: "a phone", proporcao: "9:16" }] }) }], stop_reason: "end_turn" });
    }
    if (String(url).endsWith("/v1/ai/mystic") && op.method === "POST") { corpoMystic = JSON.parse(op.body); return json({ data: { task_id: "t9", status: "CREATED" } }); }
    if (String(url).includes("/v1/ai/mystic/t9")) return json({ data: { status: "COMPLETED", generated: ["https://cdn.exemplo/story.jpg"] } });
    if (String(url) === "https://cdn.exemplo/story.jpg") return new Response(Buffer.from(JPG, "base64"), { headers: { "content-type": "image/jpeg" } });
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "criarPost", id, briefing: { story: "imagem", fundo: "fotos", cenas: "5" } }, ana)).status, 200);
    await puxar();
    for (let k = 0; k < 100; k++) {
      const st = (await db().query("select status from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0].status;
      if (st === "feito" || st === "erro") break;
      await new Promise(r => setTimeout(r, 50));
    }
  } finally { globalThis.fetch = original; }
  const t = (await db().query("select status, erro from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0];
  assert.equal(t.status, "feito", t.erro || "");
  const textoFinal = corpoClaude.messages[0].content;
  assert.ok(String(typeof textoFinal === "string" ? textoFinal : JSON.stringify(textoFinal)).includes("IMAGEM ESTÁTICA"));
  assert.equal(corpoMystic.aspect_ratio, "social_story_9_16");
  assert.ok(!pedidos.some(u => u.includes("/v1/ai/video/")), "não gera clipe");
  const p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === id);
  assert.equal(JSON.parse(p.Slides).length, 1);
  assert.equal(p.Fotos.length, 1);
  assert.equal(JSON.parse(p.Briefing).story, "imagem");
});

test("cada rede recebe o texto e as mídias que aceita; escolher redes do post", async () => {
  const { conteudoPara } = await import("../src/tarefas/trabalhos.js");
  const fotos = Array.from({ length: 6 }, (_, i) => ({ type: "image", url: "https://x/" + i + ".jpg" }));
  const longa = "palavra ".repeat(120).trim();
  const post = { titulo: "Coisas que você não precisa mais fazer no bar", legenda: longa, hashtags: "#bar #pix", formato: "Carrossel" };
  const x = conteudoPara("X", post, fotos);
  assert.ok(x.legenda.length <= 280 && x.legenda.endsWith("…"));
  assert.equal(x.midias.length, 4);
  assert.ok(conteudoPara("Threads", post, fotos).legenda.length <= 500);
  const tt = conteudoPara("TikTok", post, fotos);
  assert.equal(tt.opcoes.tiktokSettings.media_type, "photo");
  assert.ok(tt.legenda.length <= 90);
  const ttv = conteudoPara("TikTok", { ...post, formato: "Reels" }, [{ type: "video", url: "https://x/v.mp4" }]);
  assert.equal(ttv.opcoes.tiktokSettings.allow_duet, true);
  assert.equal(conteudoPara("Facebook", { ...post, formato: "Reels" }, [{ type: "video", url: "https://x/v.mp4" }]).opcoes.contentType, "reel");
  assert.ok(conteudoPara("X", { ...post, formato: "Stories" }, fotos).erro);
  assert.equal(conteudoPara("Instagram", { ...post, formato: "Stories" }, fotos.slice(0, 1)).opcoes.contentType, "story");

  const p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.Status === "EmRevisao");
  assert.deepEqual(p.Redes, [p.Rede]);
  assert.equal((await chamar({ acao: "salvarRedes", id: p.id, redes: ["Instagram", "X", "Orkut", "X"] }, bob)).status, 200);
  assert.deepEqual((await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === p.id).Redes, ["Instagram", "X"]);
  assert.equal((await chamar({ acao: "salvarRedes", id: p.id, redes: [] }, bob)).status, 400);
});

test("a chave de publicação da plataforma nunca é usada por clientes", async () => {
  process.env.COBRANCA = "sim"; process.env.PLATAFORMA_ZERNIO = "sk_zernio_da_plataforma"; process.env.PLATAFORMA_ANTHROPIC = "sk-ant-da-plataforma";
  try {
    const r = await chamar({ acao: "cadastrar", nome: "Eva", email: "eva@exemplo.com", senha: "segredo123", organizacao: "Loja da Eva" });
    const { chaveDe } = await import("../src/provedores/index.js");
    assert.equal(await chaveDe(r.organizacao.id, "anthropic"), "sk-ant-da-plataforma");
    await assert.rejects(() => chaveDe(r.organizacao.id, "zernio"), /não está cadastrada/);
  } finally { delete process.env.COBRANCA; delete process.env.PLATAFORMA_ZERNIO; delete process.env.PLATAFORMA_ANTHROPIC; }
});
