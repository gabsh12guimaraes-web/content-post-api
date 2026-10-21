// Links de conta de uso único e entrega transacional pelo Loops. O banco guarda
// o hash do token; a fila de entrega guarda o conteúdo cifrado e o apaga ao enviar.
import { db } from './db.js';
import { hashSenha, hashToken, novoToken, cifrar, decifrar } from './cripto.js';
import { falha, texto } from './erros.js';

const TIPOS = {
  confirmacao: { variavel: 'LOOPS_CONFIRMACAO_ID', minutos: 1440, fragmento: 'confirmar-email' },
  recuperacao: { variavel: 'LOOPS_RECUPERACAO_ID', minutos: 30, fragmento: 'redefinir-senha' },
  senha_alterada: { variavel: 'LOOPS_SENHA_ALTERADA_ID' },
};
export const confirmacaoObrigatoria = () => process.env.AUTH_EMAIL_ATIVO === 'sim';
const configurado = tipo => !!(process.env.LOOPS_API_KEY && process.env[TIPOS[tipo].variavel]);
export const confirmacaoPendente = u => !!u.exigir_confirmacao_email && !u.email_confirmado_em;
function emailValido(valor) {
  const email = texto(valor, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falha('Digite um e-mail válido.');
  return email;
}
function novaSenha(valor) {
  if (typeof valor !== 'string' || valor.length < 8 || valor.length > 200) falha('A senha precisa ter pelo menos 8 caracteres.');
  return valor;
}
function urlApp() {
  const u = new URL(process.env.URL_APP || 'https://easycontentpost.com.br/app.html');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('URL_APP precisa usar HTTPS.');
  u.search = ''; u.hash = ''; u.username = ''; u.password = '';
  return u;
}
export function exigirEmailConfigurado(tipo) {
  if (!configurado(tipo)) falha('O envio de e-mails está temporariamente indisponível. Tente novamente mais tarde.', 503);
  urlApp();
}
export async function enfileirarEmailConta(tx, usuario, tipo, link = null) {
  if (!configurado(tipo)) return false;
  const u = urlApp();
  if (link) u.hash = `${TIPOS[tipo].fragmento}=${link.token}`;
  const payload = {
    transactionalId: process.env[TIPOS[tipo].variavel], email: usuario.email,
    addToAudience: false,
    dataVariables: {
      nome: usuario.nome || 'Olá', link: u.toString(),
      ...(tipo === 'senha_alterada'
        ? { data: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) }
        : { validade: tipo === 'confirmacao' ? '24 horas' : '30 minutos' }),
    },
  };
  await tx.query('insert into conta_emails (usuario_id, link_id, tipo, payload_cifrado) values ($1, $2, $3, $4)', [usuario.id, link?.id || null, tipo, cifrar(JSON.stringify(payload))]);
  return true;
}
export async function criarLinkConta(usuarioId, tipo, txExistente = null) {
  const criar = async tx => {
    const u = (await tx.query('select id, email, nome, email_confirmado_em from usuarios where id = $1 for update', [usuarioId])).rows[0];
    if (!u || tipo === 'confirmacao' && u.email_confirmado_em) return false;
    const recentes = (await tx.query("select count(*)::int as n, max(criado_em) as ultimo from conta_links where usuario_id = $1 and tipo = $2 and criado_em > now() - interval '1 hour'", [u.id, tipo])).rows[0];
    if (recentes.n >= 5 || recentes.ultimo && Date.now() - new Date(recentes.ultimo).getTime() < 60000) return false;
    await tx.query('update conta_links set usado_em = now() where usuario_id = $1 and tipo = $2 and usado_em is null', [u.id, tipo]);
    const token = novoToken();
    const link = (await tx.query('insert into conta_links (usuario_id, tipo, token_hash, expira_em) values ($1, $2, $3, $4) returning id', [u.id, tipo, hashToken(token), new Date(Date.now() + TIPOS[tipo].minutos * 60000)])).rows[0];
    await enfileirarEmailConta(tx, u, tipo, { id: link.id, token });
    return true;
  };
  return txExistente ? criar(txExistente) : db().transacao(criar);
}

