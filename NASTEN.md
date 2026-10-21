# Configurar a Nasten no Railway

1. O cadastro da empresa foi liberado para vender: os nove checkouts passaram a informar `canSell: true`. Confira se as ofertas são assinaturas, com renovação mensal, semestral e anual, conforme desejado: o título da oferta sozinho não configura recorrência.
2. Na Nasten, gere as chaves de API de **Produção**. No serviço **content-post-api** do Railway, em **Variables**, adicione `NASTEN_PUBLIC_KEY` e `NASTEN_SECRET_KEY`. Não coloque essas chaves no site, no GitHub ou em mensagens.
3. Após publicar esta versão da API, cadastre um **webhook da conta** na Nasten apontando para:

   `https://api-production-70f3.up.railway.app/nasten`

   Selecione `transaction_created`, `transaction_paid`, `transaction_refunded`, `transaction_updated` e `product_canceled`. Filtre pelos três produtos Content Post, se houver outros produtos na conta. O endpoint aceita o teste sem assinatura que a Nasten faz ao cadastrar a URL.
4. Copie o `signatureSecret` **desse webhook** para a variável `NASTEN_WEBHOOK_SECRET` no Railway e aplique/republique as variáveis. Não é a chave secreta da API. A Nasten informa esse segredo na criação/consulta do webhook; veja a [documentação de webhooks](https://nasten.mintlify.site/pages/webhook/overview).
5. Mantenha `TRABALHADOR` ligado (padrão: variável ausente ou diferente de `nao`) e `NASTEN_SANDBOX=nao` em produção. Não precisa mudar `CHAVE_MESTRA`, as chaves de IA, os limites dos planos ou os dados dos clientes.
6. Teste uma venda no ambiente de teste separado ou confira uma compra real aprovada já existente, reenviando seu evento pelo painel da Nasten. O plano deve aparecer em **Plano** da organização correta. Reenviar o mesmo evento não deve estender novamente o acesso. Não faça cobranças reais só para testar a configuração.
7. A migração foi liberada para publicação após a configuração e a validação da cobrança pelo responsável pela conta. O catálogo da API usa a Nasten por padrão e o site usa os checkouts atuais. A variável temporária `PAGAMENTOS_PROVEDOR` não precisa ser configurada e, se ainda existir no Railway, pode ser removida; ela não altera mais os links.

## Ofertas com preço final

| Plano | Mensal | Semestral | Anual | Afiliados |
| --- | --- | --- | --- | --- |
| Essencial | [1b00ye7](https://app.nasten.com.br/checkout/1b00ye7) | [n2004ue](https://app.nasten.com.br/checkout/n2004ue) | [lb1040d](https://app.nasten.com.br/checkout/lb1040d) | [Solicitar](https://app.nasten.com.br/join/afiliate/8y30w7u) |
| Profissional | [1i204x5](https://app.nasten.com.br/checkout/1i204x5) | [w7304kn](https://app.nasten.com.br/checkout/w7304kn) | [qj40411](https://app.nasten.com.br/checkout/qj40411) | [Solicitar](https://app.nasten.com.br/join/afiliate/m220w7q) |
| Agência | [wn504iq](https://app.nasten.com.br/checkout/wn504iq) | [sn604vs](https://app.nasten.com.br/checkout/sn604vs) | [y910yjc](https://app.nasten.com.br/checkout/y910yjc) | [Solicitar](https://app.nasten.com.br/join/afiliate/5he032m) |

Os nove checkouts usam os preços finais, sem cupom:

| Plano | Mensal | Semestral (6 meses) | Anual (12 meses) |
| --- | ---: | ---: | ---: |
| Essencial | R$ 177,12 | R$ 1.017,00 | R$ 1.989,36 |
| Profissional | R$ 420,96 | R$ 2.469,42 | R$ 4.811,40 |
| Agência | R$ 1.107,36 | R$ 6.478,02 | R$ 12.665,40 |

Os preços à vista foram conferidos nos nove checkouts públicos. O site e o painel não enviam nem mostram códigos de desconto. Desative os cupons antigos na Nasten para evitar descontos adicionais sobre os preços novos. Juros de parcelamento são definidos no checkout Nasten. Nenhuma cobrança real é feita pelos testes automatizados.

Compras dentro da plataforma levam `sck=<organização>` e `email=<e-mail>` para a Nasten. O comprador deve usar o e-mail da conta Content Post: o preenchimento automático de e-mail não é presumido. Compras pela landing são conciliadas pelo e-mail do dono quando ele identifica uma única organização. Quem administra várias deve comprar pelo botão **Plano** da organização desejada. Uma compra antes do cadastro é reprocessada depois do cadastro com o mesmo e-mail.

As ofertas públicas atuais (ids 102 a 110 e produtos correspondentes) estão em `src/ofertas.js`. Os mesmos três produtos continuam sendo usados; não é necessário trocar chaves nem recriar o webhook por causa desses links. As ofertas anteriores, ids 93 a 101, permanecem reconhecidas para eventos atrasados, renovações e conciliação, mas não aparecem no catálogo. Se recriar ofertas, ajuste esse arquivo ou `NASTEN_OFERTAS` (`{"novo-id-da-oferta":"essencial:mensal"}`), e `NASTEN_CHECKOUT` se trocar URLs. Nunca confie no nome ou no plano enviado pelo navegador para liberar acesso.

## Transição e financeiro

Mantenha `KIWIFY_TOKEN` e o webhook antigo enquanto existirem cobranças antigas que possam renovar ou estornar. Isso não cria novas vendas Kiwify. A migração não cancela assinaturas existentes nem faz estornos. Confira as assinaturas dos clientes antes de orientar uma troca, para evitar duas cobranças recorrentes.

No painel financeiro, as taxas Nasten são as efetivamente informadas na API; não se reutiliza 8,99% + R$ 2,49. A comissão de afiliados anunciada permanece em 13%; confira essa configuração e as renovações nos três produtos Nasten. Os convites foram trocados pelos fornecidos; nenhuma afiliação é solicitada automaticamente.

Para diagnóstico, consulte `nasten_eventos` (`status`, `resultado`, `tentativas`, `executar_em`) e `nasten_pagamentos`. Não registre o corpo completo, documentos ou chaves em logs. A Nasten não reenvia falhas automaticamente: use o reenvio manual quando um aviso não chegou ao servidor. A fila interna trata falhas posteriores ao recebimento, e a conciliação cobre os casos descritos no README.
