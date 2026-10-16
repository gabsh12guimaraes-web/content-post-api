// Contas, sessões, organizações, membros, convites e chaves das integrações.
import { db } from "../db.js";
import { config } from "../config.js";
import { hashSenha, conferirSenha, novoToken, hashToken, cifrar } from "../cripto.js";
import { falha, exigirId, texto } from "../erros.js";
import { testarProvedor } from "../provedores/testar.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PESO = { editor: 1, admin: 2, dono: 3 };
export const PROVEDORES = {
  anthropic: { nome: "Claude (Anthropic)", uso: "Escreve ideias, posts e ajustes", onde: "console.anthropic.com › API Keys" },
  magnific: { nome: "Magnific (Freepik)", uso: "Gera as fotos e os clipes de vídeo", onde: "magnific.com › Developers › API key" },
  apify: { nome: "Apify", uso: "Coleta posts das fontes (Instagram e TikTok)", onde: "console.apify.com › Settings › API & Integrations" },
  ayrshare: { nome: "Ayrshare", uso: "Publica nas redes na data agendada", onde: "app.ayrshare.com › API Key" },
};
const emailOk = e => { const v = texto(e, 200).toLowerCase(); if (!EMAIL.test(v)) falha("Digite um e-mail válido."); return v; };
const senhaOk = s => { if (typeof s !== "string" || s.length < 8 || s.length > 200) falha("A senha precisa ter pelo menos 8 caracteres."); return s; };
export const podeGerir = papel => PESO[papel] >= PESO.admin;

async function abrirSessao(usuario, org, lembrar) {
  const token = novoToken();
  const expira = new Date(Date.now() + (lembrar ? 30 : 1) * 86400000);
  await db().query("insert into sessoes (usuario_id, token_hash, org_atual, expira_em) values ($1, $2, $3, $4)", [usuario, hashToken(token), org, expira]);
  return { token, expira: expira.toISOString() };
}

// Quem é a pessoa, de quais organizações participa e em qual está agora.
export async function descrever(usuarioId, orgAtual) {
  const u = (await db().query("select id, email, nome from usuarios where id = $1", [usuarioId])).rows[0];
  const orgs = (await db().query(
    "select o.id, o.nome, m.papel from membros m join organizacoes o on o.id = m.org_id where m.usuario_id = $1 order by o.nome", [usuarioId])).rows;
  const atual = orgs.find(o => o.id === orgAtual) || orgs[0] || null;
  return { usuario: { id: u.id, email: u.email, nome: u.nome, papel: atual ? atual.papel : null }, organizacoes: orgs, organizacao: atual };
}

async function convitePorToken(token) {
  const { rows } = await db().query(
    "select c.*, o.nome as org_nome from convites c join organizacoes o on o.id = c.org_id where c.token_hash = $1", [hashToken(String(token || ""))]);
  const c = rows[0];
  if (!c || c.aceito_em || new Date(c.expira_em) < new Date()) falha("Este convite não vale mais. Peça um novo para quem convidou você.", 404);
  return c;
}
async function entrarNaOrg(tx, convite, usuarioId) {
  await tx.query("insert into membros (org_id, usuario_id, papel) values ($1, $2, $3) on conflict (org_id, usuario_id) do nothing", [convite.org_id, usuarioId, convite.papel]);
  await tx.query("update convites set aceito_em = now() where id = $1", [convite.id]);
}

