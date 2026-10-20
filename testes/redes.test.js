// Isolamento de contas em um Zernio compartilhado, com API e Postgres reais e provedor simulado.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.DATABASE_URL = "pglite:memoria";
process.env.CHAVE_MESTRA = crypto.randomBytes(32).toString("base64");
const { conectar, db, desconectar } = await import("../src/db.js");
const { criarApp } = await import("../src/app.js");
const { publicarZernio } = await import("../src/provedores/index.js");

test("Zernio compartilhado: vínculo explícito, permissões, publicação, cache e troca de chave", async () => {
  await conectar();
  const app = await criarApp(), original = globalThis.fetch;
  const chave = "sk_zernio_compartilhado_teste", posts = [], pedidos = [];
  let foraDoAr = false;
  const contas = [
    { _id: "ig-a", platform: "instagram", username: "marca_a", profileId: "principal", isActive: true },
    { _id: "ig-b", platform: "instagram", username: "marca_b", profileId: { _id: "principal" }, isActive: true },
    { _id: "fb-b", platform: "facebook", username: "marca_b_fb", profileId: "principal", isActive: true },
    { _id: "ig-nativa", platform: "instagram", username: "outra_marca", profileId: "perfil-exclusivo", isActive: true },
  ];
  globalThis.fetch = async (url, op = {}) => {
    const u = new URL(url); assert.equal(u.hostname, "zernio.com");
    pedidos.push(u.pathname);
    if (foraDoAr) return new Response("indisponível", { status: 503 });
    if (u.pathname === "/api/v1/accounts") return Response.json({ accounts: contas });
    if (u.pathname === "/api/v1/posts" && op.method === "POST") {
      posts.push(JSON.parse(op.body));
      return Response.json({ post: { _id: "post-simulado", status: "published", platforms: [{ status: "published" }] } });
    }
    throw new Error("Pedido inesperado: " + u.pathname);
  };
  const chamar = async (b, token) => {
    const r = await app.inject({ method: "POST", url: "/api", payload: b, headers: token ? { "x-pauta-token": token } : {} });
    return { status: r.statusCode, ...r.json() };
  };
  const publicar = org => publicarZernio(org, { rede: "instagram", midias: [{ type: "image", url: "https://example.invalid/a.jpg" }], legenda: "teste", chave: crypto.randomUUID() });
  try {
    const a = await chamar({ acao: "cadastrar", nome: "Ana", email: "a@redes.test", senha: "segredo123", organizacao: "Marca A" });
    const b = await chamar({ acao: "cadastrar", nome: "Bia", email: "b@redes.test", senha: "segredo123", organizacao: "Marca B" });
    const c = await chamar({ acao: "cadastrar", nome: "Caio", email: "c@redes.test", senha: "segredo123", organizacao: "Marca C" });
    await db().query("update organizacoes set zernio_profile = 'perfil-exclusivo' where id = $1", [c.organizacao.id]);
    for (const u of [a, b]) assert.equal((await chamar({ acao: "salvarIntegracao", provedor: "zernio", valor: chave }, u.token)).status, 200);
    for (const u of [a, b]) {
      const r = await chamar({ acao: "contasRedes" }, u.token);
      assert.deepEqual(r.contas, []); assert.equal(r.podeVincular, true); assert.equal(r.precisaChave, true);
      assert.equal((await publicar(u.organizacao.id)).ok, false);
    }
    assert.equal(pedidos.length, 0, "sem vínculo não consulta o catálogo global");
    assert.equal((await chamar({ acao: "contasParaVincular" }, a.token)).status, 400);
    assert.equal((await chamar({ acao: "vincularContas", contas: ["ig-a"], chave: "chave-errada" }, a.token)).status, 400);
    assert.equal(pedidos.length, 0, "sem comprovar a chave não acessa contas compartilhadas");
    assert.equal((await chamar({ acao: "contasParaVincular", chave })).status, 401);
    const conv = await chamar({ acao: "convidar", email: "editor@redes.test", papel: "editor" }, a.token);
    const editor = await chamar({ acao: "cadastrar", nome: "Editor", email: "editor@redes.test", senha: "segredo123", convite: conv.convite });
    assert.equal((await chamar({ acao: "contasParaVincular", chave }, editor.token)).status, 403);
    assert.equal((await chamar({ acao: "vincularContas", contas: ["ig-a"], chave }, editor.token)).status, 403);
    assert.equal((await chamar({ acao: "contasRedes" }, editor.token)).podeVincular, false);
    const catalogo = await chamar({ acao: "contasParaVincular", chave }, a.token);
    assert.deepEqual(catalogo.contas.map(c => c.id), ["ig-a", "ig-b", "fb-b"], "não expõe o profile de outra organização");
    // Um org enviado no corpo nunca substitui a organização autenticada.
    assert.equal((await chamar({ acao: "vincularContas", contas: ["ig-a"], chave, org: b.organizacao.id }, a.token)).status, 200);
    assert.deepEqual((await chamar({ acao: "contasRedes", org: a.organizacao.id }, b.token)).contas, []);
    assert.equal((await chamar({ acao: "vincularContas", contas: ["ig-b", "fb-b"], chave }, b.token)).status, 200);
    assert.deepEqual((await chamar({ acao: "contasRedes" }, a.token)).contas.map(c => c.id), ["ig-a"]);
    assert.deepEqual((await chamar({ acao: "contasRedes" }, b.token)).contas.map(c => c.id), ["ig-b", "fb-b"]);
    assert.deepEqual((await chamar({ acao: "redesConectadas" }, a.token)).redes, ["Instagram"]);
    assert.deepEqual((await chamar({ acao: "redesConectadas" }, b.token)).redes, ["Instagram", "Facebook"]);
    assert.deepEqual((await chamar({ acao: "contasParaVincular", chave }, b.token)).contas.map(c => c.id), ["ig-b", "fb-b"]);
    assert.equal((await chamar({ acao: "vincularContas", contas: ["ig-a"], chave }, b.token)).status, 400, "não pode tomar a conta de outra organização");
    assert.deepEqual((await chamar({ acao: "contasRedes" }, b.token)).contas.map(c => c.id), ["ig-b", "fb-b"], "falha mantém os vínculos anteriores");
    assert.equal((await chamar({ acao: "vincularContas", contas: ["ig-nativa"], chave }, a.token)).status, 400);
    assert.equal((await chamar({ acao: "vincularContas", contas: ["inexistente"], chave }, a.token)).status, 400);
    assert.equal((await publicar(a.organizacao.id)).ok, true);
    assert.equal((await publicar(b.organizacao.id)).ok, true);
    assert.deepEqual(posts.map(p => p.platforms[0].accountId), ["ig-a", "ig-b"], "cada marca publica na conta certa");
    foraDoAr = true;
    assert.deepEqual((await chamar({ acao: "contasRedes" }, a.token)).contas.map(c => c.id), ["ig-a"], "cache da própria organização");
    foraDoAr = false;
    assert.equal((await chamar({ acao: "vincularContas", contas: [], chave }, a.token)).status, 200);
    assert.equal((await chamar({ acao: "vincularContas", contas: ["ig-a", "ig-b", "fb-b"], chave }, b.token)).status, 200);
    foraDoAr = true;
    assert.deepEqual((await chamar({ acao: "contasRedes" }, a.token)).contas, [], "cache não ressuscita conta desvinculada");
    assert.equal((await publicar(a.organizacao.id)).ok, false);
    assert.equal(posts.length, 2);
    foraDoAr = false;
    await chamar({ acao: "salvarIntegracao", provedor: "zernio", valor: "sk_zernio_nova_chave" }, b.token);
    assert.deepEqual((await chamar({ acao: "contasRedes" }, b.token)).contas, [], "troca de chave exige conferir a seleção");
    assert.equal((await chamar({ acao: "contasParaVincular", chave }, b.token)).status, 400);
    // Zernio principal: só o administrador da plataforma pode distribuir as contas antigas.
    process.env.COBRANCA = "sim"; process.env.PLATAFORMA_ZERNIO = chave;
    assert.equal((await chamar({ acao: "contasRedes" }, c.token)).podeVincular, false);
    assert.equal((await chamar({ acao: "contasParaVincular", chave }, c.token)).status, 400);
    process.env.ADMIN_EMAILS = "c@redes.test";
    assert.equal((await chamar({ acao: "contasRedes" }, c.token)).podeVincular, true);
    const principal = await chamar({ acao: "contasParaVincular" }, c.token);
    assert.deepEqual(principal.contas.map(c => c.id), ["ig-nativa"]);
    assert.equal(principal.contas[0].fixa, true);
    contas.push({ _id: "nova", platform: "instagram", username: "marca_c", profileId: "principal", isActive: true });
    assert.equal((await chamar({ acao: "vincularContas", contas: ["nova"] }, c.token)).status, 200);
    assert.deepEqual((await chamar({ acao: "contasRedes" }, c.token)).contas.map(c => c.id), ["ig-nativa", "nova"]);
    assert.equal((await chamar({ acao: "vincularContas", contas: ["ig-a"] }, c.token)).status, 400, "nem admin transfere uma conta já atribuída sem desvincular");
    const l = JSON.stringify(await chamar({ acao: "contasRedes" }, c.token));
    assert.equal(l.includes(chave), false); assert.equal(l.includes("marca_b"), false);
  } finally {
    globalThis.fetch = original;
    for (const n of ["COBRANCA", "PLATAFORMA_ZERNIO", "ADMIN_EMAILS"]) delete process.env[n];
    await app.close(); await desconectar();
  }
});
