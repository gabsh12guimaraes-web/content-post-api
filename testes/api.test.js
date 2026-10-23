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
  // A foto gerada também fica no banco de imagens, para reutilizar sem gastar créditos.
  const banco = (await chamar({ acao: "listarBanco" }, ana)).imagens;
  const gerada = banco.find(x => x.origem === "ia" && x.post === id);
  assert.ok(gerada, "foto gerada vai para o banco");
  assert.ok(JSON.parse(p.ImagensSlides)["1"].includes(gerada.arquivo.id));
  assert.equal(gerada.descricao, "a photo");
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
  // As publicações simuladas usam somente contas explicitamente atribuídas à organização.
  for (const conta of ["acc1", "ig", "fb"]) await db().query("insert into zernio_contas (conta_id, org_id, credencial_hash) values ($1, $2, $3)", [conta, anaOrg, crypto.createHash("sha256").update("sk_zernio_teste_1234").digest("hex")]);
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
  assert.deepEqual(corpoZernio.platforms, [{ platform: "instagram", accountId: "acc1", platformSpecificData: { isAiGenerated: true } }]);
  assert.equal(corpoZernio.publishNow, true);
  assert.deepEqual(corpoZernio.mediaItems.map(m => m.type), ["image"]);
});

test("planos: limite do teste, aviso da Kiwify ativa o plano e assinatura falsa é recusada", async () => {
  const r = await chamar({ acao: "cadastrar", nome: "Duda", email: "duda@exemplo.com", senha: "segredo123", organizacao: "Loja da Duda" });
  const duda = r.token, org = r.organizacao.id;
  const cat = await chamar({ acao: "planos" });
  assert.equal(cat.planos.length, 3);
  assert.equal(cat.planos.find(p => p.id === "profissional").ciclos.find(c => c.ciclo === "anual").total, 4811.4);
  process.env.NASTEN_CHECKOUT = JSON.stringify({ "essencial:mensal": "https://app.nasten.com.br/checkout/abc?coupon=ESSENCIALMENSAL&utm_source=teste" });
  const em = (await chamar({ acao: "planos" })).planos.find(p => p.id === "essencial").ciclos.find(c => c.ciclo === "mensal");
  delete process.env.NASTEN_CHECKOUT;
  assert.equal(em.porMes, 177.12);
  assert.equal(em.checkout, "https://app.nasten.com.br/checkout/abc?utm_source=teste");
  assert.equal(em.cupom, null);

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
    // Aviso reenviado com os valores da cobrança (cupom): não reativa nada, mas grava o valor real pago e o líquido.
    const comValor = JSON.stringify({ ...JSON.parse(corpo), Commissions: { charge_amount: "8990", my_commission: "8147", currency: "BRL" } });
    const sigV = crypto.createHmac("sha1", "tok-teste").update(comValor).digest("hex");
    const reenvio = await app.inject({ method: "POST", url: "/kiwify?signature=" + sigV, payload: comValor, headers: { "content-type": "application/json" } });
    assert.equal(reenvio.json().repetido, true);
    const v = (await db().query("select pago_centavos, liquido_centavos from organizacoes where id = $1", [org])).rows[0];
    assert.deepEqual([v.pago_centavos, v.liquido_centavos], [8990, 8147]);

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
  // Mudar só a legenda não obriga a gerar as artes (ou o vídeo) de novo; mudar o texto da arte, sim.
  await db().query("update posts set artes_prontas = true where id = $1", [p0.id]);
  const so = await chamar({ acao: "salvarTextos", id: p0.id, slides: s1, legenda: "Só a legenda", hashtags: "#x" }, bob);
  assert.equal(so.artesProntas, true);
  assert.equal((await db().query("select artes_prontas from posts where id = $1", [p0.id])).rows[0].artes_prontas, true);
  s1[0].titulo = "Capa editada de novo";
  assert.equal((await chamar({ acao: "salvarTextos", id: p0.id, slides: s1, legenda: "Só a legenda", hashtags: "#x" }, bob)).artesProntas, false);
  assert.equal((await db().query("select artes_prontas from posts where id = $1", [p0.id])).rows[0].artes_prontas, false);
  s1[0].titulo = "Capa editada"; await chamar({ acao: "salvarTextos", id: p0.id, slides: s1, legenda: "Legenda nova", hashtags: "#x #y" }, bob);

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

test("redes conectadas: um profile do Zernio por organização e cada uma publica só nas próprias contas", async () => {
  process.env.COBRANCA = "sim"; process.env.PLATAFORMA_ZERNIO = "sk_zernio_da_plataforma"; process.env.ZERNIO_INTERVALO_MS = "5";
  const original = globalThis.fetch;
  const pedidos = [], perfis = new Map(); let corpoPost = null, n = 0;
  // Contas na conta Zernio da plataforma, em profiles diferentes. O simulador ignora o filtro de profile de propósito,
  // para provar que a API confere o profile de cada conta antes de usar.
  const contas = [];
  const simulado = async (url, op = {}) => {
    const u = new URL(String(url)), metodo = op.method || "GET";
    if (u.host !== "zernio.com") return original(url, op);
    pedidos.push({ metodo, caminho: u.pathname, busca: u.searchParams, chave: op.headers.authorization, corpo: op.body ? JSON.parse(op.body) : null });
    if (u.pathname === "/api/v1/profiles" && metodo === "POST") {
      const b = JSON.parse(op.body);
      if (perfis.has(b.externalId)) return new Response(JSON.stringify({ error: "existe", code: "profile_external_id_conflict" }), { status: 409 });
      const id = "perfil" + (++n); perfis.set(b.externalId, id);
      return new Response(JSON.stringify({ profile: { _id: id, name: b.name, externalId: b.externalId } }), { status: 201 });
    }
    if (u.pathname === "/api/v1/profiles") { const e = u.searchParams.get("externalId"); return new Response(JSON.stringify({ profiles: perfis.has(e) ? [{ _id: perfis.get(e), externalId: e }] : [] })); }
    if (u.pathname.startsWith("/api/v1/connect/")) return new Response(JSON.stringify({ authUrl: `https://zernio.com/oauth/${u.pathname.split("/").pop()}?p=${u.searchParams.get("profileId")}` }));
    if (u.pathname === "/api/v1/accounts") return new Response(JSON.stringify({ accounts: contas }));
    if (u.pathname.startsWith("/api/v1/accounts/") && metodo === "DELETE") return new Response(JSON.stringify({ message: "ok" }));
    if (u.pathname === "/api/v1/posts") { corpoPost = JSON.parse(op.body); return new Response(JSON.stringify({ post: { _id: "zp", status: "published", platforms: [{ status: "published", platformPostUrl: "https://instagram.com/p/fabio" }] } }), { status: 201 }); }
    return new Response("{}", { status: 404 });
  };
  globalThis.fetch = simulado;
  const midias = [{ type: "image", url: "https://x/a.jpg" }];
  try {
    const f = await chamar({ acao: "cadastrar", nome: "Fábio", email: "fabio@exemplo.com", senha: "segredo123", organizacao: "Loja do Fábio" });
    const g = await chamar({ acao: "cadastrar", nome: "Gil", email: "gil@exemplo.com", senha: "segredo123", organizacao: "Loja do Gil" });
    const fabio = f.token, gil = g.token, orgF = f.organizacao.id, orgG = g.organizacao.id;
    const { publicarZernio } = await import("../src/provedores/index.js");

    // Antes de conectar: modo plataforma, nada conectado, e nada é pedido ao Zernio.
    const vazio = await chamar({ acao: "contasRedes" }, fabio);
    assert.equal(vazio.modo, "plataforma");
    assert.deepEqual(vazio.contas, []);
    assert.deepEqual(vazio.redes, ["Instagram", "Facebook", "TikTok", "X", "Threads"]);
    assert.match((await publicarZernio(orgF, { rede: "instagram", midias, legenda: "oi", chave: "t0" })).erro, /Redes conectadas/);
    assert.equal(pedidos.length, 0);

    // Primeira conexão cria o profile da organização e devolve o link do Zernio com o profile dela.
    const c = await chamar({ acao: "conectarRede", rede: "Instagram", voltar: "https://gabsh12guimaraes-web.github.io/app.html?x=1#integracoes" }, fabio);
    assert.equal(c.status, 200);
    assert.equal(c.url, "https://zernio.com/oauth/instagram?p=perfil1");
    const criar = pedidos.find(p => p.caminho === "/api/v1/profiles");
    assert.equal(criar.corpo.externalId, orgF);
    assert.equal(criar.chave, "Bearer sk_zernio_da_plataforma");
    const ligar = pedidos.find(p => p.caminho === "/api/v1/connect/instagram");
    assert.equal(ligar.busca.get("profileId"), "perfil1");
    assert.equal(ligar.busca.get("redirect_url"), "https://gabsh12guimaraes-web.github.io/app.html?x=1");
    assert.equal(ligar.busca.get("welcome"), "true");
    assert.equal(ligar.busca.get("brandName"), "Easy Content Post");
    assert.equal(ligar.busca.get("loginMethod"), null);
    await chamar({ acao: "conectarRede", rede: "Instagram", via: "facebook" }, fabio);
    assert.equal(pedidos.filter(p => p.caminho === "/api/v1/connect/instagram").at(-1).busca.get("loginMethod"), "facebook_login");
    assert.equal((await db().query("select zernio_profile from organizacoes where id = $1", [orgF])).rows[0].zernio_profile, "perfil1");
    // Segunda conexão reaproveita o profile; volta para site de fora não é repassada.
    await chamar({ acao: "conectarRede", rede: "X", voltar: "https://site-malicioso.com/" }, fabio);
    assert.equal(pedidos.filter(p => p.caminho === "/api/v1/profiles").length, 1);
    assert.equal(pedidos.find(p => p.caminho === "/api/v1/connect/twitter").busca.get("redirect_url"), null);
    assert.equal((await chamar({ acao: "conectarRede", rede: "Orkut" }, fabio)).status, 400);
    // Se o profile já existe no Zernio (tentativa anterior que não gravou), acha pelo externalId em vez de criar outro.
    await db().query("update organizacoes set zernio_profile = null where id = $1", [orgF]);
    assert.equal((await chamar({ acao: "conectarRede", rede: "Instagram" }, fabio)).url, "https://zernio.com/oauth/instagram?p=perfil1");
    assert.equal((await db().query("select zernio_profile from organizacoes where id = $1", [orgF])).rows[0].zernio_profile, "perfil1");

    // Gil ganha outro profile.
    assert.equal((await chamar({ acao: "conectarRede", rede: "X" }, gil)).url, "https://zernio.com/oauth/twitter?p=perfil2");
    contas.push(
      { _id: "ig-fabio", platform: "instagram", profileId: "perfil1", username: "lojadofabio", isActive: true },
      { _id: "x-gil", platform: "twitter", profileId: { _id: "perfil2", name: "Loja do Gil" }, username: "lojadogil", isActive: true },
      { _id: "ig-dono", platform: "instagram", profileId: "perfil-do-dono", username: "dono", isActive: true },
    );
    const lf = await chamar({ acao: "contasRedes" }, fabio);
    assert.deepEqual(lf.contas.map(x => [x.id, x.rede, x.usuario]), [["ig-fabio", "Instagram", "lojadofabio"]]);
    assert.equal(pedidos.at(-1).busca.get("profileId"), "perfil1");
    assert.deepEqual((await chamar({ acao: "redesConectadas" }, gil)).redes, ["X"]);

    // Gil não tem Instagram: não publica, nem na conta do Fábio nem na do dono da plataforma.
    const rg = await publicarZernio(orgG, { rede: "instagram", midias, legenda: "oi", chave: "t1" });
    assert.equal(rg.ok, false);
    assert.match(rg.erro, /nenhuma conta de Instagram conectada/);
    assert.equal(corpoPost, null);

    // O post do Fábio, publicado pelo painel, sai só na conta dele.
    const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Post do Fábio', 'Estatico', 'Instagram', 7) returning id", [orgF])).rows[0].id;
    const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 86400000).toISOString() }, fabio);
    await chamar({ acao: "salvarArtes", id, artes: [{ tipo: "image/jpeg", base64: JPG }] }, fabio);
    await db().query("update posts set status = 'Agendado' where id = $1", [id]);
    assert.equal((await chamar({ acao: "publicarAgora", id }, fabio)).status, 200);
    for (let k = 0; k < 100; k++) { if ((await db().query("select status from posts where id = $1", [id])).rows[0].status !== "Publicando") break; await new Promise(r => setTimeout(r, 30)); }
    assert.equal((await db().query("select status from posts where id = $1", [id])).rows[0].status, "Publicado");
    assert.deepEqual(corpoPost.platforms, [{ platform: "instagram", accountId: "ig-fabio", platformSpecificData: { isAiGenerated: true } }]);

    // Desconectar: só contas da própria organização; editor não pode.
    assert.equal((await chamar({ acao: "desconectarRede", conta: "x-gil" }, fabio)).status, 400);
    assert.equal(pedidos.some(x => x.metodo === "DELETE"), false);
    assert.equal((await chamar({ acao: "desconectarRede", conta: "ig-fabio" }, fabio)).status, 200);
    assert.equal(pedidos.find(x => x.metodo === "DELETE").caminho, "/api/v1/accounts/ig-fabio");
    const conv = await chamar({ acao: "convidar", email: "hel@exemplo.com", papel: "editor" }, gil);
    const hel = (await chamar({ acao: "cadastrar", nome: "Hel", email: "hel@exemplo.com", senha: "segredo123", convite: conv.convite })).token;
    assert.equal((await chamar({ acao: "conectarRede", rede: "Instagram" }, hel)).status, 403);
    assert.equal((await chamar({ acao: "desconectarRede", conta: "x-gil" }, hel)).status, 403);

    // Plano vencido: a chave da plataforma não é usada.
    await db().query("update organizacoes set plano_ate = now() - interval '1 day' where id = $1", [orgG]);
    assert.equal((await chamar({ acao: "contasRedes" }, gil)).modo, null);
    assert.equal((await chamar({ acao: "conectarRede", rede: "X" }, gil)).status, 400);
    await assert.rejects(() => publicarZernio(orgG, { rede: "twitter", midias, legenda: "oi", chave: "t2" }), /plano não está ativo/);

    // Chave própria não libera todas as contas: exige seleção explícita.
    await chamar({ acao: "salvarIntegracao", provedor: "zernio", valor: "sk_zernio_do_fabio" }, fabio);
    const propria = await chamar({ acao: "contasRedes" }, fabio);
    assert.equal(propria.modo, "propria");
    assert.deepEqual(propria.contas, []);
    assert.equal(propria.precisaChave, true);
    assert.equal((await chamar({ acao: "vincularContas", contas: ["ig-dono"], chave: "sk_zernio_do_fabio" }, fabio)).status, 200);
    assert.deepEqual((await chamar({ acao: "contasRedes" }, fabio)).contas.map(c => c.id), ["ig-dono"]);
    assert.equal(pedidos.at(-1).chave, "Bearer sk_zernio_do_fabio");
    assert.equal(pedidos.at(-1).busca.get("profileId"), null);
    assert.equal((await chamar({ acao: "conectarRede", rede: "Instagram" }, fabio)).status, 400);
  } finally { globalThis.fetch = original; delete process.env.COBRANCA; delete process.env.PLATAFORMA_ZERNIO; }
});

