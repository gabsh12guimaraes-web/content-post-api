# E-mails de conta · Easy Content Post

Os três modelos incluem design responsivo, o logo da marca, botão de ação e alternativa para copiar o link. As fontes usam Arial/Helvetica para funcionar sem downloads extras em clientes de e-mail.

## Importar no Loops

1. Verifique seu domínio e endereço remetente no Loops. Escolha um endereço de resposta que sua equipe acompanhe.
2. Vá a **Transactional → Create**. No editor, selecione **Code** e envie um dos ZIPs individuais: `confirmacao-transacional.zip`, `recuperacao-transacional.zip` ou `senha-alterada-transacional.zip`. Não importe o ZIP geral. Cada ZIP individual contém `index.mjml` na raiz e `img/logo.png`. Se já enviou uma versão anterior, use **Upload another email** no mesmo rascunho transacional e selecione o ZIP corrigido.
3. Configure o assunto e o preview conforme a tabela. Confira as variáveis no editor sem renomeá-las.
4. Desative o rastreamento de cliques nos links de segurança. A URL precisa preservar o fragmento `#confirmar-email=...` ou `#redefinir-senha=...` até chegar ao app. A confirmação exige um clique na página; apenas abrir o e-mail não consome o link.
5. Use a prévia e um envio de teste do próprio Loops para conferir a importação. Publique cada modelo e copie seu **Transactional ID** para a variável correspondente no Railway.

| Arquivo | Assunto | Preview | Variáveis | Variável no Railway |
| --- | --- | --- | --- | --- |
| confirmacao-transacional.zip | Confirme seu e-mail \| Easy Content Post | Só falta confirmar seu endereço para começar a criar. | nome, link, validade | LOOPS_CONFIRMACAO_ID |
| recuperacao-transacional.zip | Redefina sua senha \| Easy Content Post | Um link seguro para você voltar às suas boas ideias. | nome, link, validade | LOOPS_RECUPERACAO_ID |
| senha-alterada-transacional.zip | Sua senha foi alterada \| Easy Content Post | Confira a atualização de segurança da sua conta. | nome, link, data | LOOPS_SENHA_ALTERADA_ID |

O MJML usa a sintaxe oficial `{DATA_VARIABLE:nome}`. E-mails **transacionais** não aceitam o link de descadastro `{unsubscribe_link}`; os três modelos não contêm esse link. Cadastre os modelos em **Transactional**, sem transformá-los em campanhas ou inscrever o destinatário em marketing. A API envia `addToAudience: false`.

Referência do importador: https://loops.so/docs/creating-emails/uploading-custom-email

## Ativar no Railway

No projeto **content-post**, serviço **api → Variables**, cadastre:

```dotenv
LOOPS_API_KEY=chave_cadastrada_somente_no_Railway
LOOPS_CONFIRMACAO_ID=id_publicado_do_modelo_de_confirmacao
LOOPS_RECUPERACAO_ID=id_publicado_do_modelo_de_recuperacao
LOOPS_SENHA_ALTERADA_ID=id_publicado_do_aviso_de_senha
URL_APP=https://easycontentpost.com.br/app.html
AUTH_EMAIL_ATIVO=sim
```

A chave não deve ser colocada no frontend nem enviada pelo chat. Defina `AUTH_EMAIL_ATIVO=sim` depois de publicar os modelos e conferir o remetente. O aviso de senha alterada é opcional; confirmação e recuperação precisam dos respectivos modelos para enviar.

As migrações são aplicadas automaticamente quando a nova API inicia. A fila de e-mails usa o mesmo banco e `CHAVE_MESTRA` já existentes; não altere essa chave. O trabalhador verifica a fila a cada 15 segundos. Falhas transitórias são tentadas novamente, até cinco tentativas. Não há envio real durante os testes automatizados.

## Conferir o fluxo

1. Crie uma conta de teste: deverá ficar na tela de confirmação, sem liberar a organização antes da confirmação.
2. Abra o e-mail, pressione **Confirmar meu e-mail** na página e volte ao app. Pressione **Já confirmei meu e-mail** ou faça login novamente.
3. No login, escolha **Esqueceu sua senha?** e informe seu e-mail. Abra o link e salve a nova senha. As sessões anteriores serão encerradas.
4. Confira o aviso de senha alterada. Em **Minha senha**, a troca com a senha atual mantém a sessão atual e encerra as demais.

Confirmação vale 24 horas; recuperação vale 30 minutos. Ambos usam links únicos. Reenviar invalida o link anterior; há um intervalo mínimo de 60 segundos e limite por conta. As respostas públicas de recuperação não revelam se um e-mail existe.

Contas criadas antes da ativação mantêm acesso. Elas não são marcadas como confirmadas artificialmente. O cadastro passa a exigir confirmação apenas para contas novas com a opção ativa.

No iPhone, o link abre o site para confirmar/redefinir; depois a pessoa pode voltar ao app. A origem `capacitor://localhost` está liberada na nova API. O aplicativo precisa de um novo build no Codemagic para receber as novas telas.

## Arquivos

`index.mjml` é a fonte editável. `email.html` é a compilação para inspeção. As prévias HTML públicas usam dados fictícios e não contêm links de autenticação reais. O arquivo `modelos.json` documenta assuntos, previews e variáveis.
