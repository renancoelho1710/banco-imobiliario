# Banco Imobiliário Pay — melhorias aplicadas

Esta versão trata o app como uma **conta digital da partida**, sem movimentar dinheiro real.

## Experiência bancária
- Nova identidade **Banco Imobiliário Pay**.
- Visual migrado do roxo para uma paleta verde/financeira.
- Jogador vê **Conta da partida**.
- Bancário vê **Painel do Banco / Caixa do Banco: ∞**.
- Aviso visível de que é um ambiente de jogo.
- Pix e transferência com linguagem mais próxima de um app bancário.
- Comprovante após pagamento com valor, origem, destino, data e ID.

## Banco com caixa infinito
- O operador bancário e a instituição Banco deixam de ser conceitualmente a mesma conta.
- Pagamentos feitos pelo bancário saem do pseudo-player `BANK`.
- Recebimentos institucionais entram no `BANK`.
- O caixa do Banco não diminui nem aumenta: continua infinito.

## Segurança das transações do jogo
- Cada QR/Pix recebe um `paymentId` único.
- Um mesmo QR não pode ser pago duas vezes.
- Parcelas já pagas são rejeitadas antes de descontar saldo.
- Compras entre jogadores são validadas antes de movimentar dinheiro.
- Contas falidas/desistentes não podem continuar transacionando.

## Parcelamento
- Parcelas agora fecham exatamente o valor total.
- Não existe mais o risco de `Math.ceil` cobrar R$ 1 a mais no somatório.
- A propriedade continua sendo transferida somente após a quitação e confirmação do Banco.

## Aluguel
- Corrigido o fluxo que chamava “Cobrar aluguel por transação” mas abria uma transferência de saída.
- Agora a ação cria uma **cobrança Pix** para o aluguel.

## Falência e desistência
Ao liquidar um jogador:
- saldo vai a zero e é registrado como devolvido ao Banco;
- propriedades voltam ao `BANK`;
- casas, hotel e hipoteca dessas propriedades são zerados;
- vendas pendentes do jogador são canceladas;
- transferências de propriedade pendentes são canceladas;
- a conta fica encerrada e as ações financeiras são bloqueadas.

## Compra e venda pelo Banco
- O Banco continua vendendo propriedades à vista ou parceladas.
- Foi adicionada a opção **RECOMPRAR** para propriedades que estão com jogadores.
- A recompra paga o valor de venda ao jogador e devolve o imóvel ao Banco.

## Validação
Foi executada uma checagem sintática do TypeScript/TSX com o compilador TypeScript global.
O ambiente desta sessão não conseguiu concluir a instalação completa das dependências do projeto, então o `next build` completo deve ser executado localmente antes do deploy:

```bash
npm install
npm run build
```