test("banco de imagens: descreve, cria post só com fotos do banco, troca foto e protege o arquivo", async () => {
  const original = globalThis.fetch, pedidos = [];
  let corpoPost = null;
  globalThis.fetch = async (url, op = {}) => {
    pedidos.push(String(url));
    const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (String(url).includes("anthropic.com")) {
      const corpo = JSON.parse(op.body);
      if (String(corpo.system).includes("banco de imagens de uma marca")) return json({ content: [{ type: "text", text: JSON.stringify({ nome: "Camiseta preta", descricao: "Camiseta preta oversized em fundo branco", tags: ["camiseta", "preta"] }) }], stop_reason: "end_turn" });
      corpoPost = corpo;
      return json({ content: [{ type: "text", text: JSON.stringify({ legenda: "Nova coleção", hashtags: ["#moda"], cenas: [], prompts_imagem: [{ slide: 1, prompt: "não deveria gerar", proporcao: "4:5" }],
        slides: [{ n: 1, titulo: "Chegou", texto: "A preta que combina com tudo", usa_imagem: true, imagem_banco: "b1" }, { n: 2, titulo: "Garanta a sua", texto: "" }] }) }], stop_reason: "end_turn" });
    }
    return original(url, op);
  };
  try {
    const env = await chamar({ acao: "enviarImagemBanco", tipo: "image/jpeg", nome: "camiseta.jpg", base64: JPG }, ana);
    assert.equal(env.status, 200);
    await puxar();
    for (let k = 0; k < 60; k++) { const st = (await db().query("select status from tarefas where tipo = 'descreverImagem' order by criado_em desc limit 1")).rows[0].status; if (st === "feito" || st === "erro") break; await new Promise(r => setTimeout(r, 50)); }
    let banco = (await chamar({ acao: "listarBanco" }, ana)).imagens;
    const foto = banco.find(x => x.id === env.id);
    assert.equal(foto.nome, "Camiseta preta");
    assert.deepEqual(foto.tags, ["camiseta", "preta"]);

    const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Nova coleção', 'Carrossel', 'Instagram', 8) returning id", [anaOrg])).rows[0].id;
    const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 4 * 86400000).toISOString() }, ana);
    assert.equal((await chamar({ acao: "criarPost", id, briefing: { imagens: "banco", banco: [env.id, "nao-e-uuid"] } }, ana)).status, 200);
    await puxar();
    for (let k = 0; k < 100; k++) { const st = (await db().query("select status from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0].status; if (st === "feito" || st === "erro") break; await new Promise(r => setTimeout(r, 50)); }
    const t = (await db().query("select status, erro from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0];
    assert.equal(t.status, "feito", t.erro || "");
    const texto = JSON.stringify(corpoPost.messages[0].content);
    assert.ok(texto.includes("<banco_de_imagens>") && texto.includes("b1: Camiseta preta"));
    assert.ok(!pedidos.some(u => u.includes("/v1/ai/mystic")), "não gera imagem com IA");
    const post = (await db().query("select fotos from posts where id = $1", [id])).rows[0];
    assert.equal(post.fotos["1"], foto.arquivo.id);

    // Trocar a foto do slide 2 por uma do banco, sem IA
    assert.equal((await chamar({ acao: "trocarFotoSlide", id, slide: 2, imagem: env.id }, bob)).status, 200);
    assert.equal((await db().query("select fotos from posts where id = $1", [id])).rows[0].fotos["2"], foto.arquivo.id);

    // Remover do banco não apaga o arquivo que um post ainda usa
    assert.equal((await chamar({ acao: "removerImagemBanco", id: env.id }, ana)).status, 200);
    assert.equal((await db().query("select count(*)::int as n from arquivos where id = $1", [foto.arquivo.id])).rows[0].n, 1);
    banco = (await chamar({ acao: "listarBanco" }, ana)).imagens;
    assert.ok(!banco.some(x => x.id === env.id));
  } finally { globalThis.fetch = original; }
});

test("sem crédito no Magnific: para de pedir e avisa com clareza", async () => {
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Sem crédito', 'Carrossel', 'Instagram', 6) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 6 * 86400000).toISOString() }, ana);
  const original = globalThis.fetch; let pedidosMystic = 0;
  globalThis.fetch = async (url, op = {}) => {
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
    if (String(url).includes("anthropic.com")) return json({ content: [{ type: "text", text: JSON.stringify({ legenda: "L", hashtags: [], cenas: [],
      slides: [1, 2, 3].map(n => ({ n, titulo: "S" + n, texto: "", usa_imagem: true })), prompts_imagem: [1, 2, 3].map(n => ({ slide: n, prompt: "p", proporcao: "4:5" })) }) }], stop_reason: "end_turn" });
    if (String(url).endsWith("/v1/ai/mystic")) { pedidosMystic++; return json({ message: "Insufficient credits" }, 402); }
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "criarPost", id }, ana)).status, 200);
    await puxar();
    for (let k = 0; k < 100; k++) { const st = (await db().query("select status from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0].status; if (st === "feito" || st === "erro") break; await new Promise(r => setTimeout(r, 50)); }
  } finally { globalThis.fetch = original; }
  const p = (await db().query("select status, erro from posts where id = $1", [id])).rows[0];
  assert.equal(p.status, "EmRevisao");
  assert.match(p.erro, /sem créditos: 3 imagem/);
  assert.equal(pedidosMystic, 1, "não insiste depois do primeiro 'sem crédito'");
});

test("banco guarda o que a IA gera, reaproveita vídeo do banco e descarta o excesso antigo", async () => {
  const mod = await import("../src/tarefas/trabalhos.js");
  const MP4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex").toString("base64");
  const vid = await chamar({ acao: "enviarImagemBanco", tipo: "video/mp4", nome: "loja.mp4", base64: MP4, titulo: "Fachada da loja" }, ana);
  assert.equal(vid.status, 200);
  assert.equal((await db().query("select count(*)::int as n from tarefas where tipo = 'descreverImagem' and payload->>'imagem' = $1", [vid.id])).rows[0].n, 0, "vídeo não vai para o Claude descrever");
  const item = (await chamar({ acao: "listarBanco" }, ana)).imagens.find(x => x.id === vid.id);
  assert.equal(item.arquivo.type, "video/mp4");
  assert.equal(item.origem, "envio");

  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Reels da loja', 'Reels', 'Instagram', 7) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 7 * 86400000).toISOString() }, ana);
  const original = globalThis.fetch, pedidos = []; let corpo = null;
  globalThis.fetch = async (url, op = {}) => {
    pedidos.push(String(url));
    const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (String(url).includes("anthropic.com")) { corpo = JSON.parse(op.body); return json({ content: [{ type: "text", text: JSON.stringify({ legenda: "L", hashtags: [], slides: [], prompts_imagem: [{ slide: 1, prompt: "não gera", proporcao: "9:16" }],
      cenas: [{ n: 1, duracao_s: 5, visual: "fachada", prompt_video: "zoom lento", imagem_banco: "v1" }] }) }], stop_reason: "end_turn" }); }
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "criarPost", id, briefing: { imagens: "banco", banco: [vid.id] } }, ana)).status, 200);
    await puxar();
    for (let k = 0; k < 100; k++) { const st = (await db().query("select status from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0].status; if (st === "feito" || st === "erro") break; await new Promise(r => setTimeout(r, 50)); }
  } finally { globalThis.fetch = original; }
  const t = (await db().query("select status, erro from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0];
  assert.equal(t.status, "feito", t.erro || "");
  assert.ok(JSON.stringify(corpo.messages[0].content).includes("v1 [vídeo]: Fachada da loja"));
  assert.ok(!pedidos.some(u => u.includes("freepik.com")), "não gasta crédito do Magnific");
  const post = (await db().query("select fotos, clipes from posts where id = $1", [id])).rows[0];
  assert.equal(post.clipes["1"], item.arquivo.id);
  assert.deepEqual(post.fotos, {});

  // Acima do limite, saem as gerações mais antigas que nenhum post usa (as enviadas pela pessoa ficam).
  const { salvarArquivo } = await import("../src/arquivos.js");
  const antes = mod.LIMITE_BANCO_IA.imagem; mod.LIMITE_BANCO_IA.imagem = 1;
  try {
    const usadas = (await db().query("select b.arquivo_id from banco_imagens b where b.org_id = $1 and b.origem = 'ia' and exists (select 1 from posts p, jsonb_each_text(p.fotos) f where p.org_id = $1 and f.value = b.arquivo_id::text)", [anaOrg])).rows.map(r => r.arquivo_id);
    assert.ok(usadas.length, "há foto gerada em uso");
    const a1 = await salvarArquivo(anaOrg, { tipo: "image/jpeg", nome: "x1", dados: Buffer.from(JPG, "base64") });
    await mod.guardarNoBanco(anaOrg, a1, { nome: "um", descricao: "p1" });
    await new Promise(r => setTimeout(r, 5));
    const a2 = await salvarArquivo(anaOrg, { tipo: "image/jpeg", nome: "x2", dados: Buffer.from(JPG, "base64") });
    await mod.guardarNoBanco(anaOrg, a2, { nome: "dois", descricao: "p2" });
    const ia = (await db().query("select arquivo_id from banco_imagens where org_id = $1 and origem = 'ia'", [anaOrg])).rows.map(r => r.arquivo_id);
    assert.ok(ia.includes(a2) && !ia.includes(a1), "a mais antiga sem uso saiu");
    for (const u of usadas) assert.ok(ia.includes(u), "a que um post usa fica");
    assert.equal((await db().query("select count(*)::int as n from arquivos where id = $1", [a1])).rows[0].n, 0, "arquivo descartado some do disco");
    assert.ok((await chamar({ acao: "listarBanco" }, ana)).imagens.some(x => x.id === vid.id), "enviados pela pessoa ficam");
  } finally { mod.LIMITE_BANCO_IA.imagem = antes; }
});

test("migração leva ao banco as fotos e clipes de posts criados antes, sem duplicar", async () => {
  const { salvarArquivo } = await import("../src/arquivos.js");
  const foto = await salvarArquivo(anaOrg, { tipo: "image/jpeg", nome: "antiga", dados: Buffer.from(JPG, "base64") });
  const clipe = await salvarArquivo(anaOrg, { tipo: "video/mp4", nome: "antigo.mp4", dados: Buffer.from("00000018667479706d703432", "hex") });
  const conteudo = { prompts_imagem: [{ slide: 1, prompt: "uma foto antiga", proporcao: "4:5" }], cenas: [{ n: 2, prompt_video: "zoom antigo" }] };
  const post = (await db().query("insert into posts (org_id, titulo, formato, rede, data_publicacao, fotos, clipes, conteudo) values ($1, 'Post antigo', 'Carrossel', 'Instagram', now(), $2, $3, $4) returning id",
    [anaOrg, JSON.stringify({ 1: foto }), JSON.stringify({ 2: clipe }), JSON.stringify(conteudo)])).rows[0].id;
  const sql = fs.readFileSync(new URL("../migracoes/011_banco_ia_antigos.sql", import.meta.url), "utf8");
  await db().exec(sql); await db().exec(sql);
  const rows = (await db().query("select * from banco_imagens where post_id = $1 order by nome", [post])).rows;
  assert.equal(rows.length, 2, "uma vez cada, mesmo rodando duas vezes");
  assert.deepEqual(rows.map(r => [r.nome, r.descricao, r.origem]), [["Post antigo · 1", "uma foto antiga", "ia"], ["Post antigo · 2", "zoom antigo", "ia"]]);
  assert.equal((await db().query("select count(*)::int as n from banco_imagens b where (select count(*) from banco_imagens c where c.arquivo_id = b.arquivo_id) > 1")).rows[0].n, 0, "nada duplicado no banco");
});

test("IA escolhe no banco as fotos que combinam com o post", async () => {
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Pulseira nova', 'Carrossel', 'Instagram', 8) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 4 * 86400000).toISOString() }, ana);
  const azul = (await chamar({ acao: "enviarImagemBanco", tipo: "image/jpeg", nome: "a.jpg", titulo: "Pulseira azul", base64: JPG, descrever: false }, ana)).id;
  await chamar({ acao: "enviarImagemBanco", tipo: "image/jpeg", nome: "b.jpg", titulo: "Fachada da loja", base64: JPG, descrever: false }, ana);
  const original = globalThis.fetch;
  let corpo = null;
  globalThis.fetch = async (url, op = {}) => {
    if (String(url).includes("anthropic.com")) {
      corpo = JSON.parse(op.body);
      const cod = corpo.messages[0].content.split("\n").find(l => l.includes("Pulseira azul")).split(":")[0];
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ escolhidas: [cod, "b999"], motivo: "mostra o produto" }) }], stop_reason: "end_turn" }), { headers: { "content-type": "application/json" } });
    }
    return original(url, op);
  };
  let r;
  try { r = await chamar({ acao: "escolherBanco", id, briefing: { imagens: "banco", slides: "5" } }, ana); }
  finally { globalThis.fetch = original; }
  assert.equal(r.status, 200, r.erro);
  assert.deepEqual(r.ids, [azul], "só os códigos que existem no banco");
  assert.equal(r.motivo, "mostra o produto");
  assert.match(corpo.system, /até 5 itens/);
  assert.ok(corpo.messages[0].content.includes("Pulseira nova"));
  const p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === id);
  assert.equal(p.Status, "Planejado", "não cria o post nem gasta o limite");
});