let processando = null;
export function processarEmailsConta() {
  if (processando) return processando;
  processando = entregar().finally(() => { processando = null; });
  return processando;
}
async function entregar() {
  await db().query(`update conta_emails e set payload_cifrado = null, erro = 'link encerrado'
    where payload_cifrado is not null and link_id is not null and exists
    (select 1 from conta_links l where l.id = e.link_id and (l.usado_em is not null or l.expira_em <= now()))`);
  for (let i = 0; i < 5; i++) {
    const e = (await db().query(`update conta_emails set tentativas = tentativas + 1, proximo_envio_em = now() + interval '2 minutes'
      where id = (select id from conta_emails where payload_cifrado is not null and enviado_em is null
      and tentativas < 5 and proximo_envio_em <= now() order by criado_em for update skip locked limit 1) returning *`)).rows[0];
    if (!e) return;
    if (!configurado(e.tipo)) {
      await db().query("update conta_emails set erro = 'Loops não configurado' where id = $1", [e.id]);
      continue;
    }
    try {
      const payload = JSON.parse(decifrar(e.payload_cifrado));
      const r = await fetch('https://app.loops.so/api/v1/transactional', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LOOPS_API_KEY}`, 'Idempotency-Key': e.id },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!(r.ok && j.success === true || r.status === 409)) throw new Error(`Loops HTTP ${r.status}`);
      await db().query('update conta_emails set enviado_em = now(), payload_cifrado = null, erro = null where id = $1', [e.id]);
    } catch (error) {
      // A resposta do provedor pode repetir o link, destinatário ou credenciais.
      // Guardamos somente um diagnóstico controlado, sem dados do e-mail.
      const erro = /^Loops HTTP \d+$/.test(error.message) ? error.message : 'Falha ao entregar e-mail';
      await db().query('update conta_emails set erro = $2 where id = $1', [e.id, erro]);
    }
  }
}
export function agendarEmailsConta() {
  if (!process.env.LOOPS_API_KEY) return;
  setImmediate(() => processarEmailsConta().catch(() => console.error('[email] falha ao processar fila')));
}

async function consumirLink(token, tipo, fn) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) falha('Este link é inválido, expirou ou já foi utilizado. Solicite um novo.', 410);
  const tokenHash = hashToken(token);
  return db().transacao(async tx => {
    const alvo = (await tx.query('select usuario_id from conta_links where token_hash = $1 and tipo = $2', [tokenHash, tipo])).rows[0];
    if (!alvo) falha('Este link é inválido, expirou ou já foi utilizado. Solicite um novo.', 410);
    // A mesma ordem de locks da emissão impede corridas entre reenvio e uso.
    const u = (await tx.query('select * from usuarios where id = $1 for update', [alvo.usuario_id])).rows[0];
    const link = (await tx.query('update conta_links set usado_em = now() where token_hash = $1 and tipo = $2 and usado_em is null and expira_em > now() returning id', [tokenHash, tipo])).rows[0];
    if (!link || !u) falha('Este link é inválido, expirou ou já foi utilizado. Solicite um novo.', 410);
    await fn(tx, u);
    await tx.query('update conta_links set usado_em = now() where usuario_id = $1 and tipo = $2 and usado_em is null', [u.id, tipo]);
    return {};
  });
}

const RESPOSTA = { mensagem: 'Se houver uma conta elegível para esse e-mail, enviaremos as instruções. Confira também a caixa de spam.' };
export const acoesEmail = {
  async opcoesAutenticacao() {
    return { confirmacao: confirmacaoObrigatoria(), recuperacao: configurado('recuperacao'), reenvio: configurado('confirmacao') };
  },
  async solicitarConfirmacaoEmail(_ctx, b) {
    exigirEmailConfigurado('confirmacao');
    const u = (await db().query('select id from usuarios where email = $1', [emailValido(b.email)])).rows[0];
    if (u) await criarLinkConta(u.id, 'confirmacao');
    agendarEmailsConta();
    return RESPOSTA;
  },
  async solicitarRecuperacaoSenha(_ctx, b) {
    exigirEmailConfigurado('recuperacao');
    const u = (await db().query('select id from usuarios where email = $1', [emailValido(b.email)])).rows[0];
    if (u) await criarLinkConta(u.id, 'recuperacao');
    agendarEmailsConta();
    return RESPOSTA;
  },
  async confirmarEmail(_ctx, b) {
    await consumirLink(b.token, 'confirmacao', (tx, u) => tx.query('update usuarios set email_confirmado_em = coalesce(email_confirmado_em, now()) where id = $1', [u.id]));
    return { confirmado: true };
  },
  async redefinirSenha(_ctx, b) {
    const senha = novaSenha(b.senha);
    await consumirLink(b.token, 'recuperacao', async (tx, u) => {
      const { salt, senha_hash } = await hashSenha(senha);
      await tx.query('update usuarios set salt = $2, senha_hash = $3, tentativas = 0, bloqueado_ate = null where id = $1', [u.id, salt, senha_hash]);
      await tx.query('delete from sessoes where usuario_id = $1', [u.id]);
      await enfileirarEmailConta(tx, u, 'senha_alterada');
    });
    agendarEmailsConta();
    return { redefinida: true };
  },
};
