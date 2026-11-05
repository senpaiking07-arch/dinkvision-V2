-- Null means an older device did not report measurable logo progress.
alter table public.browser_recordings
  add column if not exists branding_progress smallint
  check (branding_progress is null or branding_progress between 0 and 100);
