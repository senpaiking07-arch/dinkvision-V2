alter table public.recorder_diagnostics
  drop constraint recorder_diagnostics_stage_check,
  add constraint recorder_diagnostics_stage_check check(stage in
    ('work_queue','release_check','reconcile','reserve','camera_prepare','camera_connect',
     'microphone_prepare','encoder_prepare','countdown','capture','finalize','validate',
     'saved_report','branding','transfer','verify','queue_wait','cleanup','complete',
     'start_tap','start_accepted','stop_requested','start_repeated','stop_repeated')),
  add column action_source text check(action_source in ('player','notification','admin')),
  add column repeated_actions integer check(repeated_actions between 1 and 1000);