test("pessoa real: exige autorização, vai como referência no Seedream e só nas imagens marcadas", async () => {
  const semOk = await chamar({ acao: "enviarPessoa", tipo: "image/jpeg", nome: "Gabriel", base64: JPG }, ana);
  assert.equal(semOk.status, 400);
  const { id: pessoa } = await chamar({ acao: "enviarPessoa", tipo: "image/jpeg", nome: "Gabriel", base64: JPG, autorizado: true }, ana);
  assert.equal((await chamar({ acao: "listarPessoas" }, ana)).pessoas[0].nome, "Gabriel");
  const outra = await chamar({ acao: "cadastrar", nome: "Fábio", email: "pessoa-teste@exemplo.org", senha: "segredo123", organizacao: "Outra" });
  assert.equal((await chamar({ acao: "listarPessoas" }, outra.token)).pessoas.length, 0, "cada organização vê só as suas");

  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Bastidores com o fundador', 'Carrossel', 'Instagram', 8) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 5 * 86400000).toISOString() }, ana);
  const original = globalThis.fetch, pedidos = [];
  let corpoClaude = null, corpoSeedream = null;
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url); pedidos.push(u);
    const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (u.includes("anthropic.com")) {
      corpoClaude = JSON.parse(op.body);
      return json({ content: [{ type: "text", text: JSON.stringify({ legenda: "L", hashtags: [], cenas: [],
        slides: [{ n: 1, titulo: "Capa", texto: "", usa_imagem: true }, { n: 2, titulo: "Produto", texto: "", usa_imagem: true }],
        prompts_imagem: [{ slide: 1, prompt: "the person from the reference photo behind the bar", proporcao: "4:5", pessoa: true }, { slide: 2, prompt: "a bracelet", proporcao: "4:5" }] }) }], stop_reason: "end_turn" });
    }
    if (u.endsWith("/seedream-v4-5-edit") && op.method === "POST") { corpoSeedream = JSON.parse(op.body); return json({ data: { task_id: "s1", status: "CREATED" } }); }
    if (u.includes("/seedream-v4-5-edit/s1")) return json({ data: { status: "COMPLETED", generated: ["https://cdn.exemplo/pessoa.jpg"] } });
    if (u.endsWith("/v1/ai/mystic") && op.method === "POST") return json({ data: { task_id: "m1", status: "CREATED" } });
    if (u.includes("/v1/ai/mystic/m1")) return json({ data: { status: "COMPLETED", generated: ["https://cdn.exemplo/produto.jpg"] } });
    if (u.startsWith("https://cdn.exemplo/")) return new Response(Buffer.from(JPG, "base64"), { headers: { "content-type": "image/jpeg" } });
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "criarPost", id, briefing: { pessoa } }, outra.token)).status, 404, "outra organização não usa o post nem a pessoa");
    assert.equal((await chamar({ acao: "criarPost", id, briefing: { capa: "foto", fundo: "fotos", slides: "2", pessoa } }, ana)).status, 200);
    await puxar();
    for (let k = 0; k < 100; k++) {
      const st = (await db().query("select status from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0].status;
      if (st === "feito" || st === "erro") break;
      await new Promise(r => setTimeout(r, 50));
    }
  } finally { globalThis.fetch = original; }
  const t = (await db().query("select status, erro from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0];
  assert.equal(t.status, "feito", t.erro || "");
  assert.match(JSON.stringify(corpoClaude.messages[0].content), /pessoa real: mostre a pessoa da foto de referência \(Gabriel\)/);
  const rosto = (await chamar({ acao: "listarPessoas" }, ana)).pessoas[0].arquivo.url;
  assert.deepEqual(corpoSeedream.reference_images, [rosto]);
  assert.equal(pedidos.filter(u => u.endsWith("/v1/ai/mystic")).length, 1, "o slide sem pessoa vai para o Mystic");
  const p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === id);
  assert.equal(p.Fotos.length, 2);

  assert.equal((await chamar({ acao: "removerPessoa", id: pessoa }, ana)).status, 200);
  assert.equal((await chamar({ acao: "listarPessoas" }, ana)).pessoas.length, 0);
});

