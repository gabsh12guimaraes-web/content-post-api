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

| Plano | Posts/mês | Buscas de ideias/mês | Custo/mês | Mensal | Semestral (por mês) | Anual (por mês) |
|---|---|---|---|---|---|---|
| Essencial | 12 | 8 | R$ 106 | R$ 177 | R$ 169 (R$ 1.014) | R$ 164 (R$ 1.968) |
| Profissional | 30 | 20 | R$ 258 | R$ 417 | R$ 407 (R$ 2.442) | R$ 399 (R$ 4.788) |
| Agência | 80 | 50 | R$ 681 | R$ 1.097 | R$ 1.067 (R$ 6.402) | R$ 1.049 (R$ 12.588) |

Lucro sobre o custo:

| | Mensal | Semestral | Anual |
|---|---|---|---|
| Venda direta | ~46-49% | ~43-44% | ~40% |
| Venda por afiliado (13%) | ~25-27% | ~22-24% | ~20% |

## Comissão de afiliado

A comissão é escolhida por produto na Kiwify (um produto por plano, com os três ciclos), então vale o mesmo percentual para mensal, semestral e anual. Ela foi calculada para dar ao afiliado **metade do lucro no plano anual**, que tem a menor margem. Nos ciclos mensal e semestral o afiliado fica com um pouco menos da metade (44% a 48% do lucro), e nunca com mais.

Conta: comissão = (receita líquida − custo) ÷ 2 ÷ preço. No anual dá 13,0% a 13,1% nos três planos; arredondado para baixo, **13%**.

| Plano | Venda anual | Lucro da venda | Afiliado (13%) | Content Post | Parte do afiliado no lucro |
|---|---|---|---|---|---|
| Essencial | R$ 1.968 | R$ 512 | R$ 256 | R$ 256 | 50% |
| Profissional | R$ 4.788 | R$ 1.253 | R$ 622 | R$ 631 | 50% |
| Agência | R$ 12.588 | R$ 3.282 | R$ 1.636 | R$ 1.645 | 50% |

A conta supõe que a Kiwify calcula a comissão sobre o preço cheio. Se ela calcular sobre o valor já sem a taxa, o afiliado recebe cerca de 9% a menos que o mostrado e a Content Post fica com um pouco mais. Se o custo por post mudar, refaça a conta: a comissão para dividir o lucro ao meio é sempre perto de metade da margem líquida do plano anual.

Teste grátis: 7 dias, 3 posts e 2 buscas de ideias.

## Produtos na Kiwify

Crie 9 ofertas de assinatura (3 planos × mensal, semestral, anual) com os valores acima. Os nomes precisam conter o plano
(Essencial, Profissional ou Agência) e o ciclo (Mensal, Semestral ou Anual), ou preencha `KIWIFY_PRODUTOS`.
O painel abre o checkout com `?sck=<organização>&email=<e-mail>` para a compra cair na organização certa.
