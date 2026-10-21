# content-post-api

API da **Pauta de Conteúdo**. Várias organizações usam a mesma plataforma, cada uma com a sua marca, equipe, calendário e chaves de API.

- **Contas e organizações:** qualquer pessoa cria conta e organização. O dono convida pessoas por link. Papéis: **dono**, **admin** (gerencia equipe e chaves) e **editor** (cuida da pauta).
- **Integrações por organização:** cada organização cadastra as próprias chaves do Claude, Magnific, Apify e Ayrshare. Elas ficam cifradas (AES-256-GCM) e nunca voltam para o navegador.
- **Automação dentro da API:** busca de ideias (Apify + Claude), criação do post (Claude + fotos e clipes do Magnific), ajustes e publicação na hora marcada (Ayrshare). Substitui os fluxos do n8n.
- **Isolamento:** toda consulta filtra pela organização da sessão. Os testes cobrem isso.

O painel (repositório `content-post`) fala com esta API por `POST /api`.

O **Mega Brain** usa `listarMegaBrain` e `gerarEstrategiaMegaBrain` para salvar estratégias por organização. As perguntas guiadas são locais; a síntese usa Claude na fila `estrategia` e está incluída no plano. `buscarIdeias` aceita `estrategia`, `etapa` (`topo`, `meio` ou `fundo`) e um UUID `pedido` para gerar ideias contextualizadas, descontando uma busca. O pedido é idempotente; falhas da geração devolvem a busca. A migração `028_mega_brain.sql` cria o histórico e os vínculos das ideias.

`enviarFonteMarca` recebe `base64` e `nome` opcional, valida TTF/OTF/WOFF/WOFF2 com FontKit (até 5 MB) e guarda a fonte no volume com vínculo à organização. `listar` devolve `tipografias`; a diagramação usa `fonte: "marca-<uuid>"`, validada também nas opções por slide e em modelos salvos. A migração `029_fontes_marca.sql` cria esse cadastro; não há nova variável de ambiente.

Os slides e cenas podem conter `blocos`, uma lista de até oito textos com `tipo` (destaque, apoio ou selo), `x`, `y`, `largura`, `altura` (percentuais), `tamanho`, `alinhar`, `cor` e `caixa`. A IA pode propor essas composições e `salvarTextos` permite editá-las sem perder os prompts de mídia. A estrutura antiga de título e texto continua aceita. Alterar textos ou a diagramação invalida as artes anteriores; os arquivos originais de mídia são preservados.

## Subir no Railway

1. No Railway, crie um projeto e adicione um **Postgres** (New › Database › PostgreSQL).
2. Adicione um serviço a partir deste repositório (New › GitHub Repo › `content-post-api`).
3. No serviço, aba **Variables**, cadastre:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `CHAVE_MESTRA` = 32 bytes em base64. Gere no seu computador com
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
     e guarde num gerenciador de senhas. Se perder, as chaves das integrações precisam ser cadastradas de novo.
   - `PASTA_ARQUIVOS` = `/data/arquivos`
   - `ORIGENS` = `https://gabsh12guimaraes-web.github.io`
4. No serviço, crie um **Volume** montado em `/data` (guarda logos, fotos, clipes e artes).
5. Aba **Settings › Networking**: gere um domínio público. É esse endereço que vai no painel.
6. Abra `https://SEU-DOMINIO/saude`. Deve responder `{"ok":true}`.

As tabelas são criadas sozinhas na primeira vez que a API sobe (pasta `migracoes/`).

## Redes por organização no Zernio

Conexões feitas pelo painel usam o profile exclusivo da organização. Para contas já existentes em um Zernio compartilhado, abra **Integrações › Selecionar redes desta organização** e marque apenas as contas daquela marca. Uma conta só pode estar vinculada a uma organização. O vínculo vale tanto para exibição quanto para publicação.

A administração da plataforma (`ADMIN_EMAILS`) pode distribuir as contas do Zernio principal. Clientes com Zernio próprio continuam podendo cadastrar sua chave; para selecionar contas, donos e administradores precisam informar essa chave novamente. A lista completa nunca é exibida aos demais membros. Chaves próprias antigas precisam dessa seleção antes de voltar a publicar; a migração não tenta adivinhar a qual marca cada conta pertence.

## Trazer os dados do Airtable

Depois de criar sua conta no painel, vá em **Integrações › Trazer do Airtable**, cole um token do Airtable com leitura da base e o ID da base. A API importa marca (com logos e mood board), fontes, ideias e calendário (com fotos, clipes e artes). O token é usado só nessa importação e não fica salvo.

## Rodar no computador

```bash
npm install
cp .env.exemplo .env   # preencha CHAVE_MESTRA; DATABASE_URL pode ficar pglite:./dados-locais
node --env-file=.env src/servidor.js
```

## Primeiro acesso e posts prontos

O primeiro acesso permite analisar o Instagram público e/ou site da marca via Apify + Claude. O resultado fica como rascunho na tarefa `analisarMarca`; os dados da marca só são salvos quando a pessoa revisa e continua. A opção manual segue disponível e não chama provedores.