test("tamanho do texto por slide fica na diagramação, só com valores válidos", async () => {
  const p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.Status === "EmRevisao");
  assert.ok(p, "post em revisão");
  const r = await chamar({ acao: "salvarDiagramacao", id: p.id, diagramacao: { modelo: "impacto", escalas: { 1: 1.3, 2: 1, 3: 5, 4: 0.6, x: 1.2 } } }, ana);
  assert.equal(r.status, 200);
  const d = JSON.parse((await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === p.id).Diagramacao);
  assert.deepEqual(d.escalas, { 1: 1.3, 4: 0.6 });
  assert.equal(d.fundo, "auto", "sem escolha, o fundo é o do modelo");
  assert.equal(d.v, 3);
  assert.equal(d.modelo, "impacto");
});

test("diagramação por imagem preserva o visual geral, limita os campos e isola organizações", async () => {
  const p = (await db().query("insert into posts (org_id,titulo,data_publicacao,rede,formato,status,artes_prontas) values ($1,'Carrossel com visuais diferentes',now() + interval '1 day','Instagram','Carrossel','EmRevisao',true) returning id", [anaOrg])).rows[0];
  const diagramacao = { modelo: "editorial", fundo: "claro", escalas: { 2: 1.35 }, slides: {
    2: { modelo: "cinema", alinhar: "centro", fundo: "escuro", fonte: "playfair", slides: { 1: { modelo: "impacto" } }, escalas: { 1: 5 }, audio: "mudo", extra: "ignorar" },
    3: { logo: "nenhum" }, 0: { modelo: "impacto" }, 21: { modelo: "grade" }, "2x": { modelo: "minimal" }, 4: null,
  } };
  assert.equal((await chamar({ acao: "salvarDiagramacao", id: p.id, diagramacao, refazer: true }, ana)).status, 200);
  const salvo = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === p.id), d = JSON.parse(salvo.Diagramacao);
  assert.equal(d.modelo, "editorial"); assert.equal(d.fundo, "claro"); assert.equal(salvo.ArtesProntas, false);
  assert.deepEqual(d.escalas, { 2: 1.35 });
  assert.deepEqual(d.slides, { 2: { modelo: "cinema", alinhar: "centro", fundo: "escuro", fonte: "playfair" }, 3: { logo: "nenhum" } });
  assert.equal((await chamar({ acao: "salvarDiagramacao", id: p.id, diagramacao: { modelo: "foto" } }, carla)).status, 404);
  assert.deepEqual((await db().query("select diagramacao from posts where id=$1", [p.id])).rows[0].diagramacao, d);
  await db().query("delete from posts where id=$1", [p.id]);
});

test("lê o JSON do Claude com texto em volta ou dividido em vários objetos", async () => {
  const { extrairJson } = await import("../src/provedores/index.js");
  assert.deepEqual(extrairJson('{"ideias":[{"titulo":"a"}]}'), { ideias: [{ titulo: "a" }] });
  assert.deepEqual(extrairJson('Aqui está:\n```json\n{"ideias":[{"titulo":"a {b}"}]}\n```\nEspero que ajude {:'), { ideias: [{ titulo: "a {b}" }] });
  assert.deepEqual(extrairJson('{"ideias":[{"titulo":"a"}]}\n{"ideias":[{"titulo":"b \\"c\\""}],"extra":1}'), { ideias: [{ titulo: "a" }, { titulo: 'b "c"' }], extra: 1 });
  assert.equal(extrairJson("sem json aqui"), null);
  assert.equal(extrairJson('{"cortado": ['), null);
});

test("relatório da planilha: protegido por chave, com uma linha por pessoa e o consumo de IA", async () => {
  const fora = await app.inject({ method: "GET", url: "/relatorio.csv?chave=x" });
  assert.equal(fora.statusCode, 404, "sem RELATORIO_CHAVE a rota não existe");
  process.env.RELATORIO_CHAVE = "c".repeat(40);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/relatorio.csv?chave=errada" })).statusCode, 401);
    await db().query("insert into consumo (org_id, provedor, tipo, entrada, saida, quantidade) values ($1, 'anthropic', 'post', 1000000, 100000, 1), ($1, 'magnific', 'clipe', 0, 0, 10)", [anaOrg]);
    await db().query("insert into usuarios (email, nome, senha_hash, salt) values ('=cmd@exemplo.com', '=HYPERLINK(\"x\")', 'h', 's')");
    const r = await app.inject({ method: "GET", url: "/relatorio.csv?chave=" + "c".repeat(40) });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers["content-type"], /text\/csv/);
    const linhas = r.body.trim().split("\n");
    assert.match(linhas[0], /^Nome,E-mail,Cadastro/);
    const anaLinha = linhas.find(l => l.includes("ana@exemplo.com"));
    assert.ok(anaLinha, "a Ana aparece");
    assert.match(anaLinha, /Easypeasy/);
    assert.match(anaLinha, /,1000000,100000,/, "tokens de entrada e saída");
    assert.match(anaLinha, /,7\.28,/, "custo: 4 + 2 de tokens, 1 de vídeo e 0,28 das 4 fotos dos outros testes");
    assert.ok(linhas.some(l => l.startsWith(`"'=HYPERLINK(""x"")"`)), "texto que parece fórmula vira texto");
    assert.ok(linhas.some(l => l.includes("sem organização")));
  } finally { delete process.env.RELATORIO_CHAVE; }
});

test("relatório no formato da planilha em português: decimais com vírgula", async () => {
  process.env.RELATORIO_CHAVE = "c".repeat(40);
  try {
    const r = await app.inject({ method: "GET", url: "/relatorio.csv?formato=br&chave=" + "c".repeat(40) });
    const ana = r.body.split("\n").find(l => l.includes("ana@exemplo.com"));
    assert.match(ana, /,"7,28",/);
  } finally { delete process.env.RELATORIO_CHAVE; }
});

test("painel admin: só o e-mail admin acessa; soma usuários, receita e custos da plataforma", async () => {
  const negado = await chamar({ acao: "painelAdmin" }, ana);
  assert.equal(negado.status, 403, "Ana não é admin");
  process.env.ADMIN_EMAILS = "ana@exemplo.com";
  try {
    const eu = await chamar({ acao: "eu" }, ana);
    assert.equal(eu.usuario.admin, true);
    await db().query("insert into consumo (org_id, provedor, tipo, quantidade, chave_propria) values ($1, 'apify', 'coleta', 1000, false), ($1, 'zernio', 'publicacao', 3, false), ($1, 'magnific', 'foto', 10, true)", [anaOrg]);
    const r = await chamar({ acao: "painelAdmin" }, ana);
    assert.equal(r.status, 200, r.erro);
    assert.ok(r.usuarios.total >= 3);
    assert.equal(r.serie.length, 30);
    assert.equal(r.custos.periodos.d30.apify.plataforma.usd, 2.3);
    assert.ok(r.custos.periodos.d30.zernio.plataforma.quantidade >= 3, "publicações contam (inclui as dos outros testes)");
    assert.ok(r.custos.periodos.d30.magnific.propria.quantidade >= 10, "chave própria fica separada");
    assert.ok(r.topOrgs.some(o => o.nome === "Easypeasy"));
  } finally { delete process.env.ADMIN_EMAILS; }
});

