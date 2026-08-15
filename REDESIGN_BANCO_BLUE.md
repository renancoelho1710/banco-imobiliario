# Banco Imobiliário Pay — Redesign Banco Blue

Esta versão redesenha a experiência visual para parecer um aplicativo financeiro premium, mantendo as regras e fluxos da partida.

## O que mudou
- Identidade visual azul-marinho + azul institucional em todo o app.
- Login com aparência de aplicativo bancário/PWA premium.
- Home com cabeçalho institucional e conta em destaque.
- Saldo com hierarquia visual maior e atalhos financeiros organizados.
- Botões, inputs, filtros e estados redesenhados e padronizados.
- Cards de propriedades reduzidos: agora se comportam como ativos/portfólio, não pôsteres gigantes.
- Extrato com visual de atividade bancária.
- Pendências mais leves, compactas e fáceis de ler.
- Modais menores, com fundo branco e texto escuro garantido.
- QR Code limitado visualmente e payload oculto; usuário usa botão de copiar quando disponível.
- Paleta antiga verde/roxa de UI removida; cores do tabuleiro continuam preservadas.
- Melhorias responsivas para celular.

## Antes de publicar
1. Preserve seu `.env.local` na pasta local.
2. Execute `npm install` (se necessário).
3. Execute `npm run build`.
4. Teste Pix, transferência, aluguel, compra, construção e pendências no celular.
5. Faça commit e push para a branch `main`.
