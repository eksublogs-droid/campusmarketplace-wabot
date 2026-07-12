-- ============================================================
-- CampusMarketplace WhatsApp Bot — Supabase schema
-- Run this once in Supabase Dashboard > SQL Editor > New query
-- ============================================================

create extension if not exists "pgcrypto";

-- ===== Users =====
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  whatsapp_id text unique not null,   -- e.g. "2348012345678@s.whatsapp.net"
  phone text not null,                -- plain digits, e.g. "2348012345678"
  name text default '',
  email text default '',
  email_submitted boolean default false,
  registered_at timestamptz default now(),
  last_seen timestamptz default now()
);

-- ===== Products =====
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  media jsonb default '[]',           -- [{ "url": "...", "type": "photo" }]
  description text default '',
  category text default '',
  subcategory text default '',
  brand text default '',
  condition text default '',
  selling_price numeric default 0,
  negotiable boolean default false,
  lowest_price numeric default 0,
  used_duration text default '',
  has_defects boolean default false,
  defects_details text default '',
  reason_for_selling text default '',
  state text default '',
  city text default '',
  door_dropoff boolean default false,
  door_pickup boolean default false,
  seller_whatsapp text default '',
  posted_by text default 'user',           -- 'user' | 'admin'
  is_premium boolean default false,
  premium_expires_at timestamptz,
  status text default 'pending',           -- 'pending' | 'active' | 'rejected' | 'sold'
  sold_at timestamptz,
  created_at timestamptz default now()
);

-- ===== Settings (single row) =====
create table if not exists settings (
  id uuid primary key default gen_random_uuid(),
  pro_price_per_day numeric default 1000,
  bank_accounts jsonb default '[]',   -- [{ "bankName":"", "accountNumber":"", "accountName":"" }]
  updated_at timestamptz default now()
);
insert into settings (pro_price_per_day, bank_accounts)
  select 1000, '[]'::jsonb
  where not exists (select 1 from settings);

-- ===== Payment receipts (manual bank transfer review) =====
create table if not exists payment_receipts (
  id uuid primary key default gen_random_uuid(),
  user_whatsapp_id text not null,
  product_id uuid references products(id),
  days integer default 0,
  amount numeric default 0,
  receipt_url text default '',        -- Supabase Storage public URL of the screenshot
  status text default 'pending',      -- 'pending' | 'approved' | 'rejected'
  reject_reason text default '',
  created_at timestamptz default now()
);

-- ===== Baileys auth/session state (keeps WhatsApp linked across redeploys) =====
create table if not exists auth_state (
  key text primary key,
  value jsonb
);

-- Helpful indexes
create index if not exists idx_products_status on products(status);
create index if not exists idx_products_seller on products(seller_whatsapp);
create index if not exists idx_receipts_status on payment_receipts(status);

-- ============================================================
-- Storage buckets — create these in Dashboard > Storage (or via SQL below)
-- 1) "product-media"    — public bucket, for listing photos/videos
-- 2) "payment-receipts" — public bucket, for bank transfer screenshots
-- ============================================================
insert into storage.buckets (id, name, public)
  values ('product-media', 'product-media', true)
  on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
  values ('payment-receipts', 'payment-receipts', true)
  on conflict (id) do nothing;