test("imagens: original comprimida, prévia leve em WebP e PNG com transparência intacto", async () => {
  const sharp = (await import("sharp")).default;
  const grande = await sharp(crypto.randomBytes(1500 * 1500 * 3), { raw: { width: 1500, height: 1500, channels: 3 } }).png().toBuffer();
  const { id } = await chamar({ acao: "enviarImagemBanco", tipo: "image/png", nome: "grande.png", titulo: "Grande", base64: grande.toString("base64"), descrever: false }, ana);
  const b = (await chamar({ acao: "listarBanco" }, ana)).imagens.find(x => x.id === id);
  assert.equal(b.arquivo.type, "image/jpeg", "PNG sem transparência vira JPEG");
  assert.ok(b.arquivo.size < grande.length / 2, "a original ficou bem menor");
  assert.match(b.arquivo.thumbnails.large.url, /\?v=p$/);
  const caminhoDe = u => new URL(u).pathname;
  const p = await app.inject({ method: "GET", url: caminhoDe(b.arquivo.thumbnails.large.url) + "?v=p" });
  assert.equal(p.headers["content-type"], "image/webp");
  const m = await sharp(p.rawPayload).metadata();
  assert.ok(Math.max(m.width, m.height) <= 720, "prévia com até 720 px");
  const o = await sharp((await app.inject({ method: "GET", url: caminhoDe(b.arquivo.url) })).rawPayload).metadata();
  assert.ok(Math.max(o.width, o.height) <= 2048, "original com até 2048 px");

  const logo = await sharp({ create: { width: 900, height: 300, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const r = await chamar({ acao: "enviarArquivoMarca", campo: "Logo", tipo: "image/png", nome: "logo.png", base64: logo.toString("base64") }, ana);
  assert.equal(r.status, 200, r.erro);
  const marca = (await chamar({ acao: "listar" }, ana)).marca;
  assert.equal(marca.Logo[0].type, "image/png", "logo transparente continua PNG");
});

test("modelo do perfil: a IA lê os posts enviados (ou do Instagram) e devolve um modelo que vira padrão", async () => {
  assert.equal((await chamar({ acao: "criarModelo", imagens: [] }, ana)).status, 400, "precisa de exemplos");
  const original = globalThis.fetch;
  let corpoClaude = null, pediuApify = null;
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    if (u.includes("anthropic.com")) { corpoClaude = JSON.parse(op.body); return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ nome: "Bar escuro", base: "impacto", fonte: "bebas", caixa_alta: true, fundo: "#101820", tinta: "#fafafa", apoio: "#cccccc", destaque: "#ff5a1f", alinhar: "centro", posicao: "base", logo: "bc", moldura: { tipo: "borda", cor: "#ff5a1f", espessura: 9 }, fonte_extra: "x" }) }], stop_reason: "end_turn" }), { headers: { "content-type": "application/json" } }); }
    if (u.includes("api.apify.com")) { pediuApify = JSON.parse(op.body); return new Response(JSON.stringify([{ type: "Image", displayUrl: "https://cdn.exemplo/ig1.jpg" }, { type: "Sidecar", childPosts: [{ displayUrl: "https://cdn.exemplo/ig2.jpg" }] }]), { headers: { "content-type": "application/json" } }); }
    if (u.startsWith("https://cdn.exemplo/")) return new Response(Buffer.from(JPG, "base64"), { headers: { "content-type": "image/jpeg" } });
    return original(url, op);
  };
  const esperar = async () => { await puxar(); for (let k = 0; k < 100; k++) { const st = (await db().query("select status from tarefas where tipo = 'criarModelo' order by criado_em desc limit 1")).rows[0].status; if (st === "feito" || st === "erro") return st; await new Promise(r => setTimeout(r, 50)); } };
  let id;
  try {
    ({ id } = await chamar({ acao: "criarModelo", nome: "", imagens: [{ tipo: "image/jpeg", base64: JPG }, { tipo: "image/jpeg", base64: JPG }] }, ana));
    const st1 = await esperar(); assert.equal(st1, "feito", (await db().query("select erro from tarefas where tipo = 'criarModelo' order by criado_em desc limit 1")).rows[0].erro);
    await db().query("update marcas set perfil = 'https://instagram.com/barteste/' where org_id = $1", [anaOrg]);
    await chamar({ acao: "salvarIntegracao", provedor: "apify", valor: "apify_api_teste_1234567890" }, ana);
    const ig = await chamar({ acao: "criarModelo", instagram: true }, ana);
    assert.equal(await esperar(), "feito");
    assert.deepEqual(pediuApify.username, ["barteste"], "usa o @ da marca");
    const m2 = (await chamar({ acao: "listarModelos" }, ana)).modelos.find(x => x.id === ig.id);
    assert.equal(m2.exemplos.length, 2, "baixou os posts do Instagram (o primeiro de cada carrossel)");
  } finally { globalThis.fetch = original; }
  assert.equal(corpoClaude.messages[0].content.filter(c => c.type === "image").length, 2, "os exemplos vão como imagem");
  const lista = await chamar({ acao: "listar" }, ana);
  const m = lista.modelos.find(x => x.id === id);
  assert.equal(m.status, "pronto");
  assert.equal(m.nome, "Bar escuro");
  assert.deepEqual([m.spec.base, m.spec.fonte, m.spec.fundo, m.spec.moldura.espessura], ["impacto", "bebas", "#101820", 4], "valores limpos e limitados");
  assert.equal((await chamar({ acao: "modeloPadrao", id }, ana)).status, 200);
  assert.equal((await chamar({ acao: "listarModelos" }, ana)).modeloPadrao, id);
  const p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.Status === "EmRevisao");
  await chamar({ acao: "salvarDiagramacao", id: p.id, diagramacao: { modelo: "proprio", proprio: id } }, ana);
  const d = JSON.parse((await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === p.id).Diagramacao);
  assert.deepEqual([d.modelo, d.proprio], ["proprio", id]);
  assert.equal((await chamar({ acao: "removerModelo", id }, ana)).status, 200);
  assert.equal((await chamar({ acao: "listarModelos" }, ana)).modeloPadrao, null, "remover tira o padrão");
});

test("onboarding: organização nova começa pendente; concluir marca como feito e mantém o checklist", async () => {
  const r = await chamar({ acao: "cadastrar", nome: "Gil", email: "gil-onb@exemplo.org", senha: "segredo123", organizacao: "Café do Gil" });
  assert.equal(r.organizacao.onboarding, true);
  assert.equal((await chamar({ acao: "concluirOnboarding" }, r.token)).status, 200);
  const eu = await chamar({ acao: "eu" }, r.token);
  assert.equal(eu.organizacao.onboarding, false);
  assert.equal(eu.organizacao.primeirosPassos, true, "checklist continua por 14 dias");
  const antiga = (await chamar({ acao: "eu" }, ana)).organizacao;
  assert.equal(antiga.onboarding, true, "a Ana foi criada nos testes, depois da migração");
});

