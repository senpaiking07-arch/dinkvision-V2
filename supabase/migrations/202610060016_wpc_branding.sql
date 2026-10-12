-- Rebrand organization metadata without changing device identities or recordings.
alter table public.browser_devices drop constraint browser_devices_organization_check;
alter table public.browser_devices alter column organization set default 'Wrenlabs Pickleball Camera';
update public.browser_devices set organization = 'Wrenlabs Pickleball Camera' where organization = 'Casa Batik';
alter table public.browser_devices add constraint browser_devices_organization_check
  check (organization = 'Wrenlabs Pickleball Camera');
