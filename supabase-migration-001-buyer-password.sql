-- ZMART Lar+ — Migração: senha separada para o comprador
-- Rode isso se você JÁ executou o supabase-schema.sql antes (adiciona a coluna que faltava,
-- sem apagar nenhum dado existente).

alter table sales add column if not exists buyer_password text not null default 'Zmart@123';