test("story em sequência: a IA faz várias telas 9:16 e cada imagem sai como um story, na ordem", async () => {
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Sequência de sexta', 'Stories', 'Instagram', 8) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 6 * 86400000).toISOString() }, ana);
  const original = globalThis.fetch;
  let corpoClaude = null; const mystic = [], stories = [];
  process.env.ZERNIO_INTERVALO_MS = "5";
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
    if (u.includes("anthropic.com")) { corpoClaude = JSON.parse(op.body); return json({ content: [{ type: "text", text: JSON.stringify({ legenda: "", hashtags: [], cenas: [],
      slides: [1, 2, 3].map(n => ({ n, titulo: "Story " + n, texto: "", usa_imagem: true })), prompts_imagem: [1, 2, 3].map(n => ({ slide: n, prompt: "bar " + n, proporcao: "9:16" })) }) }], stop_reason: "end_turn" }); }
    if (u.endsWith("/v1/ai/mystic") && op.method === "POST") { mystic.push(JSON.parse(op.body)); return json({ data: { task_id: "sq" + mystic.length, status: "CREATED" } }); }
    if (/\/v1\/ai\/mystic\/sq\d/.test(u)) return json({ data: { status: "COMPLETED", generated: ["https://cdn.exemplo/sq.jpg"] } });
    if (u === "https://cdn.exemplo/sq.jpg") return new Response(Buffer.from(JPG, "base64"), { headers: { "content-type": "image/jpeg" } });
    if (u.endsWith("zernio.com/api/v1/accounts")) return json({ accounts: [{ _id: "acc1", platform: "instagram", username: "easypeasy", isActive: true }] });
    if (u.endsWith("zernio.com/api/v1/posts")) { const c = JSON.parse(op.body); stories.push(c); return json({ post: { _id: "st" + stories.length, status: "publishing", platforms: [{ platform: "instagram", status: "publishing" }] } }, 201); }
    const m = /zernio\.com\/api\/v1\/posts\/(st\d+)/.exec(u);
    if (m) return json({ post: { _id: m[1], status: "published", platforms: [{ platform: "instagram", status: "published", platformPostUrl: "https://instagram.com/stories/" + m[1] }] } });
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "criarPost", id, briefing: { story: "sequencia", slides: "3", fundo: "fotos" } }, ana)).status, 200);
    await puxar();
    for (let k = 0; k < 100; k++) { const st = (await db().query("select status from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0].status; if (st === "feito" || st === "erro") break; await new Promise(r => setTimeout(r, 50)); }
    const t = (await db().query("select status, erro from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0];
    assert.equal(t.status, "feito", t.erro || "");
    assert.match(JSON.stringify(corpoClaude.messages[0].content), /SEQUÊNCIA DE STORIES.{0,80}exatamente 3 slides/);
    assert.equal(mystic.length, 3, "uma foto por story");
    assert.ok(mystic.every(b => b.aspect_ratio === "social_story_9_16"));
    const p = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === id);
    assert.equal(JSON.parse(p.Slides).length, 3);
    await chamar({ acao: "salvarArtes", id, artes: [1, 2, 3].map(() => ({ tipo: "image/jpeg", base64: JPG })) }, ana);
    await db().query("update posts set status = 'Agendado' where id = $1", [id]);
    assert.equal((await chamar({ acao: "publicarAgora", id }, ana)).status, 200);
    for (let k = 0; k < 100; k++) { if ((await db().query("select status from posts where id = $1", [id])).rows[0].status !== "Publicando") break; await new Promise(r => setTimeout(r, 30)); }
  } finally { globalThis.fetch = original; }
  const fim = (await db().query("select status, links, erro from posts where id = $1", [id])).rows[0];
  assert.equal(fim.status, "Publicado", fim.erro || "");
  assert.equal(stories.length, 3, "três stories, um por imagem");
  assert.ok(stories.every(s => s.mediaItems.length === 1 && s.platforms[0].platformSpecificData.contentType === "story"));
  assert.deepEqual(Object.keys(fim.links), ["Instagram"], "sem as anotações parciais no fim");
});

test("trocar a foto de um story por vídeo do banco tira a foto antiga (e vice-versa)", async () => {
  const MP4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex").toString("base64");
  const vid = await chamar({ acao: "enviarImagemBanco", tipo: "video/mp4", nome: "balcao.mp4", base64: MP4, titulo: "Balcão" }, ana);
  const arqV = (await chamar({ acao: "listarBanco" }, ana)).imagens.find(x => x.id === vid.id).arquivo.id;
  const { salvarArquivo } = await import("../src/arquivos.js");
  const salvar = nome => salvarArquivo(anaOrg, { tipo: "image/jpeg", nome, dados: Buffer.from(JPG, "base64") });
  const antiga = await salvar("ia.png"), arqF = await salvar("copo.png");
  const img = (await db().query("insert into banco_imagens (org_id, arquivo_id, nome, origem) values ($1, $2, 'Copo', 'envio') returning id", [anaOrg, arqF])).rows[0];
  const { rows: [p] } = await db().query(`insert into posts (org_id, titulo, data_publicacao, rede, formato, status, slides, fotos, briefing)
    values ($1, 'Story seq', now() + interval '5 days', 'Instagram', 'Stories', 'EmRevisao', $2, $3, '{"story":"sequencia"}') returning id`,
    [anaOrg, JSON.stringify([{ n: 1, titulo: "A" }, { n: 2, titulo: "B" }]), JSON.stringify({ 1: antiga, 2: antiga })]);
  assert.equal((await chamar({ acao: "trocarFotoSlide", id: p.id, slide: 1, imagem: vid.id }, ana)).status, 200);
  let post = (await db().query("select fotos, clipes from posts where id = $1", [p.id])).rows[0];
  assert.equal(post.clipes["1"], arqV);
  assert.equal(post.fotos["1"], undefined, "a foto antiga sai da tela 1");
  assert.equal(post.fotos["2"], antiga, "a tela 2 continua igual");
  const res = (await chamar({ acao: "pauta" }, ana)).posts.find(x => x.id === p.id);
  assert.deepEqual(Object.keys(JSON.parse(res.ImagensSlides)), ["2"]);
  assert.deepEqual(Object.keys(JSON.parse(res.ClipesSlides)), ["1"]);
  assert.equal(res.Fotos.length, 1, "a foto que a tela 2 ainda usa não é apagada");
  assert.equal((await chamar({ acao: "trocarFotoSlide", id: p.id, slide: 1, imagem: img.id }, ana)).status, 200);
  post = (await db().query("select fotos, clipes from posts where id = $1", [p.id])).rows[0];
  assert.equal(post.fotos["1"], arqF);
  assert.deepEqual(post.clipes, {});
  assert.equal((await db().query("select count(*)::int as n from arquivos where id = $1", [arqV])).rows[0].n, 1, "o vídeo continua no banco");
});

test("Reels com fotos do banco resolve falha de geração e permite aprovar o vídeo sem chamar o Magnific", async () => {
  const imagem = await chamar({ acao: "enviarImagemBanco", tipo: "image/jpeg", nome: "foto-reels.jpg", base64: JPG, descrever: false }, ana);
  const cenas = [1, 2].map(n => ({ n, titulo: "Cena " + n, texto: "Texto preservado", usa_video: true }));
  const aviso = "A conta do Magnific está sem créditos: 2 imagem(ns) ou clipe(s) não foram gerados. Use fotos do Banco de imagens.";
  const post = (await db().query(`insert into posts (org_id,titulo,formato,rede,status,data_publicacao,slides,conteudo,erro)
    values ($1,'Reels com fotos escolhidas','Reels','Instagram','EmRevisao',now()+interval '5 days',$2,$3,$4) returning id`,
    [anaOrg, JSON.stringify(cenas), JSON.stringify({ cenas }), aviso])).rows[0];
  const original = globalThis.fetch, chamadas = [];
  globalThis.fetch = async url => { chamadas.push(String(url)); throw new Error("Nenhuma chamada externa esperada"); };
  try {
    assert.equal((await chamar({ acao: "trocarFotoSlide", id: post.id, slide: 1, imagem: imagem.id }, ana)).status, 200);
    let p = (await db().query("select * from posts where id=$1", [post.id])).rows[0];
    assert.equal(p.erro, aviso, "mantém o aviso enquanto a segunda cena não tem mídia");
    assert.equal(p.slides[0].usa_video, false); assert.equal(p.slides[0].usa_imagem, true);
    assert.equal(p.conteudo.cenas[0].usa_video, false); assert.equal(p.slides[1].texto, "Texto preservado");
    assert.equal((await chamar({ acao: "trocarFotoSlide", id: post.id, slide: 2, imagem: imagem.id }, ana)).status, 200);
    p = (await db().query("select * from posts where id=$1", [post.id])).rows[0];
    assert.equal(p.erro, null, "limpa somente a falha de geração resolvida");
    assert.equal(Object.keys(p.fotos).length, 2); assert.deepEqual(p.clipes, {}); assert.equal(p.artes_prontas, false);
    assert.equal((await chamar({ acao: "aprovarPost", id: post.id }, ana)).status, 400, "ainda exige montar o arquivo final");
    await db().query("update posts set erro='Confira a conexão do Instagram.' where id=$1", [post.id]);
    await chamar({ acao: "trocarFotoSlide", id: post.id, slide: 1, imagem: imagem.id }, ana);
    assert.equal((await db().query("select erro from posts where id=$1", [post.id])).rows[0].erro, "Confira a conexão do Instagram.", "preserva avisos de outros problemas");
    const MP4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex").toString("base64");
    assert.equal((await chamar({ acao: "salvarArtes", id: post.id, artes: [{ tipo: "video/mp4", base64: MP4 }] }, ana)).status, 200);
    assert.equal((await chamar({ acao: "aprovarPost", id: post.id }, ana)).status, 200);
    assert.equal((await db().query("select status from posts where id=$1", [post.id])).rows[0].status, "Agendado");
    assert.deepEqual(chamadas, [], "trocar, montar e aprovar não pede geração ou download ao provedor");
  } finally { globalThis.fetch = original; }
});

test("revisão: login em paralelo bloqueia, limite do plano aguenta concorrência, hashtags e criarPost duplo", async () => {
  // senha errada em paralelo: o bloqueio de 5 tentativas vale
  const em = "paralelo" + Date.now() + "@x.com";
  await chamar({ acao: "cadastrar", nome: "P", email: em, senha: "segredo123", organizacao: "Par" });
  await Promise.all(Array.from({ length: 12 }, () => app.inject({ method: "POST", url: "/api", payload: { acao: "entrar", email: em, senha: "errada999" } })));
  assert.equal((await chamar({ acao: "entrar", email: em, senha: "segredo123" })).status, 429, "conta bloqueada depois de 5 erros");

  // arquivo com id inválido: 404, não 500; ação herdada do Object não existe
  assert.equal((await app.inject({ method: "GET", url: "/f/------------------------------------/abc" })).statusCode, 404);
  assert.equal((await chamar({ acao: "constructor" }, ana)).status, 400);

  // limite do teste (3 posts) com pedidos em paralelo
  process.env.COBRANCA = "sim";
  try {
    const { usar } = await import("../src/planos.js");
    const o = (await db().query("insert into organizacoes (nome) values ('Concorrência') returning id")).rows[0].id;
    const r = await Promise.allSettled(Array.from({ length: 8 }, () => usar(o, "post")));
    assert.equal(r.filter(x => x.status === "fulfilled").length, 3);
    assert.equal((await db().query("select count(*)::int as n from uso where org_id = $1", [o])).rows[0].n, 3);
  } finally { delete process.env.COBRANCA; }

  // hashtags salvas não se partem na letra "s"
  const { rows: [p] } = await db().query("insert into posts (org_id, titulo, data_publicacao, rede, formato, status, slides) values ($1, 'Tags', now() + interval '9 days', 'Instagram', 'Carrossel', 'EmRevisao', '[{\"n\":1}]') returning id", [anaOrg]);
  assert.equal((await chamar({ acao: "salvarTextos", id: p.id, slides: [{ n: 1, titulo: "T", texto: "x" }], legenda: "L", hashtags: "#sucesso #dicas" }, ana)).status, 200);
  assert.deepEqual((await db().query("select conteudo from posts where id = $1", [p.id])).rows[0].conteudo.hashtags, ["#sucesso", "#dicas"]);

  // clique duplo em "Criar post": um só cobra e enfileira
  const { rows: [q] } = await db().query("insert into posts (org_id, titulo, data_publicacao, rede, formato, status) values ($1, 'Duplo', now() + interval '9 days', 'Instagram', 'Carrossel', 'Planejado') returning id", [anaOrg]);
  const antes = (await db().query("select count(*)::int as n from uso where org_id = $1", [anaOrg])).rows[0].n;
  const rs = await Promise.all([chamar({ acao: "criarPost", id: q.id }, ana), chamar({ acao: "criarPost", id: q.id }, ana)]);
  assert.deepEqual(rs.map(x => x.status).sort(), [200, 400]);
  assert.equal((await db().query("select count(*)::int as n from uso where org_id = $1", [anaOrg])).rows[0].n, antes + 1);
  assert.equal((await db().query("select count(*)::int as n from tarefas where tipo = 'criar' and payload->>'post' = $1", [q.id])).rows[0].n, 1);
  await db().query("delete from tarefas where tipo = 'criar' and payload->>'post' = $1", [q.id]);
});

test("modelo montado à mão: salva a diagramação, vira padrão, edita e respeita o limite do plano", async () => {
  const em = "modelos" + Date.now() + "@x.com";
  const tk = (await chamar({ acao: "cadastrar", nome: "M", email: em, senha: "segredo123", organizacao: "Modelos" })).token;
  process.env.COBRANCA = "sim";
  try {
    const d = { modelo: "cinema", fundo: "escuro", fonte: "playfair", alinhar: "centro", posicao: "base", logo: "nenhum", logoPos: "bd", escala: 1.25, lixo: "x" };
    const r = await chamar({ acao: "salvarModeloMarca", nome: "Promoções", diagramacao: d, padrao: true }, tk);
    assert.equal(r.status, 200, r.erro);
    let l = await chamar({ acao: "listarModelos" }, tk);
    const m = l.modelos.find(x => x.id === r.id);
    assert.equal(m.status, "pronto");
    assert.deepEqual({ ...m.diag, v: undefined }, { modelo: "cinema", fundo: "escuro", fonte: "playfair", alinhar: "centro", posicao: "base", logo: "nenhum", logoPos: "bd", escala: 1.25, v: undefined });
    assert.equal(l.modeloPadrao, r.id);
    assert.deepEqual(l.limiteModelos, { usados: 1, maximo: 1, plano: "Teste grátis" });
    // o teste grátis guarda 1 modelo: o segundo é recusado (e criar pelo Instagram também)
    const r2 = await chamar({ acao: "salvarModeloMarca", nome: "Outro", diagramacao: d }, tk);
    assert.equal(r2.status, 402);
    assert.match(r2.erro, /até 1 modelo/);
    assert.equal((await chamar({ acao: "criarModelo", instagram: true }, tk)).status, 402);
    // editar o que já existe não conta como novo
    assert.equal((await chamar({ acao: "salvarModeloMarca", id: r.id, nome: "Promo 2", diagramacao: { ...d, fonte: "anton" } }, tk)).status, 200);
    l = await chamar({ acao: "listarModelos" }, tk);
    assert.equal(l.modelos[0].nome, "Promo 2"); assert.equal(l.modelos[0].diag.fonte, "anton");
  } finally { delete process.env.COBRANCA; }
});

test("publicação: Reels de teste no Instagram e selo de conteúdo feito com IA", async () => {
  const { conteudoPara } = await import("../src/tarefas/trabalhos.js");
  const v = [{ type: "video", url: "https://x/v.mp4" }], f = [{ type: "image", url: "https://x/a.jpg" }];
  const reel = { formato: "Reels", legenda: "L", hashtags: "", titulo: "T", publicacao: { reelTeste: "SS_PERFORMANCE" } };
  assert.deepEqual(conteudoPara("Instagram", reel, v).opcoes, { trialParams: { graduationStrategy: "SS_PERFORMANCE" }, isAiGenerated: true });
  // carrossel não vira Reels de teste; selo de IA pode ser desligado
  assert.deepEqual(conteudoPara("Instagram", { ...reel, formato: "Carrossel" }, f).opcoes, { isAiGenerated: true });
  assert.equal(conteudoPara("Instagram", { ...reel, publicacao: { conteudoIa: false } }, v).opcoes, null);
  assert.equal(conteudoPara("TikTok", { ...reel, publicacao: { conteudoIa: false } }, v).opcoes.tiktokSettings.video_made_with_ai, false);
  assert.equal(conteudoPara("YouTube", reel, v).opcoes.containsSyntheticMedia, true);
  // salvar no post e voltar na pauta
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Reel teste', 'Reels', 'Instagram', 7) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 8 * 86400000).toISOString() }, ana);
  assert.equal((await chamar({ acao: "salvarPublicacao", id, reelTeste: "MANUAL", conteudoIa: false }, ana)).status, 200);
  let post = (await chamar({ acao: "pauta" }, ana)).posts.find(p => p.id === id);
  assert.deepEqual(post.Publicacao, { reelTeste: "MANUAL", conteudoIa: false });
  await chamar({ acao: "salvarPublicacao", id, reelTeste: "nao" }, ana);
  post = (await chamar({ acao: "pauta" }, ana)).posts.find(p => p.id === id);
  assert.deepEqual(post.Publicacao, { conteudoIa: false });
});

test("vídeos: índice vai para o começo, capa vira prévia e o arquivo sai aos pedaços (Range)", async () => {
  const { salvarArquivo, mp4Faststart } = await import("../src/arquivos.js");
  // MP4 mínimo com moov no fim: ftyp + mdat (8 bytes de amostra) + moov com um stco apontando para a amostra
  const caixa = (t, corpo) => { const b = Buffer.alloc(8 + corpo.length); b.writeUInt32BE(b.length); b.write(t, 4, "latin1"); corpo.copy(b, 8); return b; };
  const ftyp = caixa("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1")), mdat = caixa("mdat", Buffer.from("AMOSTRA!"));
  const stcoCorpo = Buffer.alloc(12); stcoCorpo.writeUInt32BE(1, 4); stcoCorpo.writeUInt32BE(ftyp.length + 8, 8);
  const moov = caixa("moov", caixa("trak", caixa("mdia", caixa("minf", caixa("stbl", caixa("stco", stcoCorpo))))));
  const original = Buffer.concat([ftyp, mdat, moov]);
  const rapido = mp4Faststart(original);
  assert.equal(rapido.toString("latin1", ftyp.length + 4, ftyp.length + 8), "moov");
  const pos = rapido.indexOf("stco", 0, "latin1") + 12;
  const amostra = rapido.readUInt32BE(pos);
  assert.equal(rapido.toString("latin1", amostra, amostra + 8), "AMOSTRA!", "o stco aponta para a amostra no lugar novo");
  assert.equal(mp4Faststart(rapido), rapido, "já rápido: não mexe");

  const capa = Buffer.from(JPG, "base64");
  const id = await salvarArquivo(anaOrg, { tipo: "video/mp4", nome: "v.mp4", dados: original, capa });
  const a = (await db().query("select chave, previa, tamanho from arquivos where id = $1", [id])).rows[0];
  assert.equal(a.previa, true, "a capa virou prévia");
  const url = `/f/${id}/${a.chave}`;
  const p = await app.inject({ method: "GET", url, headers: { range: "bytes=0-15" } });
  assert.equal(p.statusCode, 206);
  assert.equal(p.headers["content-range"], `bytes 0-15/${original.length}`);
  assert.equal(p.rawPayload.length, 16);
  assert.equal(p.rawPayload.toString("latin1", 4, 8), "ftyp");
  const inteiro = await app.inject({ method: "GET", url });
  assert.equal(inteiro.statusCode, 200); assert.equal(inteiro.headers["accept-ranges"], "bytes"); assert.equal(inteiro.rawPayload.length, original.length);
  assert.equal((await app.inject({ method: "GET", url, headers: { range: "bytes=999999-" } })).statusCode, 416);
  const pv = await app.inject({ method: "GET", url: url + "?v=p" });
  assert.equal(pv.headers["content-type"], "image/webp");
});

