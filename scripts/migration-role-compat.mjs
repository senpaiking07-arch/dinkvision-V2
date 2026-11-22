// PostgreSQL requires CREATE on the containing schema when transferring a
// function to a new owner. Supabase's postgres role is not a full superuser.
// Grant this only inside the migration transaction and restore the prior state.
const grant = `do $migration_owner$ begin
  if exists(select 1 from pg_roles where rolname='dinkvision_executor') then
    if not has_schema_privilege('dinkvision_executor','public','CREATE') then
      grant create on schema public to dinkvision_executor;
      perform set_config('dinkvision.migration_granted_create','true',true);
    end if;
  end if;
end $migration_owner$;`;

export function migrationSQL(sql) {
  const create = "create role dinkvision_executor nologin nosuperuser nobypassrls;";
  return `select set_config('dinkvision.migration_granted_create','false',true);\n${grant}\n` +
    sql.replace(create, `${create}\n${grant}`) + `\ndo $migration_owner$ begin
      if current_setting('dinkvision.migration_granted_create',true)='true' then
        revoke create on schema public from dinkvision_executor;
      end if;
    end $migration_owner$;`;
}
