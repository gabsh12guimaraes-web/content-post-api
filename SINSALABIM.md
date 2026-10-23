# Sinsalabim · configuração e operação

O editor recebe o vídeo original, transcreve o áudio com Groq Whisper Turbo, cria um plano de edição com Claude e mostra uma prévia local no app. Só depois da confirmação envia a versão para renderização no Shotstack. O MP4 final é copiado para o volume da plataforma e para o banco de imagens da organização. A pessoa pode baixar ou encaminhar para Revisão; nunca publica automaticamente.

## Ativar no Railway

1. Crie uma conta em [Groq](https://console.groq.com/keys) e gere uma chave de API. Confira saldo/limites para usar `whisper-large-v3-turbo`.
2. Crie uma conta no [Shotstack](https://dashboard.shotstack.io/) e copie a chave da **Edit API**. Use a chave **Production** para vídeos finais sem a marca de teste. Confira os minutos disponíveis no plano.
3. No serviço **api → Variables**, cadastre as duas chaves diretamente, sem enviá-las pelo chat:

```dotenv
GROQ_API_KEY=sua_chave_do_Groq
SHOTSTACK_API_KEY=sua_chave_de_producao_do_Shotstack
SHOTSTACK_SANDBOX=nao
```

4. O editor reutiliza a integração Claude da organização ou da plataforma e o mesmo modelo dos outros fluxos (`MODELO_CLAUDE`, padrão `claude-opus-5-5`), que recebe os quadros do vídeo, a transcrição e a conversa e devolve o plano de edição. Para usar outro modelo só no Sinsalabim, configure `SINSALABIM_MODELO` com um modelo da geração 5 (a chamada usa o fallback automático do servidor, que os modelos 4.x não aceitam).
5. Confira `URL_PUBLICA`: precisa apontar para o domínio HTTPS público da API. O Shotstack acessa o vídeo e as imagens pelos links assinados da plataforma. Endereços locais ou internos não servem para uma exportação real.
6. Aplique as variáveis e publique o commit mais recente do repositório `content-post-api`, branch `main`. A migração `032_sinsalabim.sql` roda automaticamente. Mantenha o trabalhador ligado (`TRABALHADOR` diferente de `nao`), pois ele processa a análise e recupera o resultado da exportação.

Para um piloto, cadastre a chave Sandbox em `SHOTSTACK_SANDBOX_API_KEY` e use `SHOTSTACK_SANDBOX=sim`. Mantenha a chave Production em `SHOTSTACK_API_KEY`. As exportações desse ambiente têm marca d'água do provedor. Use `SHOTSTACK_SANDBOX=nao` antes de liberar resultados finais para clientes. O ambiente fica salvo em cada exportação; vídeos Sandbox não podem seguir para revisão.

Referências: [Groq Speech to Text](https://console.groq.com/docs/speech-to-text), [Shotstack API](https://shotstack.io/docs/api/), [HTML5](https://shotstack.io/docs/guide/architecting-an-application/html5/), [preços Shotstack](https://shotstack.io/pricing/).

## Fluxo e limites

- Entrada de 1 segundo a 5 minutos. O limite de armazenamento é 25 MB; o navegador tenta preparar arquivos maiores ou de outros formatos para MP4. A conversão depende do suporte do navegador ao codec original.
- Saída vertical 9:16, H.264/MP4, 1080p, até 60 segundos.
- Três estilos: clean, dinâmico e comercial. A edição segue o padrão do app Captions: o Claude escolhe os trechos e o sistema tira os silêncios acima de 0,6 s; cada salto alterna o enquadramento (normal / zoom fixo de 12%) para esconder o corte, sem zoom lento (que treme no render). Legenda em blocos de até 3 palavras em Montserrat grossa e maiúscula, acendendo a palavra falada (estilos `captions`, `pilula` e `unica`); palavra-chave em letra cursiva (Pacifico) gigante na cor da marca com uma linha de apoio. Legendas, destaques e chamadas vão numa única camada HTML5 com as fontes embutidas (`src/fontes`, SIL OFL), porque o HTML5 do Shotstack bloqueia fontes remotas. Imagens de apoio só de fotos enviadas pela marca ou do acervo (artes geradas ficam de fora); o Claude vê a miniatura de cada foto e só usa a que mostra o que está sendo dito (no máximo 3).
- A fala original é preservada. Esta versão não gera músicas, dublagens, imagens novas, substituição de rostos ou efeitos livres. O plano mostra avisos quando um pedido não puder ser atendido.
- A transcrição é reaproveitada nas conversas seguintes. Prévia e ajustes não descontam exportações.
- **5 exportações por organização por mês**, renovadas à meia-noite de Brasília no início do mês. Tentativas em processamento reservam uma posição para impedir que chamadas paralelas ultrapassem o limite. Repetir a mesma versão já finalizada retorna o arquivo existente.
- Uma falha definitiva libera a posição. Um envio de resultado incerto fica reservado e exige conferência antes de tentar outra exportação: o app não repete um POST pago automaticamente.
- Encaminhar para revisão usa um crédito de post do plano, separado da exportação. A legenda gerada fica editável no fluxo de revisão existente.

## Conferência antes de liberar

1. Envie um MP4 curto com fala clara em português. Solicite cortes, legendas e um título.
2. Confira os trechos e o enquadramento no player. Peça um ajuste pelo chat e verifique se a transcrição não foi chamada novamente.
3. Clique em exportar e confira a confirmação. Sem confirmar, não há chamada de renderização.
4. Aguarde o MP4 final. Teste a reprodução no app, o download e o envio à revisão com data futura.
5. Confira o banco da organização e o consumo em Painel admin (Groq e Shotstack). A estimativa padrão é US$ 0,04/h de transcrição e US$ 0,20/min de renderização avulsa; ajuste `src/custos.js` se contratar outro plano.

Os testes automatizados usam um vídeo real criado localmente e simulam todas as chamadas aos provedores. A validação com credenciais reais depende das chaves e do deploy de produção.

## Recuperação e isolamento

Histórico, fontes, conversas, imagens de apoio e exportações são filtrados pela organização autenticada. Nenhuma chave vai ao navegador. O chat só produz dados validados; não executa comandos, código ou URLs sugeridos pelo modelo.

Os trabalhos e IDs do Shotstack ficam no Postgres. A consulta ao resultado é retomada após reinícios. O MP4 é guardado localmente para não depender da validade do link temporário do provedor. Arquivos usados no histórico são preservados mesmo se o item do banco for removido.

Se uma exportação ficar `incerto`, a equipe deve consultar o histórico da Edit API no Shotstack antes de iniciar outra. Um processo interrompido durante o envio nunca é reenviado automaticamente. Quando o ID já foi salvo, apenas consultas de status e recuperação do arquivo são repetidas.
