# ZMART Lar+ PWA v5.3 — cadastro de venda e regra financeira completa

Esta versão preserva a base funcional da v5.1 e corrige somente pontos necessários para integridade, multivendas e manutenção segura.

## Correções estruturais

- **Multivendas isoladas:** cada venda possui seus próprios lançamentos, comprovantes, auditoria e configurações.
- **Edição da venda:** o comando do Dashboard abre a mesma edição usada na área Vendas.
- **Alteração de valor do imóvel:** em venda existente, pagamentos validados nunca são alterados; somente valores ainda pendentes são redistribuídos para manter o cronograma coerente com o novo valor contratado.
- **Nova venda:** permite informar quantidade de entradas, quantidade de parcelas e primeiro vencimento; não usa uma quantidade fixa escondida.
- **Distribuição monetária exata:** os centavos restantes são absorvidos pelo último lançamento para que a soma do cronograma corresponda exatamente ao valor configurado.
- **Backup completo:** exporta todas as vendas, não apenas a venda ativa, incluindo documentos binários vinculados e comprovantes aguardando conciliação.
- **Restauração:** aceita o formato multivendas e reativa corretamente a venda selecionada.
- **Exclusão de lançamento:** remove também os arquivos locais associados ao comprovante.
- **Migração:** dados da estrutura anterior continuam sendo normalizados para a estrutura multivendas.

## Regra de segurança financeira

Alterar o valor contratado não modifica pagamentos já validados. Se não houver lançamentos pendentes suficientes para representar o novo saldo, a alteração é bloqueada em vez de criar ou apagar valores silenciosamente.

## Comprovantes

PDF, JPG, PNG e WEBP continuam aceitos. O original permanece preservado no IndexedDB. O fluxo de leitura, conferência humana, validação, recibo ZMART e comprovante completo permanece o mesmo da versão anterior.

## OCR / internet

O OCR de documentos de imagem ainda depende do carregamento inicial dos módulos PDF.js/Tesseract.js por CDN nesta entrega. O restante da operação permanece local. O empacotamento desses módulos dentro da PWA continua sendo a única etapa externa para tornar o OCR totalmente independente de internet.

## Login de demonstração

- Vendedor / ADM: `vendedor` / `Zmart@123`
- Comprador: `comprador` / `Zmart@123`

Troque as credenciais antes de qualquer uso em produção.


## Cadastro completo da venda — v5.3

O cadastro da venda passa a ser a fonte das regras do cronograma financeiro:

- valor total do imóvel;
- valor total da entrada;
- quantidade de parcelas da entrada;
- quantidade total de parcelas do saldo;
- primeiro vencimento;
- dia limite de pagamento;
- taxa de juros por atraso e unidade da taxa (dia/mês);
- quantidade e valor previsto das parcelas por ano.

O cronograma anual precisa fechar exatamente com `valor do imóvel - entrada`. O sistema gera os lançamentos a partir dessas regras e preserva pagamentos já validados em alterações posteriores.

O cálculo de juros por atraso usado apenas como referência no sistema é juros simples, proporcional aos dias de atraso: taxa diária × dias ou taxa mensal × dias/30. O valor base da parcela não é alterado automaticamente pelo encargo.
