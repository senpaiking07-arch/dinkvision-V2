-- Allow R2 multipart attempts to record the actual part size used by the client.
-- Existing attempts keep their original part_size; new attempts may use 8/16/32 MiB.
alter table public.r2_upload_attempts
  drop constraint if exists r2_upload_attempts_part_size_check;
alter table public.r2_upload_attempts
  add constraint r2_upload_attempts_part_size_check
  check(part_size in (8388608,16777216,33554432));
alter table public.r2_upload_attempts
  alter column part_size set default 16777216;