Em Home ou Calendário, **Enviar post pronto** usa arquivos do banco da própria organização, mantém a ordem e gera somente legenda e hashtags com Claude. Vídeos são analisados por até quatro quadros locais via FFmpeg. Sem diagramação é o padrão; modelos opcionais são aplicados pelo renderizador existente. O post fica em revisão e precisa de aprovação para agendar. A geração da legenda usa um post do plano, devolvido em caso de falha; não chama geração de imagens ou vídeos.

## Ideias e vitrine do login

Os detalhes das ideias ficam em **Ver mais**. **Ver exemplos** mostra até três publicações reais de Instagram/TikTok, usando referências da ideia e, quando necessário, uma busca por temas relacionados via Claude e Apify. Os resultados ficam em cache por sete dias e podem ser atualizados pelo botão do pop-up. A busca não cria posts nem consome a quantidade de posts do plano; o consumo dos provedores é registrado normalmente.

Para usar mídia do banco na vitrine pública do login, um administrador da plataforma (`ADMIN_EMAILS`) abre **Banco de imagens › Editar** e marca **Exibir esta mídia na tela de login**. Só itens gerados por IA da organização atual podem ser selecionados. A rota pública `/vitrine/:id` confere essa seleção a cada acesso e não divulga as URLs privadas da biblioteca. Até oito itens selecionados são usados; enquanto não houver seleção, o painel mostra as mídias de demonstração já incluídas no site. Mídias selecionadas não são removidas pela limpeza automática do banco.

## Testes

```bash
npm test
```

Usam Postgres embutido (PGlite) e simulam as APIs externas. Nada é cobrado.

## Segredos

Nenhuma chave, senha ou token fica neste repositório. Senhas das pessoas: hash scrypt. Sessões e convites: só o hash SHA-256 do token. Chaves das integrações: cifradas com a `CHAVE_MESTRA`, que existe só nas variáveis do Railway.

## Acervo Magnific quando faltar crédito

A migração `030_acervo_magnific.sql` habilita uma preferência por chave e registra a procedência das fotos do acervo. Em Integrações → Magnific, quem administra a conta informa Premium, Premium+ ou Pro e salva a preferência. Fica desligada por padrão; uma chave nova precisa de nova configuração. Apenas o administrador da plataforma configura a chave compartilhada da plataforma.

Depois de uma resposta de saldo insuficiente na geração, a criação ou ajuste pode buscar fotos prontas em `GET https://api.magnific.com/v1/resources`, obter o download licenciado e salvar o original no banco daquela organização. Arquivos já baixados são reutilizados. A [documentação de preços](https://docs.magnific.com/pricing) prevê até 100 downloads por dia sem créditos nesses planos; o limite é compartilhado pela conta e o retorno 429 interrompe a busca. Business e Enterprise não são habilitados porque podem cobrar por download. Não há novas variáveis de ambiente nem geração adicional de IA nesse fallback.

Fotos de acervo ficam identificadas como `origem=acervo`, com recurso, autor, referência de licença e data. Não substituem pessoas ou produtos de referência por fotos genéricas. Em Reels, entram como cenas estáticas; a pessoa revisa, monta o vídeo final e confirma a aprovação. Falta de permissão, limite diário ou ausência de resultados mantém o aviso para escolher uma mídia do banco. Os testes usam respostas simuladas; nenhuma chave real é usada.

## Pagamentos pela Nasten

Veja o passo a passo em [NASTEN.md](NASTEN.md). As novas compras usam os nove checkouts Nasten com preços finais sem cupom e os convites de afiliados. A migração está liberada: a variável temporária `PAGAMENTOS_PROVEDOR` não controla mais o catálogo. `KIWIFY_CHECKOUT` e `KIWIFY_AFILIADOS` antigos deixam de definir os links do painel. Os planos já pagos não são removidos e `/kiwify` permanece para os avisos das compras anteriores; esses avisos não alteram uma organização que já comprou na Nasten.

`POST /nasten` valida o HMAC-SHA256 de `signature-hmac` com o corpo bruto e grava o evento antes de responder `202`. O teste exato `{"test":true}` responde `200` sem processar nada. A fila confirma a venda em `GET /v1/transactions/{id}`, confere a empresa e associa a organização pelo `sck` mais o e-mail de um membro; sem `sck`, só aceita um e-mail que seja dono de exatamente uma organização. Compra anterior ao cadastro fica pendente e volta a ser conferida. Nunca escolhe uma organização arbitrária quando há várias.

A liberação é idempotente por transação, preserva o acesso no cancelamento até o fim do período e não deixa avisos antigos substituírem uma compra mais recente. Estornos só encerram o acesso quando pertencem à cobrança que sustenta o plano atual. Valores do painel financeiro vêm do `amount` e `netAmount` reais da Nasten, sem aplicar a taxa histórica da Kiwify às novas compras.

Com o trabalhador ligado, eventos pendentes são retomados a cada 30 segundos. A cada 15 minutos há conciliação das vendas dos últimos 30 dias (até 500 por execução) e de 20 pagamentos antigos, em rodízio, para detectar avisos perdidos e estornos. Uma venda sem webhook só é reconhecida quando o item Content Post e seu preço correspondem exatamente a uma oferta atual ou um valor histórico conhecido; valores diferentes precisam de conferência. Eventos assinados já recebidos continuam na fila mesmo após esses 30 dias. As consultas usam as chaves de Produção; testes isolados usam `NASTEN_SANDBOX=sim`.