export const acoesConta = {
  async cadastrar(_ctx, b) {
    const email = emailOk(b.email), senha = senhaOk(b.senha), nome = texto(b.nome, 100);
    if (!nome) falha("Preencha seu nome.");
    const convite = b.convite ? await convitePorToken(b.convite) : null;
    if (convite && convite.email !== email) falha("Use o mesmo e-mail que recebeu o convite.");
    if (!convite && !config.cadastroAberto) falha("O cadastro está fechado. Peça um convite.", 403);
    const nomeOrg = texto(b.organizacao, 100);
    if (!convite && !nomeOrg) falha("Dê um nome para a sua organização.");
    if ((await db().query("select 1 from usuarios where email = $1", [email])).rows.length) falha("Já existe uma conta com este e-mail. Entre com ela.");
    const { salt, senha_hash } = await hashSenha(senha);
    const { usuario, org } = await db().transacao(async tx => {
      const u = (await tx.query("insert into usuarios (email, nome, senha_hash, salt, ultimo_acesso) values ($1, $2, $3, $4, now()) returning id", [email, nome, senha_hash, salt])).rows[0].id;
      let o;
      if (convite) { await entrarNaOrg(tx, convite, u); o = convite.org_id; }
      else {
        o = (await tx.query("insert into organizacoes (nome, criado_por) values ($1, $2) returning id", [nomeOrg, u])).rows[0].id;
        await tx.query("insert into membros (org_id, usuario_id, papel) values ($1, $2, 'dono')", [o, u]);
        await tx.query("insert into marcas (org_id, nome) values ($1, $2)", [o, nomeOrg]);
      }
      return { usuario: u, org: o };
    });
    const s = await abrirSessao(usuario, org, true);
    return { ...s, ...(await descrever(usuario, org)) };
  },

  async entrar(_ctx, b) {
    const email = texto(b.email, 200).toLowerCase(), senha = String(b.senha || "").slice(0, 200);
    const u = (await db().query("select * from usuarios where email = $1", [email])).rows[0];
    if (!u) { await conferirSenha(senha, "x", ""); falha("E-mail ou senha incorretos.", 401); }
    if (u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date()) falha("Muitas tentativas erradas. Tente de novo em 15 minutos.", 429);
    if (!(await conferirSenha(senha, u.salt, u.senha_hash))) {
      const t = u.tentativas + 1;
      if (t >= 5) await db().query("update usuarios set tentativas = 0, bloqueado_ate = now() + interval '15 minutes' where id = $1", [u.id]);
      else await db().query("update usuarios set tentativas = $2 where id = $1", [u.id, t]);
      falha(t >= 5 ? "Muitas tentativas erradas. Tente de novo em 15 minutos." : "E-mail ou senha incorretos.", 401);
    }
    await db().query("update usuarios set tentativas = 0, bloqueado_ate = null, ultimo_acesso = now() where id = $1", [u.id]);
    const ultima = (await db().query("select org_atual from sessoes where usuario_id = $1 and org_atual is not null order by criado_em desc limit 1", [u.id])).rows[0];
    const info = await descrever(u.id, ultima && ultima.org_atual);
    const s = await abrirSessao(u.id, info.organizacao && info.organizacao.id, !!b.lembrar);
    return { ...s, ...info };
  },

  async verConvite(_ctx, b) {
    const c = await convitePorToken(b.convite);
    const temConta = (await db().query("select 1 from usuarios where email = $1", [c.email])).rows.length > 0;
    return { convite: { organizacao: c.org_nome, email: c.email, papel: c.papel, temConta } };
  },

  async eu(ctx) { return descrever(ctx.usuario.id, ctx.org); },

  async sair(ctx) { await db().query("delete from sessoes where id = $1", [ctx.sessao]); return {}; },

  async trocarSenha(ctx, b) {
    const u = (await db().query("select salt, senha_hash from usuarios where id = $1", [ctx.usuario.id])).rows[0];
    if (!(await conferirSenha(String(b.atual || ""), u.salt, u.senha_hash))) falha("A senha atual não confere.");
    const { salt, senha_hash } = await hashSenha(senhaOk(b.nova));
    await db().query("update usuarios set salt = $2, senha_hash = $3 where id = $1", [ctx.usuario.id, salt, senha_hash]);
    // Encerra as outras sessões desta pessoa.
    await db().query("delete from sessoes where usuario_id = $1 and id <> $2", [ctx.usuario.id, ctx.sessao]);
    return {};
  },

  async aceitarConvite(ctx, b) {
    const c = await convitePorToken(b.convite);
    if (c.email !== ctx.usuario.email) falha(`Este convite é para ${c.email}. Entre com essa conta para aceitar.`, 403);
    await db().transacao(tx => entrarNaOrg(tx, c, ctx.usuario.id));
    await db().query("update sessoes set org_atual = $2 where id = $1", [ctx.sessao, c.org_id]);
    return descrever(ctx.usuario.id, c.org_id);
  },

  async criarOrganizacao(ctx, b) {
    const nome = texto(b.nome, 100);
    if (!nome) falha("Dê um nome para a organização.");
    const org = await db().transacao(async tx => {
      const o = (await tx.query("insert into organizacoes (nome, criado_por) values ($1, $2) returning id", [nome, ctx.usuario.id])).rows[0].id;
      await tx.query("insert into membros (org_id, usuario_id, papel) values ($1, $2, 'dono')", [o, ctx.usuario.id]);
      await tx.query("insert into marcas (org_id, nome) values ($1, $2)", [o, nome]);
      return o;
    });
    await db().query("update sessoes set org_atual = $2 where id = $1", [ctx.sessao, org]);
    return descrever(ctx.usuario.id, org);
  },

  async trocarOrganizacao(ctx, b) {
    const org = exigirId(b.org, "Organização inválida.");
    if (!(await db().query("select 1 from membros where org_id = $1 and usuario_id = $2", [org, ctx.usuario.id])).rows.length) falha("Você não participa desta organização.", 403);
    await db().query("update sessoes set org_atual = $2 where id = $1", [ctx.sessao, org]);
    return descrever(ctx.usuario.id, org);
  },
};

