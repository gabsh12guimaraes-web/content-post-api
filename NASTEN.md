# Configurar a Nasten no Railway

1. Complete o cadastro da empresa na Nasten e aguarde a liberação para vender. Na conferência de 20/10/2026, os nove checkouts exibiam `company_not_verified` ("Você precisa completar o seu cadastro antes de começar a vender"). Confira também se as ofertas são assinaturas, com renovação mensal, semestral e anual, conforme desejado: o título da oferta sozinho não configura recorrência.
2. Na Nasten, gere as chaves de API de **Produção**. No serviço **content-post-api** do Railway, em **Variables**, adicione `NASTEN_PUBLIC_KEY` e `NASTEN_SECRET_KEY`. Não coloque essas chaves no site, no GitHub ou em mensagens.
3. Após publicar esta versão da API, cadastre um **webhook da conta** na Nasten apontando para:

   `https://api-production-70f3.up.railway.app/nasten`

   Selecione `transaction_created`, `transaction_paid`, `transaction_refunded`, `transaction_updated` e `product_canceled`. Filtre pelos três produtos Content Post, se houver outros produtos na conta. O endpoint aceita o teste sem assinatura que a Nasten faz ao cadastrar a URL.
4. Copie o `signatureSecret` **desse webhook** para a variável `NASTEN_WEBHOOK_SECRET` no Railway e aplique/republique as variáveis. Não é a chave secreta da API. A Nasten informa esse segredo na criação/consulta do webhook; veja a [documentação de webhooks](https://nasten.mintlify.site/pages/webhook/overview).
5. Mantenha `TRABALHADOR` ligado (padrão: variável ausente ou diferente de `nao`) e `NASTEN_SANDBOX=nao` em produção. Não precisa mudar `CHAVE_MESTRA`, as chaves de IA, os limites dos planos ou os dados dos clientes.
6. Teste uma venda no ambiente de teste separado ou confira uma compra real aprovada já existente, reenviando seu evento pelo painel da Nasten. O plano deve aparecer em **Plano** da organização correta. Reenviar o mesmo evento não deve estender novamente o acesso. Não faça cobranças reais só para testar a configuração.
7. Depois de validar também o valor final dos cupons, altere `PAGAMENTOS_PROVEDOR=nasten` no Railway e publique a versão do site da branch `migracao-nasten`. Essa é a virada dos redirecionamentos. Até esse passo, o site e o catálogo continuam com os links Kiwify atuais; o receptor Nasten já pode receber testes e eventos válidos.

## Ofertas e cupons

| Plano | Mensal | Semestral | Anual | Afiliados |
| --- | --- | --- | --- | --- |
| Essencial | [xk10c2k](https://app.nasten.com.br/checkout/xk10c2k) | [et20cqs](https://app.nasten.com.br/checkout/et20cqs) | [6t20djh](https://app.nasten.com.br/checkout/6t20djh) | [Solicitar](https://app.nasten.com.br/join/afiliate/8y30w7u) |
| Profissional | [5d6038k](https://app.nasten.com.br/checkout/5d6038k) | [78703pn](https://app.nasten.com.br/checkout/78703pn) | [d110wxt](https://app.nasten.com.br/checkout/d110wxt) | [Solicitar](https://app.nasten.com.br/join/afiliate/m220w7q) |
| Agência | [g6b03qk](https://app.nasten.com.br/checkout/g6b03qk) | [wic0399](https://app.nasten.com.br/checkout/wic0399) | [6jd030e](https://app.nasten.com.br/checkout/6jd030e) | [Solicitar](https://app.nasten.com.br/join/afiliate/5he032m) |

Os nove cupons foram conferidos no checkout e reconhecidos com os mesmos percentuais: `ESSENCIALMENSAL` 52%, `ESSENCIALSEMESTRAL` 50%, `ESSENCIALANUAL` 46%; `PROFISSIONALMENSAL` 52%, `PROFISSIONALSEMESTRAL` 49%, `PROFISSIONALANUAL` 45%; `AGENCIAMENSAL` 52%, `AGENCIASEMESTRAL` 49%, `AGENCIAANUAL` 45%. Os links continuam levando `coupon=CODIGO`, mas o checkout observado não aplica esse parâmetro automaticamente. Por isso o site e o painel mostram o código para copiar e aplicar no campo de cupom. O preço anunciado é à vista com desconto; os juros do parcelamento são definidos no checkout Nasten.

Na conferência do checkout Essencial mensal, a Nasten mostrou "Cupom ESSENCIALMENSAL aplicado (52% off)", mas o total do cartão continuou exibindo o preço cheio com parcelamento. Isso ocorreu também ao clicar em **Aplicar**, sem realizar compra. Antes de divulgar as novas ofertas, confirme com a Nasten que o desconto está refletido no total mostrado e cobrado. O site Content Post não controla o cálculo nem o formulário hospedado na Nasten.

Compras dentro da plataforma levam `sck=<organização>` e `email=<e-mail>` para a Nasten. O comprador deve usar o e-mail da conta Content Post: o preenchimento automático de e-mail não é presumido. Compras pela landing são conciliadas pelo e-mail do dono quando ele identifica uma única organização. Quem administra várias deve comprar pelo botão **Plano** da organização desejada. Uma compra antes do cadastro é reprocessada depois do cadastro com o mesmo e-mail.

As ofertas públicas atuais (ids 93 a 101 e produtos correspondentes) estão em `src/ofertas.js`. Se recriar ofertas, ajuste esse arquivo ou `NASTEN_OFERTAS` (`{"novo-id-da-oferta":"essencial:mensal"}`), e `NASTEN_CHECKOUT` se trocar URLs. Nunca confie no nome ou no plano enviado pelo navegador para liberar acesso.

## Transição e financeiro

Mantenha `KIWIFY_TOKEN` e o webhook antigo enquanto existirem cobranças antigas que possam renovar ou estornar. Isso não cria novas vendas Kiwify. A migração não cancela assinaturas existentes nem faz estornos. Confira as assinaturas dos clientes antes de orientar uma troca, para evitar duas cobranças recorrentes.

No painel financeiro, as taxas Nasten são as efetivamente informadas na API; não se reutiliza 8,99% + R$ 2,49. A comissão de afiliados anunciada permanece em 13%; confira essa configuração e as renovações nos três produtos Nasten. Os convites foram trocados pelos fornecidos; nenhuma afiliação é solicitada automaticamente.

Para diagnóstico, consulte `nasten_eventos` (`status`, `resultado`, `tentativas`, `executar_em`) e `nasten_pagamentos`. Não registre o corpo completo, documentos ou chaves em logs. A Nasten não reenvia falhas automaticamente: use o reenvio manual quando um aviso não chegou ao servidor. A fila interna trata falhas posteriores ao recebimento, e a conciliação cobre os casos descritos no README.
