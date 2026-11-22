-- Read-only inspection. Run in Supabase SQL Editor and share the result.
-- Returns schema definitions only, not member records or invitation codes.
select jsonb_build_object(
  'functions', (
    select jsonb_agg(jsonb_build_object('name', p.proname,
      'definition', pg_get_functiondef(p.oid), 'privileges', p.proacl))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and left(p.proname, 4) = 'rfm_'
  ),
  'columns', (
    select jsonb_agg(to_jsonb(c)) from information_schema.columns c
    where c.table_schema = 'public'
  ),
  'policies', (
    select jsonb_agg(to_jsonb(p)) from pg_policies p
    where p.schemaname = 'public'
  ),
  'constraints', (
    select jsonb_agg(jsonb_build_object('table', c.conrelid::regclass::text,
      'name', c.conname, 'definition', pg_get_constraintdef(c.oid)))
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public'
  ),
  'triggers', (
    select jsonb_agg(jsonb_build_object('table', t.tgrelid::regclass::text,
      'definition', pg_get_triggerdef(t.oid)))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
  )
) as log_schema_review;