test("publicação: reinício no meio não cria o post de novo no Zernio, e vários posts vencidos saem juntos", async () => {
  const { publicarVencidos, destravarPublicando } = await import("../src/tarefas/trabalhos.js");
  await chamar({ acao: "salvarIntegracao", provedor: "zernio", valor: "sk_zernio_teste_1234" }, ana);
  const novo = async (t, links) => {
    const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, $2, 'Estatico', 'Instagram', 7) returning id", [anaOrg, t])).rows[0].id;
    const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 5 * 86400000).toISOString() }, ana);
    await chamar({ acao: "salvarArtes", id, artes: [{ tipo: "image/jpeg", base64: JPG }] }, ana);
    await db().query("update posts set status = $2, links = $3, data_publicacao = now() - interval '1 minute', redes = '{Instagram}' where id = $1", [id, links ? "Publicando" : "Agendado", JSON.stringify(links || {})]);
    return id;
  };
  // um post ficou "Publicando" quando o servidor caiu, já com o id do Zernio guardado; outros três estão vencidos
  const preso = await novo("Preso no reinício", { Instagram: "zernio:zpreso" });
  const outros = [await novo("Vencido 1"), await novo("Vencido 2"), await novo("Vencido 3")];
  const original = globalThis.fetch, criados = [];
  let simultaneos = 0, maxSimultaneos = 0, n = 0;
  process.env.ZERNIO_INTERVALO_MS = "20";
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    if (u.endsWith("zernio.com/api/v1/accounts")) return new Response(JSON.stringify({ accounts: [{ _id: "acc1", platform: "instagram", username: "x", isActive: true }] }));
    if (u.endsWith("zernio.com/api/v1/posts") && op.method === "POST") {
      const id = "z" + (++n); criados.push(id); simultaneos++; maxSimultaneos = Math.max(maxSimultaneos, simultaneos);
      return new Response(JSON.stringify({ post: { _id: id, status: "publishing", platforms: [{ status: "publishing" }] } }));
    }
    const m = u.match(/zernio\.com\/api\/v1\/posts\/(\w+)$/);
    if (m) { await new Promise(r => setTimeout(r, 30)); if (m[1] !== "zpreso") simultaneos--; return new Response(JSON.stringify({ post: { _id: m[1], status: "published", platforms: [{ status: "published", platformPostUrl: "https://instagram.com/p/" + m[1] }] } })); }
    return original(url, op);
  };
  try {
    await destravarPublicando(0);
    assert.equal((await db().query("select status from posts where id = $1", [preso])).rows[0].status, "Agendado", "volta para a fila ao ligar");
    await publicarVencidos();
  } finally { globalThis.fetch = original; }
  const p = (await db().query("select status, link_publicado from posts where id = $1", [preso])).rows[0];
  assert.equal(p.status, "Publicado");
  assert.equal(p.link_publicado, "https://instagram.com/p/zpreso", "conferiu o post que já existia");
  assert.equal(criados.length, 3, "só os 3 novos foram criados no Zernio");
  assert.ok(maxSimultaneos >= 2, "os vencidos saem ao mesmo tempo, não um por um");
  for (const id of outros) assert.equal((await db().query("select status from posts where id = $1", [id])).rows[0].status, "Publicado");
});

