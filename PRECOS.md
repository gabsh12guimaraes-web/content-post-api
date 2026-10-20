# Como os preços dos planos foram calculados

Meta: **cerca de 40% de lucro** (receita líquida ≈ 1,4 × custo) na venda direta, mesmo no pior caso: o plano anual. O mensal e o semestral ficam um pouco acima para o anual ter desconto.

Na venda por afiliado, o lucro é **dividido meio a meio**: o afiliado fica com metade e a Content Post com a outra.

## Custo por post (inclui a IA)

| Item | Estimativa | Observação |
|---|---|---|
| Claude Opus 5.5 | US$ 0,30 | criação + 1 ajuste + parte da busca de ideias ($4/MTok entrada, $20/MTok saída) |
| Magnific | US$ 0,85 | média de 60% carrossel (6 fotos Mystic × US$ 0,07) e 40% vídeo (3 clipes Kling de 5 s × US$ 0,10/s) |
| Apify | US$ 0,02 | coleta de referências |
| Zernio | US$ 0,14 | plano Build (US$ 16 por 120 posts) |
| **Total** | **US$ 1,31** | × R$ 5,60 × 15% de folga para refações = **R$ 8,45 por post** |

Mais R$ 5 por organização por mês de servidor (Railway).

Os preços do Magnific são de fontes de terceiros (a Freepik cobra por créditos). Confira na sua conta e refaça a conta se mudar.

## Taxas

- Kiwify: 8,99% + R$ 2,49 por venda.
- Afiliados: **13% de comissão nos três planos** (configurar em cada produto da Kiwify, com comissão também nas renovações).

## Planos

O preço do produto na Kiwify continua o antigo ("de", mostrado riscado). O desconto vem de um **cupom por oferta**, que já entra no link do checkout (`?coupon=ESSENCIALMENSAL` e assim por diante; o código é o plano + o ciclo, em maiúsculas e sem acento).

| Plano | Posts/mês | Custo/mês | Mensal | Semestral | Anual |
|---|---|---|---|---|---|
| Essencial | 12 | R$ 106 | R$ 369 − 52% = **R$ 177,12** | R$ 2.034 − 50% = **R$ 1.017** (R$ 169,50/mês) | R$ 3.684 − 46% = **R$ 1.989,36** (R$ 165,78/mês) |
| Profissional | 30 | R$ 258 | R$ 877 − 52% = **R$ 420,96** | R$ 4.842 − 49% = **R$ 2.469,42** (R$ 411,57/mês) | R$ 8.748 − 45% = **R$ 4.811,40** (R$ 400,95/mês) |
| Agência | 80 | R$ 681 | R$ 2.307 − 52% = **R$ 1.107,36** | R$ 12.702 − 49% = **R$ 6.478,02** (R$ 1.079,67/mês) | R$ 23.028 − 45% = **R$ 12.665,40** (R$ 1.055,45/mês) |

Buscas de ideias por mês: 8, 20 e 50. Os preços e cupons ficam em `src/planos.js` e em `planos.html` (painel); se mudar um cupom na Kiwify, mude nos dois.

Lucro sobre o custo:

| | Mensal | Semestral | Anual |
|---|---|---|---|
| Venda direta | ~47-49% | ~44-45% | ~41-42% |
| Venda por afiliado (13%) | ~26-28% | ~24% | ~21% |

## Comissão de afiliado

A comissão é escolhida por produto na Kiwify (um produto por plano, com os três ciclos), então vale o mesmo percentual para mensal, semestral e anual. Ela foi calculada para dar ao afiliado **metade do lucro no plano anual**, que tem a menor margem. Nos ciclos mensal e semestral o afiliado fica com um pouco menos da metade (44% a 48% do lucro), e nunca com mais.

Conta: comissão = (receita líquida − custo) ÷ 2 ÷ preço. No anual dá 13,2% a 13,4% nos três planos; arredondado para baixo, **13%**. A conta usa o valor pago, já com o cupom.

| Plano | Venda anual | Lucro da venda | Afiliado (13%) | Content Post | Parte do afiliado no lucro |
|---|---|---|---|---|---|
| Essencial | R$ 1.989,36 | R$ 531 | R$ 259 | R$ 273 | 49% |
| Profissional | R$ 4.811,40 | R$ 1.274 | R$ 625 | R$ 649 | 49% |
| Agência | R$ 12.665,40 | R$ 3.352 | R$ 1.647 | R$ 1.706 | 49% |

A conta supõe que a Kiwify calcula a comissão sobre o preço cheio. Se ela calcular sobre o valor já sem a taxa, o afiliado recebe cerca de 9% a menos que o mostrado e a Content Post fica com um pouco mais. Se o custo por post mudar, refaça a conta: a comissão para dividir o lucro ao meio é sempre perto de metade da margem líquida do plano anual.

Teste grátis: 7 dias, 3 posts e 2 buscas de ideias.

## Migração para Nasten (20/10/2026)

Novas compras usam a Nasten, mantendo os preços e cupons deste documento. As contas de margem acima usam a taxa histórica da Kiwify; não representam a taxa da Nasten. O painel financeiro usa o líquido efetivo retornado pela API Nasten. Veja [NASTEN.md](NASTEN.md) para configurar credenciais, webhook e ofertas.

## Produtos antigos na Kiwify

Crie 9 ofertas de assinatura (3 planos × mensal, semestral, anual) com os valores acima. Os nomes precisam conter o plano
(Essencial, Profissional ou Agência) e o ciclo (Mensal, Semestral ou Anual), ou preencha `KIWIFY_PRODUTOS`.
O painel abre o checkout com `?sck=<organização>&email=<e-mail>` para a compra cair na organização certa.
