alter table public.recorder_diagnostics
  drop constraint recorder_diagnostics_stage_check,
  add constraint recorder_diagnostics_stage_check check(stage in
    ('work_queue','release_check','reconcile','reserve','camera_prepare','camera_connect',
     'microphone_prepare','encoder_prepare','countdown','capture','finalize','validate',
     'saved_report','branding','transfer','verify','queue_wait','cleanup','complete')),
  add column http_status integer check(http_status between 100 and 599),
  add column acknowledged_bytes bigint check(acknowledged_bytes between 0 and 1000000000000),
  add column transferred_bytes bigint check(transferred_bytes between 0 and 1000000000000),
  add column retry_delay_ms bigint check(retry_delay_ms between 0 and 604800000);