// Ações que precisam de uma organização selecionada.
export const acoesOrg = {
  async renomearOrganizacao(ctx, b) {
    if (!podeGerir(ctx.papel)) falha("Só donos e administradores podem renomear a organização.", 403);
    const nome = texto(b.nome, 100); if (!nome) falha("Dê um nome para a organização.");
    await db().query("update organizacoes set nome = $2 where id = $1", [ctx.org, nome]);
    return descrever(ctx.usuario.id, ctx.org);
  },

  async listarMembros(ctx) {
    const membros = (await db().query(
      `select u.id, u.nome, u.email, m.papel, u.ultimo_acesso from membros m join usuarios u on u.id = m.usuario_id where m.org_id = $1 order by u.nome`, [ctx.org])).rows;
    const convites = podeGerir(ctx.papel) ? (await db().query(
      "select id, email, papel, expira_em, criado_em from convites where org_id = $1 and aceito_em is null and expira_em > now() order by criado_em desc", [ctx.org])).rows : [];
    return { membros, convites, podeGerir: podeGerir(ctx.papel) };
  },

  async convidar(ctx, b) {
    if (!podeGerir(ctx.papel)) falha("Só donos e administradores podem convidar.", 403);
    const email = emailOk(b.email);
    const papel = ["admin", "editor"].includes(b.papel) ? b.papel : "editor";
    if (papel === "admin" && ctx.papel !== "dono" && ctx.papel !== "admin") falha("Sem permissão para convidar administradores.", 403);
    const ja = await db().query("select 1 from membros m join usuarios u on u.id = m.usuario_id where m.org_id = $1 and u.email = $2", [ctx.org, email]);
    if (ja.rows.length) falha("Esta pessoa já faz parte da organização.");
    const token = novoToken();
    await db().query("delete from convites where org_id = $1 and email = $2 and aceito_em is null", [ctx.org, email]);
    await db().query("insert into convites (org_id, email, papel, token_hash, criado_por, expira_em) values ($1, $2, $3, $4, $5, now() + interval '7 days')",
      [ctx.org, email, papel, hashToken(token), ctx.usuario.id]);
    // O painel monta o link com este código. Ele só aparece agora; no banco fica só o hash.
    return { convite: token, email, papel, validoDias: 7 };
  },

  async cancelarConvite(ctx, b) {
    if (!podeGerir(ctx.papel)) falha("Sem permissão.", 403);
    await db().query("delete from convites where id = $1 and org_id = $2", [exigirId(b.id), ctx.org]);
    return {};
  },

  async mudarPapel(ctx, b) {
    if (!podeGerir(ctx.papel)) falha("Só donos e administradores podem mudar papéis.", 403);
    const alvo = exigirId(b.usuario), papel = b.papel;
    if (!PESO[papel]) falha("Papel inválido.");
    if (papel === "dono" && ctx.papel !== "dono") falha("Só um dono pode tornar outra pessoa dona.", 403);
    const atual = (await db().query("select papel from membros where org_id = $1 and usuario_id = $2", [ctx.org, alvo])).rows[0];
    if (!atual) falha("Pessoa não encontrada na organização.", 404);
    if (atual.papel === "dono" && ctx.papel !== "dono") falha("Só um dono pode mudar o papel de outro dono.", 403);
    if (atual.papel === "dono" && papel !== "dono") {
      const donos = (await db().query("select count(*)::int as n from membros where org_id = $1 and papel = 'dono'", [ctx.org])).rows[0].n;
      if (donos <= 1) falha("A organização precisa de pelo menos um dono.");
    }
    await db().query("update membros set papel = $3 where org_id = $1 and usuario_id = $2", [ctx.org, alvo, papel]);
    return {};
  },

  async removerMembro(ctx, b) {
    const alvo = exigirId(b.usuario);
    const proprio = alvo === ctx.usuario.id;
    if (!proprio && !podeGerir(ctx.papel)) falha("Só donos e administradores podem remover pessoas.", 403);
    const atual = (await db().query("select papel from membros where org_id = $1 and usuario_id = $2", [ctx.org, alvo])).rows[0];
    if (!atual) falha("Pessoa não encontrada na organização.", 404);
    if (atual.papel === "dono") {
      if (!proprio && ctx.papel !== "dono") falha("Só um dono pode remover outro dono.", 403);
      const donos = (await db().query("select count(*)::int as n from membros where org_id = $1 and papel = 'dono'", [ctx.org])).rows[0].n;
      if (donos <= 1) falha("A organização precisa de pelo menos um dono. Passe a posse para outra pessoa antes.");
    }
    await db().query("delete from membros where org_id = $1 and usuario_id = $2", [ctx.org, alvo]);
    await db().query("update sessoes set org_atual = null where usuario_id = $1 and org_atual = $2", [alvo, ctx.org]);
    return proprio ? descrever(ctx.usuario.id, null) : {};
  },

  async listarIntegracoes(ctx) {
    const salvas = new Map((await db().query("select provedor, dica, atualizado_em from integracoes where org_id = $1", [ctx.org])).rows.map(r => [r.provedor, r]));
    return {
      podeGerir: podeGerir(ctx.papel),
      integracoes: Object.entries(PROVEDORES).map(([id, p]) => ({ id, ...p, configurada: salvas.has(id), dica: salvas.get(id)?.dica || "", atualizadoEm: salvas.get(id)?.atualizado_em || null })),
    };
  },

  async salvarIntegracao(ctx, b) {
    if (!podeGerir(ctx.papel)) falha("Só donos e administradores podem cadastrar chaves.", 403);
    if (!PROVEDORES[b.provedor]) falha("Integração desconhecida.");
    const valor = String(b.valor || "").trim();
    if (valor.length < 8 || valor.length > 500 || /\s/.test(valor)) falha("Cole a chave inteira, sem espaços.");
    await db().query(
      `insert into integracoes (org_id, provedor, valor_cifrado, dica, atualizado_por) values ($1, $2, $3, $4, $5)
       on conflict (org_id, provedor) do update set valor_cifrado = excluded.valor_cifrado, dica = excluded.dica, atualizado_por = excluded.atualizado_por, atualizado_em = now()`,
      [ctx.org, b.provedor, cifrar(valor), "…" + valor.slice(-4), ctx.usuario.id]);
    return {};
  },

  async removerIntegracao(ctx, b) {
    if (!podeGerir(ctx.papel)) falha("Só donos e administradores podem remover chaves.", 403);
    await db().query("delete from integracoes where org_id = $1 and provedor = $2", [ctx.org, String(b.provedor || "")]);
    return {};
  },

  async testarIntegracao(ctx, b) {
    if (!PROVEDORES[b.provedor]) falha("Integração desconhecida.");
    return { resultado: await testarProvedor(ctx.org, b.provedor) };
  },
};
