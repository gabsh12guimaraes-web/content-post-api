import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DATABASE_URL = 'pglite:memoria';
process.env.CHAVE_MESTRA = crypto.randomBytes(32).toString('base64');
process.env.LOOPS_API_KEY = 'loops-chave-teste';
process.env.LOOPS_CONFIRMACAO_ID = 'confirmacao-teste';
process.env.LOOPS_RECUPERACAO_ID = 'recuperacao-teste';
process.env.LOOPS_SENHA_ALTERADA_ID = 'senha-teste';
process.env.AUTH_EMAIL_ATIVO = 'sim';
const { conectar, db, desconectar } = await import('../src/db.js');
const { criarApp } = await import('../src/app.js');
const { processarEmailsConta } = await import('../src/autenticacao-email.js');
await conectar();
const app = await criarApp(), envios = [], original = globalThis.fetch;
let falhar = false;
globalThis.fetch = async (url, op) => {
  assert.equal(url, 'https://app.loops.so/api/v1/transactional');
  assert.equal(op.headers.Authorization, 'Bearer loops-chave-teste');
  assert(op.headers['Idempotency-Key']);
  const body = JSON.parse(op.body); assert.equal(body.addToAudience, false); envios.push(body);
  return new Response(JSON.stringify(falhar ? { success: false, message: 'não registrar link secreto' } : { success: true }), { status: falhar ? 503 : 200 });
};
const chamar = async (body, token, ip='10.1.1.1') => {
  const r = await app.inject({method:'POST',url:'/api',payload:body,remoteAddress:ip,headers:token?{'x-pauta-token':token}:{}});
  return {status:r.statusCode,...r.json()};
};
const tokenDo = e => new URL(e.dataVariables.link).hash.split('=')[1];
let conta;
after(async()=>{await processarEmailsConta();globalThis.fetch=original;await app.close();await desconectar();});

test('API aceita a origem do app iOS e continua exigindo sessão',async()=>{
  const r=await app.inject({method:'OPTIONS',url:'/api',headers:{origin:'capacitor://localhost','access-control-request-method':'POST'}});
  assert.equal(r.headers['access-control-allow-origin'],'capacitor://localhost');
  assert.equal((await chamar({acao:'listar'})).status,401);
});

