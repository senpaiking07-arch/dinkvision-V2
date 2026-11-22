-- Historical projects can grant anon EXECUTE directly through default privileges.
-- These tenant predicates are used by authenticated RLS and server RPCs only.
revoke execute on function public.current_tenant_id(),public.is_super_admin(),
  public.is_tenant_admin(uuid),public.is_tenant_member(uuid) from anon;