test("tentar de novo: post com erro de publicação volta a publicar só o que faltou", async () => {
  await chamar({ acao: "salvarIntegracao", provedor: "zernio", valor: "sk_zernio_teste_1234" }, ana);
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'Deu erro', 'Estatico', 'Instagram', 7) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 5 * 86400000).toISOString() }, ana);
  await chamar({ acao: "salvarArtes", id, artes: [{ tipo: "image/jpeg", base64: JPG }] }, ana);
  assert.equal((await chamar({ acao: "tentarPublicarDeNovo", id }, ana)).status, 400, "sem falha, não tem o que tentar");
  // saiu no Instagram, falhou no Facebook
  await db().query("update posts set status = 'Publicado', erro = 'Não publicou em Facebook: x', redes = '{Instagram,Facebook}', links = $2 where id = $1", [id, JSON.stringify({ Instagram: "https://instagram.com/p/ja" })]);
  const original = globalThis.fetch, criados = [];
  process.env.ZERNIO_INTERVALO_MS = "5";
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    if (u.endsWith("zernio.com/api/v1/accounts")) return new Response(JSON.stringify({ accounts: [{ _id: "ig", platform: "instagram", isActive: true }, { _id: "fb", platform: "facebook", isActive: true }] }));
    if (u.endsWith("zernio.com/api/v1/posts") && op.method === "POST") { criados.push(JSON.parse(op.body).platforms[0].platform); return new Response(JSON.stringify({ post: { _id: "zf", status: "published", platforms: [{ status: "published", platformPostUrl: "https://facebook.com/p/novo" }] } })); }
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "tentarPublicarDeNovo", id }, ana)).status, 200);
    for (let k = 0; k < 100; k++) { if ((await db().query("select status from posts where id = $1", [id])).rows[0].status !== "Publicando") break; await new Promise(r => setTimeout(r, 20)); }
  } finally { globalThis.fetch = original; }
  const p = (await db().query("select status, erro, links from posts where id = $1", [id])).rows[0];
  assert.equal(p.status, "Publicado"); assert.equal(p.erro, null);
  assert.deepEqual(criados, ["facebook"], "o Instagram, que já tinha saído, não foi repetido");
  assert.equal(p.links.Facebook, "https://facebook.com/p/novo");
});

test("pauta responde só 'igual' quando nada mudou desde a versão do painel", async () => {
  const a = await chamar({ acao: "pauta" }, ana);
  assert.equal(a.status, 200); assert.ok(a.versao); assert.ok(Array.isArray(a.posts));
  const b = await chamar({ acao: "pauta", versao: a.versao }, ana);
  assert.equal(b.igual, true); assert.equal(b.posts, undefined);
  const i = (await db().query("select id from ideias where org_id = $1 limit 1", [anaOrg])).rows[0];
  if (i) await db().query("update ideias set status = case when status='Guardada' then 'Sugerida' else 'Guardada' end where id = $1", [i.id]);
  else await db().query("insert into ideias (org_id, titulo) values ($1, 'nova')", [anaOrg]);
  const c = await chamar({ acao: "pauta", versao: a.versao }, ana);
  assert.equal(c.igual, undefined); assert.notEqual(c.versao, a.versao); assert.ok(Array.isArray(c.ideias));
});

test("produto ou objeto: sem pedir autorização, vai como referência e junto com a pessoa quando os dois são marcados", async () => {
  const { id: produto } = await chamar({ acao: "enviarPessoa", referencia: "produto", tipo: "image/jpeg", nome: "Pulseira azul", base64: JPG }, ana);
  assert.ok(produto, "produto não precisa da confirmação de autorização");
  const { id: pessoa } = await chamar({ acao: "enviarPessoa", tipo: "image/jpeg", nome: "Gabriel", base64: JPG, autorizado: true }, ana);
  const lista = (await chamar({ acao: "listarPessoas" }, ana)).pessoas;
  assert.equal(lista.find(x => x.id === produto).tipo, "produto"); assert.equal(lista.find(x => x.id === pessoa).tipo, "pessoa");
  const i = (await db().query("insert into ideias (org_id, titulo, formato, rede, score) values ($1, 'A pulseira no bar', 'Carrossel', 'Instagram', 8) returning id", [anaOrg])).rows[0].id;
  const { id } = await chamar({ acao: "agendarIdeia", id: i, data: new Date(Date.now() + 6 * 86400000).toISOString() }, ana);
  const original = globalThis.fetch, seedream = [];
  let corpoClaude = null, k = 0;
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (u.includes("anthropic.com")) {
      corpoClaude = JSON.parse(op.body);
      return json({ content: [{ type: "text", text: JSON.stringify({ legenda: "L", hashtags: [], cenas: [],
        slides: [{ n: 1, titulo: "Capa", texto: "", usa_imagem: true }, { n: 2, titulo: "Uso", texto: "", usa_imagem: true }],
        prompts_imagem: [{ slide: 1, prompt: "the product from the reference photo on a bar counter", proporcao: "4:5", produto: true },
          { slide: 2, prompt: "the person from the reference photo wearing the product from the reference photo", proporcao: "4:5", pessoa: true, produto: true }] }) }], stop_reason: "end_turn" });
    }
    if (u.endsWith("/seedream-v4-5-edit") && op.method === "POST") { seedream.push(JSON.parse(op.body)); return json({ data: { task_id: "p" + (++k), status: "CREATED" } }); }
    if (/\/seedream-v4-5-edit\/p\d/.test(u)) return json({ data: { status: "COMPLETED", generated: ["https://cdn.exemplo/ref.jpg"] } });
    if (u.startsWith("https://cdn.exemplo/")) return new Response(Buffer.from(JPG, "base64"), { headers: { "content-type": "image/jpeg" } });
    return original(url, op);
  };
  try {
    assert.equal((await chamar({ acao: "criarPost", id, briefing: { capa: "foto", fundo: "fotos", slides: "2", pessoa: produto } }, ana)).status, 400, "um produto não serve como pessoa");
    assert.equal((await chamar({ acao: "criarPost", id, briefing: { capa: "foto", fundo: "fotos", slides: "2", pessoa, produto } }, ana)).status, 200);
    await puxar();
    for (let n = 0; n < 100; n++) {
      const st = (await db().query("select status from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0].status;
      if (st === "feito" || st === "erro") break;
      await new Promise(r => setTimeout(r, 50));
    }
  } finally { globalThis.fetch = original; }
  const t = (await db().query("select status, erro from tarefas where tipo = 'criar' order by criado_em desc limit 1")).rows[0];
  assert.equal(t.status, "feito", t.erro || "");
  assert.match(JSON.stringify(corpoClaude.messages[0].content), /produto ou objeto real: mostre o produto da foto de referência \(Pulseira azul\)/);
  const url = x => lista.find(y => y.id === x).arquivo.url;
  const s1 = seedream.find(c => c.reference_images.length === 1), s2 = seedream.find(c => c.reference_images.length === 2);
  assert.deepEqual(s1.reference_images, [url(produto)]);
  assert.match(s1.prompt, /Keep the product\/object exactly as in its reference/);
  assert.deepEqual(s2.reference_images, [url(pessoa), url(produto)]);
  assert.match(s2.prompt, /^Reference image 1 is the person\. Reference image 2 is the product\/object\./);
  await chamar({ acao: "removerPessoa", id: produto }, ana); await chamar({ acao: "removerPessoa", id: pessoa }, ana);
});

test("vídeo .mov do iPhone (HEVC) vira MP4 H.264 no servidor, com capa e já no padrão do Instagram", async () => {
  const { spawnSync } = await import("node:child_process");
  const ffmpeg = (await import("ffmpeg-static")).default;
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "mov-")), mov = path.join(pasta, "iphone.mov");
  // vertical, HEVC + AAC em contêiner QuickTime, como sai da câmera do iPhone
  const g = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3",
    "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1", "-c:a", "aac", "-shortest", mov]);
  assert.equal(g.status, 0, String(g.stderr));
  const r = await chamar({ acao: "enviarImagemBanco", tipo: "video/quicktime", nome: "IMG_0001.MOV", titulo: "Gravado no iPhone", base64: fs.readFileSync(mov).toString("base64"), descrever: false }, ana);
  assert.equal(r.status, 200, r.erro);
  const a = (await db().query("select a.* from banco_imagens b join arquivos a on a.id = b.arquivo_id where b.id = $1", [r.id])).rows[0];
  assert.equal(a.tipo, "video/mp4"); assert.equal(a.nome, "IMG_0001.mp4"); assert.equal(a.padronizado, true); assert.equal(a.previa, true, "capa tirada do próprio vídeo");
  const info = spawnSync(ffmpeg, ["-hide_banner", "-i", path.join(process.env.PASTA_ARQUIVOS, anaOrg, a.id)]).stderr.toString();
  assert.match(info, /Video: h264/); assert.match(info, /Audio: aac/);
  const ruim = await chamar({ acao: "enviarImagemBanco", tipo: "video/quicktime", nome: "x.mov", base64: Buffer.from("isto não é vídeo").toString("base64") }, ana);
  assert.equal(ruim.status, 400); assert.match(ruim.erro, /Não consegui abrir este vídeo/);
  assert.equal((await chamar({ acao: "enviarImagemBanco", tipo: "application/pdf", nome: "x.pdf", base64: JPG }, ana)).status, 400);
  // arquivo grande vai inteiro pela rota /video (sem base64)
  const corpo = fs.readFileSync(mov), url = "/video?tipo=video%2Fquicktime&nome=IMG_0002.MOV&titulo=Grande";
  const semLogin = await app.inject({ method: "POST", url, payload: corpo, headers: { "content-type": "application/octet-stream" } });
  assert.equal(semLogin.statusCode, 401);
  const v = await app.inject({ method: "POST", url, payload: corpo, headers: { "content-type": "application/octet-stream", "x-pauta-token": ana } });
  assert.equal(v.statusCode, 200, v.body);
  const a2 = (await db().query("select a.tipo, a.nome, b.nome as titulo from banco_imagens b join arquivos a on a.id = b.arquivo_id where b.id = $1", [v.json().id])).rows[0];
  assert.deepEqual([a2.tipo, a2.nome, a2.titulo], ["video/mp4", "IMG_0002.mp4", "Grande"]);
  const pdf = await app.inject({ method: "POST", url: "/video?tipo=application%2Fpdf", payload: corpo, headers: { "content-type": "application/octet-stream", "x-pauta-token": ana } });
  assert.equal(pdf.statusCode, 400);
});
