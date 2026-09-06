-- ZMART Lar+ — Schema Supabase
-- Rode este script inteiro no SQL Editor do seu projeto Supabase (Project > SQL Editor > New query).

-- 1) Tabela de vendas (uma linha por venda/contrato)
create table if not exists sales (
  id text primary key,                 -- mesmo id usado hoje no app (uid())
  property jsonb not null,             -- {title,total,entryTotal,description}
  schedule jsonb not null,             -- {parcelCount,firstDueDate,paymentDayLimit,entryDeadline,annualPlans,...}
  audit jsonb not null default '[]',
  settings jsonb not null default '{}',
  seller_password text not null default 'Zmart@123', -- senha de acesso do papel "vendedor" para esta venda
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) Tabela de lançamentos (parcelas + entrada), 1 linha por lançamento
create table if not exists installments (
  id text primary key,                 -- mesmo id usado hoje no app
  sale_id text not null references sales(id) on delete cascade,
  type text not null check (type in ('entrada','parcela')),
  number int not null default 0,
  label text not null,
  due_date date not null,
  value numeric not null default 0,
  status text not null default 'pending' check (status in ('pending','partial','paid')),
  received numeric not null default 0,
  paid_at date,
  note text default '',
  schedule_year int default 0,
  history jsonb not null default '[]', -- cada pagamento parcial: {id,amount,date,note,at,receiptBlobId,receiptName,lateDays,lateInterest}
  receipt jsonb,                       -- snapshot do comprovante mais recente (compatibilidade)
  paid_late boolean default false,
  late_days_on_payment int default 0,
  late_interest_charged numeric default 0,
  updated_at timestamptz not null default now()
);

create index if not exists idx_installments_sale on installments(sale_id);

-- 3) Bucket de armazenamento para os comprovantes (arquivos)
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- 4) Row Level Security — leitura/escrita liberadas para quem tem a chave anon do projeto
--    (mesmo nível de proteção que a senha de tela já usada hoje; não é autenticação forte).
alter table sales enable row level security;
alter table installments enable row level security;

create policy "sales_select" on sales for select using (true);
create policy "sales_insert" on sales for insert with check (true);
create policy "sales_update" on sales for update using (true);
create policy "sales_delete" on sales for delete using (true);

create policy "installments_select" on installments for select using (true);
create policy "installments_insert" on installments for insert with check (true);
create policy "installments_update" on installments for update using (true);
create policy "installments_delete" on installments for delete using (true);

-- 5) Política de acesso ao bucket de comprovantes (mesma lógica: liberado para quem tem a anon key)
create policy "receipts_select" on storage.objects for select using (bucket_id = 'receipts');
create policy "receipts_insert" on storage.objects for insert with check (bucket_id = 'receipts');
create policy "receipts_update" on storage.objects for update using (bucket_id = 'receipts');
create policy "receipts_delete" on storage.objects for delete using (bucket_id = 'receipts');