test('nova conta recebe confirmação, sem liberar o app antes de confirmar', async()=>{
  conta=await chamar({acao:'cadastrar',nome:'Ana',email:'ana@example.com',senha:'segredo123',organizacao:'Marca'});
  assert.equal(conta.status,200);assert.equal(conta.usuario.confirmacaoPendente,true);
  assert.equal((await chamar({acao:'listar'},conta.token)).confirmarEmail,true);
  await processarEmailsConta();
  const e=envios.find(e=>e.transactionalId==='confirmacao-teste');assert(e);assert.equal(e.dataVariables.validade,'24 horas');
  assert.equal(new URL(e.dataVariables.link).origin,'https://easycontentpost.com.br');
  const l=(await db().query('select * from conta_links')).rows[0];assert.notEqual(l.token_hash,tokenDo(e));
  const fila=(await db().query('select * from conta_emails')).rows[0];assert.equal(fila.payload_cifrado,null);
  assert.equal((await chamar({acao:'confirmarEmail',token:tokenDo(e)})).status,200);
  assert.equal((await chamar({acao:'confirmarEmail',token:tokenDo(e)})).status,410);
  assert.equal((await chamar({acao:'eu'},conta.token)).usuario.emailConfirmado,true);
  assert.equal((await chamar({acao:'listar'},conta.token)).status,200);
});
test('recuperação não revela a existência da conta e limita reenvios',async()=>{
  const a=await chamar({acao:'solicitarRecuperacaoSenha',email:'ana@example.com',voltar:'https://invasor.example'});
  const b=await chamar({acao:'solicitarRecuperacaoSenha',email:'nao-existe@example.com'});
  assert.deepEqual(a,b);
  await chamar({acao:'solicitarRecuperacaoSenha',email:'ana@example.com'});await processarEmailsConta();
  const lista=envios.filter(e=>e.transactionalId==='recuperacao-teste');assert.equal(lista.length,1);
  assert.equal(new URL(lista[0].dataVariables.link).origin,'https://easycontentpost.com.br');
  assert.equal(lista[0].dataVariables.validade,'30 minutos');
});
test('redefinição usa o link uma única vez, troca senha e revoga sessões',async()=>{
  const token=tokenDo(envios.find(e=>e.transactionalId==='recuperacao-teste'));
  assert.equal((await chamar({acao:'redefinirSenha',token,senha:'nova-senha-123'})).status,200);
  assert.equal((await chamar({acao:'redefinirSenha',token,senha:'outra-senha-123'})).status,410);
  assert.equal((await chamar({acao:'eu'},conta.token)).status,401);
  assert.equal((await chamar({acao:'entrar',email:'ana@example.com',senha:'segredo123'})).status,401);
  conta=await chamar({acao:'entrar',email:'ana@example.com',senha:'nova-senha-123'});assert.equal(conta.status,200);
  await processarEmailsConta();assert(envios.some(e=>e.transactionalId==='senha-teste'));
});
test('links expirados não alteram a senha; nova senha exige tamanho mínimo',async()=>{
  await db().query("update conta_links set criado_em=now()-interval '2 minutes' where tipo='recuperacao'");
  await chamar({acao:'solicitarRecuperacaoSenha',email:'ana@example.com'});await processarEmailsConta();
  const token=tokenDo(envios.filter(e=>e.transactionalId==='recuperacao-teste').at(-1));
  assert.equal((await chamar({acao:'redefinirSenha',token,senha:'curta'})).status,400);
  await db().query("update conta_links set expira_em=now()-interval '1 second' where tipo='recuperacao'");
  assert.equal((await chamar({acao:'redefinirSenha',token,senha:'outra-senha-123'})).status,410);
});
test('troca autenticada invalida recuperação pendente e mantém só a sessão atual',async()=>{
  await db().query("update conta_links set criado_em=now()-interval '2 minutes' where tipo='recuperacao'");
  await chamar({acao:'solicitarRecuperacaoSenha',email:'ana@example.com'});await processarEmailsConta();
  const token=tokenDo(envios.filter(e=>e.transactionalId==='recuperacao-teste').at(-1));
  const outra=await chamar({acao:'entrar',email:'ana@example.com',senha:'nova-senha-123'});
  assert.equal((await chamar({acao:'trocarSenha',atual:'errada',nova:'senha-final-123'},conta.token)).status,400);
  assert.equal((await chamar({acao:'trocarSenha',atual:'nova-senha-123',nova:'senha-final-123'},conta.token)).status,200);
  assert.equal((await chamar({acao:'redefinirSenha',token,senha:'senha-invalida-123'})).status,410);
  assert.equal((await chamar({acao:'eu'},conta.token)).status,200);assert.equal((await chamar({acao:'eu'},outra.token)).status,401);
});
test('falha do Loops preserva entrega cifrada para retomada sem expor o token',async()=>{
  falhar=true;
  await chamar({acao:'cadastrar',nome:'Bia',email:'bia@example.com',senha:'segredo123',organizacao:'Bia'});
  await processarEmailsConta();
  const row=(await db().query("select e.* from conta_emails e join usuarios u on u.id=e.usuario_id where u.email='bia@example.com'")).rows[0];
  assert.match(row.payload_cifrado,/^v1\./);assert.equal(row.erro,'Loops HTTP 503');
  assert(!row.payload_cifrado.includes('confirmar-email'));
  falhar=false;await db().query('update conta_emails set proximo_envio_em=now() where id=$1',[row.id]);await processarEmailsConta();
  assert.equal((await db().query('select payload_cifrado from conta_emails where id=$1',[row.id])).rows[0].payload_cifrado,null);
});
test('contas anteriores mantêm acesso sem receber uma confirmação fictícia',async()=>{
  process.env.AUTH_EMAIL_ATIVO='nao';
  const legado=await chamar({acao:'cadastrar',nome:'Legado',email:'legado@example.com',senha:'segredo123',organizacao:'Antiga'});
  assert.equal(legado.usuario.emailConfirmado,false);assert.equal(legado.usuario.confirmacaoPendente,false);
  assert.equal((await chamar({acao:'listar'},legado.token)).status,200);
  process.env.AUTH_EMAIL_ATIVO='sim';const old=process.env.LOOPS_CONFIRMACAO_ID;delete process.env.LOOPS_CONFIRMACAO_ID;
  assert.equal((await chamar({acao:'cadastrar',nome:'Sem envio',email:'novo@example.com',senha:'segredo123',organizacao:'Teste'})).status,503);
  process.env.LOOPS_CONFIRMACAO_ID=old;
});
