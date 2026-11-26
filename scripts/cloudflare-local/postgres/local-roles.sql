DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_system') THEN
    CREATE ROLE meltiply_system
      LOGIN
      PASSWORD 'meltiply-system-local'
      BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meltiply_rls') THEN
    CREATE ROLE meltiply_rls
      LOGIN
      PASSWORD 'meltiply-authenticated-local'
      NOBYPASSRLS;
  END IF;
END;
$$;
