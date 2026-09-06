# ZMART Lar+ — Changelog v5.3

## v5.4 — Pagamento parcial e excedente encadeado

- Novo status **"parcial"** para entrada e parcelas: cada lançamento agora acumula um saldo real
  recebido (`received`) e o status (pendente / parcial / pago) é sempre derivado dele — nunca mais
  um recebimento parcial marca o lançamento como totalmente pago.
- Todo recebimento passa pela mesma função central (`applyPayment`), que soma ao que já havia sido
  recebido e mantém histórico de cada movimentação.
- **Regra do excedente, agora encadeada, ao validar o comprovante de uma prestação:**
  1. O valor da prestação é registrado normalmente pelo saldo devido daquele mês.
  2. Enquanto a entrada não estiver quitada, o excedente é oferecido primeiro para abatê-la — de
     forma parcial e acumulativa (ex.: R$ 3.000 abatem de um saldo de R$ 10.000 → entrada fica
     "parcial" com saldo R$ 7.000). O que sobrar depois de cobrir a entrada segue automaticamente
     para o próximo passo.
  3. Só depois da entrada quitada, qualquer excedente vira **multa** (se o pagamento está em
     atraso) ou **amortização de prestação futura** — o sistema pergunta qual prestação, sugerindo
     da última para a primeira, para reduzir juros (Cláusula 6ª), e continua nas anteriores se
     sobrar valor. Tudo sempre com confirmação explícita antes de qualquer movimentação.
- Corrigido bug em que a tela de excedente e a conciliação de comprovantes soltos (`openReceiptInbox`)
  estavam acidentalmente fundidas numa única função; agora são funções independentes.
- Kanban, cartões de pagamento e o formulário de validação exibem o saldo real de itens parciais
  ("recebido X de Y · falta Z").
- Edição manual de um lançamento (`editar`) e o recálculo anual do cronograma agora preservam o
  valor já recebido em vez de zerá-lo.

## v5.3 — Cadastro de venda como regra financeira

- Cadastro de venda passa a definir toda a regra do cronograma.
- Entrada pode ser parcelada com quantidade definida.
- Quantidade total de parcelas definida pelo vendedor.
- Dia limite de pagamento configurável.
- Juros por atraso configuráveis em taxa diária ou mensal.
- Cronograma anual com quantidade e valor previsto por ano.
- Validação matemática impede cronograma que não feche com o saldo das parcelas.
- Geração de parcelas respeita valores anuais e dia limite, ajustando meses sem o dia informado para o último dia do mês.
- Alterações preservam pagamentos validados e bloqueiam alteração de regras quando há comprovante pendente que poderia ser afetado.
- Relatórios passaram a registrar as regras da venda e o cronograma anual.
- Service Worker atualizado para evitar cache antigo.
- Recursos existentes de multivendas, comprovantes, OCR, backup, restauração, relatórios e Google Drive foram preservados.
