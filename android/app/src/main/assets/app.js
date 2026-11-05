const $ = id => document.getElementById(id);
let view = 'welcome', state = {}, emails = [], formError = '', enrollmentPrompted = false, lastTestToken = '';
let recordingClock = null, timerAnimation = 0;
let savedSelection = '', lastSavedToken = '';
let startRequested = false, startAccepted = false;
let lastErrorNotice = '', errorNoticeExpiresAt = 0;
let lastStatusNotice = '', statusNoticeExpiresAt = 0;
const native = window.CasaNative;
const call = (action, value = '') => {
  if ((state.updateRequired || state.updateChecking) && !['check-update', 'install-update', 'stop', 'retry-connection'].includes(action)) return;
  if (native) native.action(action, value);
  else {
    $('error').hidden = false;
    $('error-message').textContent = 'Design preview only. Install the APK to record.';
  }
};
const hideModal = () => {
  $('modal').hidden = true;
  delete $('modal').dataset.kind;
  $('modal-content').replaceChildren();
  $('modal-actions').replaceChildren();
  $('modal-error').hidden = true;
};
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
function modalButton(label, action, primary = false) {
  const button = node('button', primary ? 'primary' : 'quiet', label);
  button.type = 'button';
  button.onclick = action;
  $('modal-actions').append(button);
  return button;
}
function recordingModeOptions(select) {
  const modes = state.recordingModes || [];
  const signature = JSON.stringify(modes);
  const selected = state.selectedRecordingMode || 'auto';
  if (select.dataset.modes === signature && select.dataset.nativeMode === selected) return;
  const current = select.dataset.nativeMode !== selected || select.options.length <= 1 ? selected : (select.value || selected);
  select.replaceChildren(new Option('Auto · best supported quality', 'auto'));
  for (const mode of modes) {
    const option = new Option(`${mode.width} × ${mode.height} · ${mode.fps} fps${mode.supported ? '' : ' · unavailable on this device'}`, mode.key);
    option.disabled = !mode.supported;
    select.append(option);
  }
  select.value = [...select.options].some(o => o.value === current && !o.disabled) ? current : 'auto';
  select.dataset.modes = signature;
  select.dataset.nativeMode = selected;
}
function showNativeModal(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return; }
  const modal = $('modal'), content = $('modal-content'), actions = $('modal-actions');
  modal.dataset.kind = data.kind;
  modal.classList.toggle('saved-error', ['saved-video-error','remove-saved-video'].includes(data.kind));
  content.replaceChildren(); actions.replaceChildren();
  $('modal-error').hidden = true;
  $('modal-kicker').hidden = false;
  $('modal-copy').hidden = false;
  $('modal-title').textContent = '';
  const field = (labelText, name, value = '', options = {}) => {
    const label = node('label', `modal-field${options.wide ? ' wide' : ''}`, labelText);
    const input = node('input');
    input.name = name;
    input.type = options.secret ? 'password' : (options.email ? 'email' : 'text');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = options.max || 254;
    input.value = value || '';
    input.placeholder = options.placeholder || '';
    if (options.inputmode) input.inputMode = options.inputmode;
    label.append(input);
    content.append(label);
    return input;
  };
  const title = (kicker, heading, copy) => {
    $('modal-kicker').textContent = kicker;
    $('modal-title').textContent = heading;
    $('modal-copy').textContent = copy || '';
    $('modal-copy').hidden = !copy;
  };
  const cancel = label => modalButton(label || 'Cancel', hideModal);

  if (data.kind === 'saved-video-error') {
    title('SAVED VIDEO', 'Recording details', String(data.error || 'No detailed error was recorded.').slice(0, 300));
    if (data.id) modalButton('Save another copy', () => { hideModal(); call('save-local-video', data.id); });
    modalButton('Close', hideModal, true);
  } else if (data.kind === 'remove-saved-video') {
    title('SAVED VIDEO', 'Remove the app copy?', 'This removes only the copy inside DinkVision. Your exported Gallery / Files copy and any Google Drive copy stay in place. This app cannot retry an upload after its copy is removed.');
    modalButton('Remove app copy', () => { hideModal(); $('saved-player').pause(); $('saved-player').removeAttribute('src'); lastSavedToken=''; call('remove-local-video', data.id); }, true);
    cancel('Keep app copy');
  } else if (data.kind === 'enrollment') {
    title('DEVICE SETUP', data.replace ? 'Register this Android Device' : 'Register this Android Device',
      data.replace ? 'Enter the new enrollment code created in Admin / Devices & cameras.' : 'Enter the enrollment code from Admin / Devices & cameras before using this recorder.');
    const code = field('ENROLLMENT CODE', 'code', '', {max: 120, placeholder: 'Enter code', wide: true});
    modalButton(data.replace ? 'Re-register device' : 'Register device', () => {
      const value = code.value.trim();
      if (!value) { $('modal-error').textContent = 'Enter the enrollment code to continue.'; $('modal-error').hidden = false; code.focus(); return; }
      hideModal(); call('enroll', JSON.stringify({code: value, replace: !!data.replace}));
    }, true);
    cancel();
  } else if (data.kind === 'saved-enrollment') {
    const inactive = state.registrationInactive;
    title('DEVICE SETUP', inactive ? 'Registration needs attention' : 'Enrollment saved', inactive
      ? 'Admin reports this registration is inactive or unrecognized. Ask Admin to check this device. Its saved videos have not been deleted. Re-register only when Admin intentionally replaces the registration.'
      : 'Enrollment is saved on this device. The server could not be reached to verify its assignment. Reconnect to the internet and check again; a new enrollment code is not needed for a connection outage.');
    modalButton('Check again', () => { hideModal(); call('refresh'); }, true);
    modalButton('Re-register', () => { hideModal(); call('setup-reenroll'); });
    cancel('Close');
  } else if (data.kind === 'session-recovery') {
    title('RECORDING RECOVERY', 'Previous recording needs attention',
      'This app is not recording, but the server has not closed the previous session. Keep this device connected and check again. If it stays unfinished, ask Admin to review it before starting another match.');
    modalButton('Check again', () => { hideModal(); call('refresh'); }, true);
    if (state.savedVideos?.some(item => item.id === data.id))
      modalButton('Open saved video', () => { hideModal(); savedSelection = data.id; show('saved-videos'); renderSavedVideos(); });
    cancel('Close');
  } else if (data.kind === 'camera-ready' || data.kind === 'camera-ready-device') {
    title('CAMERA SETUP', 'USB / built-in camera',
      'The tablet uses an attached compatible USB camera such as EMEET when available, otherwise its rear camera.');
    const qualityLabel = node('label', 'modal-field wide', 'VIDEO QUALITY');
    const quality = node('select'); quality.value = state.selectedRecordingMode || 'auto';
    recordingModeOptions(quality); quality.value = state.selectedRecordingMode || 'auto';
    qualityLabel.append(quality); content.append(qualityLabel);
    modalButton('Record a 3-second test', () => { const mode = quality.value; hideModal(); call('sync-camera', mode); }, true);
    modalButton('Reconnect camera', () => { hideModal(); call('choose-device'); });
    cancel('Close');
  } else if (data.kind === 'permission') {
    title('CAMERA PERMISSION', 'Camera access is needed', 'Allow camera and microphone access in Android settings, then return here and use the start circle to run the camera test again.');
    cancel('Close');
  } else if (data.kind === 'recover-recording') {
    title('SAVED VIDEO', data.partial ? 'Recover partial footage?' : 'Retry this saved video?',
      data.partial
        ? 'The camera stopped before the match ended. The saved file may be incomplete, so it will be checked first. Clips shorter than one minute stay on this device and are not emailed.'
        : 'The video is still on this device. Retry the upload; the local copy is removed only after the server confirms it.');
    modalButton(data.partial ? 'Check saved video' : 'Retry upload', () => { hideModal(); call('recover-failed'); }, true);
    cancel('Keep video');
  } else if (data.kind === 'discard') {
    title('SAVED RECORDING', 'Discard this video?', 'This permanently deletes the unsent video from this tablet. Recover it first if you want to keep it.');
    modalButton('Delete video', () => { hideModal(); call('discard-confirmed'); }, true);
    cancel('Keep video');
  } else if (data.kind === 'leave') {
    title('RECORDING IN PROGRESS', 'Leave the recorder?', 'Recording or upload will continue in the background.');
    modalButton('Leave app', () => { hideModal(); call('leave-confirmed'); }, true);
    cancel('Stay');
  } else return;
  modal.hidden = false;
}
window.showNativeModal = showNativeModal;
window.dismissNativeModal = () => {
  if ($('modal').hidden) return false;
  hideModal();
  return true;
};
window.setNativeModalError = message => {
  $('modal-error').textContent = String(message || 'Please check the entered values.');
  $('modal-error').hidden = false;
};
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('modal').hidden) { hideModal(); event.preventDefault(); }
});
const isTextInput = target => target instanceof Element && !!target.closest('input, textarea');
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && isTextInput(event.target) && !$('modal').hidden) {
    event.preventDefault(); event.target.blur();
  }
});
document.addEventListener('selectstart', event => { if (!isTextInput(event.target)) event.preventDefault(); });
document.addEventListener('contextmenu', event => { if (!isTextInput(event.target)) event.preventDefault(); });
const keepModalAnchored = () => {
  if (!$('modal').hidden && (window.scrollX !== 0 || window.scrollY !== 0)) window.scrollTo(0, 0);
};
window.addEventListener('scroll', keepModalAnchored, {passive: true});
window.visualViewport?.addEventListener('scroll', keepModalAnchored, {passive: true});
document.addEventListener('focusin', () => {
  keepModalAnchored();
  requestAnimationFrame(keepModalAnchored);
  setTimeout(keepModalAnchored, 100);
  setTimeout(keepModalAnchored, 300);
});
function show(name) {
  if (view === 'saved-videos' && name !== view) {
    $('saved-player').pause(); $('saved-player').removeAttribute('src'); $('saved-player').load();
    lastSavedToken = '';
  }
  view = name;
  document.body.classList.toggle('flow-view', name !== 'welcome');
  document.body.classList.toggle('saved-view', name === 'saved-videos');
  if (name === 'saved-videos') {
    $('notice').hidden = true;
    $('error').hidden = true;
  }
  for (const section of ['welcome', 'form', 'confirm', 'session', 'camera-test', 'saved-videos'])
    $(section).hidden = section !== name;
  syncReenrollVisibility();
}
const syncReenrollVisibility = () => {
  $('reenroll').hidden = view !== 'welcome' || !state.enrolled || !!state.busy;
  $('saved-open').hidden = view !== 'welcome' || !!state.busy ||
    !(state.enrolled || state.savedVideos?.length);
  $('saved-open').textContent = state.savedVideos?.length ? `Saved videos (${state.savedVideos.length})` : 'Saved videos';
  document.body.classList.toggle('has-tools', !$('reenroll').hidden || !$('saved-open').hidden);
};
const beginFromWelcome = () => {
  if (state.busy || state.testReady) return;
  if (unfinishedSession() && (!emails.length || state.recoverable || state.savedVideos?.some(item => item.id === state.session.id))) {
    showNativeModal({kind: 'session-recovery', id: state.session.id});
    return;
  }
  if (!state.enabled || !state.tested || !state.cameraMode) {
    call('setup');
    return;
  }
  show('form');
};
$('welcome').addEventListener('click', event => {
  if ($('modal').hidden && !event.composedPath().includes($('modal'))) beginFromWelcome();
});
document.addEventListener('click', event => {
  if (view === 'welcome' && !state.busy && $('modal').hidden &&
      !event.composedPath().includes($('welcome')) &&
      !event.target.closest('button,a,input,video,#modal,.device-tools,#error,#connection-notice')) beginFromWelcome();
});
function handlePlayerBack() {
  if (!$('modal').hidden) { hideModal(); return true; }
  if (view === 'confirm') { show('form'); return true; }
  if (view === 'saved-videos') { show('welcome'); return true; }
  if (view === 'form') {
    $('player-email').blur();
    clearRecipientDraft();
    show('welcome');
    return true;
  }
  return false;
}
window.handlePlayerBack = handlePlayerBack;
$('back').addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  handlePlayerBack();
});
$('reenroll').addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  call('setup-reenroll');
});
$('saved-open').onclick = event => { event.stopPropagation(); show('saved-videos'); renderSavedVideos(); };
$('saved-back').onclick = () => handlePlayerBack();
$('recover').addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  if (state.recoverable && !state.busy) { show('saved-videos'); renderSavedVideos(); }
});

function savedItems() {
  return [...(state.savedVideos || [])].sort((a, b) =>
    Number(b.status === 'failed') - Number(a.status === 'failed') || b.createdAt - a.createdAt);
}
function moveSavedVideo(direction) {
  const items = savedItems(), position = items.findIndex(item => item.id === savedSelection);
  savedSelection = items[Math.max(0, Math.min(items.length - 1, position + direction))]?.id || '';
  renderSavedVideos();
}
$('saved-previous').onclick = () => moveSavedVideo(-1);
$('saved-next').onclick = () => moveSavedVideo(1);
$('saved-save').onclick = () => {
  const item=savedItems().find(row=>row.id===savedSelection);
  if (item?.exported) showNativeModal({kind:'remove-saved-video',id:savedSelection});
  else call('save-local-video', savedSelection);
};
$('saved-retry').onclick = () => call('retry-upload', savedSelection);
$('saved-details').onclick = () => {
  const item = savedItems().find(row => row.id === savedSelection);
  showNativeModal({kind: 'saved-video-error', id:item?.id, error: `Recording ID: ${item?.id || ''}\n${item?.lastError || 'No error reported.'}`});
};
$('saved-player').onerror = () => { if (view === 'saved-videos') $('saved-preview-warning').hidden = false; };
function renderSavedVideos() {
  if (view !== 'saved-videos') return;
  const items = savedItems();
  let position = items.findIndex(item => item.id === savedSelection);
  if (position < 0) position = 0;
  const item = items[position];
  $('saved-empty').hidden = !!item;
  $('saved-empty').textContent = !state.localDeviceKnown && state.enrolled
    ? 'Connect once to verify this enrollment before viewing saved videos. The originals remain in the app.'
    : 'No videos are saved inside this app. Completed uploads may already be on Google Drive.';
  $('saved-panel').hidden = !item;
  if (!item) {
    savedSelection = ''; lastSavedToken = '';
    $('saved-player').pause(); $('saved-player').removeAttribute('src');
    return;
  }
  savedSelection = item.id;
  const date = item.createdAt ? new Date(item.createdAt).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
  const recipients = Array.isArray(item.recipients) ? item.recipients : [];
  const first = recipients[0] || 'Players not recorded';
  const compact = first.length > 36 ? `${first.slice(0, 21)}…${first.slice(-12)}` : first;
  $('saved-video-name').textContent = `${date || 'Date unavailable'} · ${compact}${recipients.length > 1 ? ` +${recipients.length - 1} more` : ''}`;
  $('saved-video-name').title = recipients.join(', ');
  const duration = item.durationMs ? `${Math.round(item.durationMs / 1000)} seconds` : 'Duration not verified';
  $('saved-video-meta').textContent = `${date ? date + ' · ' : ''}${duration} · ${(Number(item.bytes || 0) / 1048576).toFixed(1)} MB`;
  const waiting = item.brandingState === 'complete' ? 'Waiting to upload' : 'Waiting to add logo';
  const statuses = {pending: waiting, saved_locally: waiting, retrying: `${item.brandingState === 'failed' ? 'Logo processing' : 'Upload'} retry scheduled · ${item.retryCount || 0}/8 attempts`, uploading: `Uploading ${item.progress || 0}%`, local_only: 'Local only · under one minute'};
  $('saved-video-status').textContent = item.status === 'failed'
    ? item.validationFailed ? 'Video needs inspection. Save the original for review.'
      : item.brandingState === 'failed' ? 'Logo processing failed. The original is still saved.'
        : `Upload paused · ${item.retryCount || 0} failed attempts. You can retry.`
    : item.brandingState === 'processing' ? 'Adding the DinkVision logo' : statuses[item.status] || 'Saved in this app';
  $('saved-details').hidden = false;
  $('saved-retry').hidden = !['failed','retrying'].includes(item.status);
  $('saved-retry').textContent = item.status === 'retrying' ? 'Retry now' : item.validationFailed || item.brandingState === 'failed' ? 'Retry processing' : 'Retry upload';
  $('saved-retry').disabled = !!state.busy;
  $('saved-save').disabled = !!state.exportingSession || (item.exported && !item.canRemove);
  $('saved-save').textContent = state.exportingSession === item.id ? `Saving · ${state.exportPercent || 0}%`
    : item.exported ? 'Remove from app' : 'Save to device';
  $('saved-save').classList.toggle('remove-copy',!!item.exported);
  const result = state.localVideoSession === item.id ? state.localVideoError || state.localVideoMessage || '' : '';
  $('saved-action-result').textContent = [result, item.exportReportPending ? 'Device copy saved. Admin confirmation is waiting for a connection.' : '', item.exported && !item.canRemove && !state.exportingSession ? 'Finish active work before removing. If the exported copy was moved or deleted, use Details to save another copy.' : ''].filter(Boolean).join(' ');
  $('saved-action-result').classList.toggle('failed', !!state.localVideoError && state.localVideoSession === item.id);
  $('saved-previous').disabled = position === 0;
  $('saved-next').disabled = position >= items.length - 1;
  $('saved-position').textContent = `${position + 1} of ${items.length}`;
  const processing = item.brandingState === 'processing';
  const brandingPercent = Number.isInteger(item.brandingProgress) && item.brandingProgress >= 0 ? Math.min(99, item.brandingProgress) : null;
  $('saved-processing-label').textContent = brandingPercent === null ? 'Adding logo…'
    : brandingPercent >= 99 ? 'Checking saved video · 99%' : `Adding logo · ${brandingPercent}%`;
  if (brandingPercent === null) $('saved-processing-progress').removeAttribute('value');
  else $('saved-processing-progress').value = brandingPercent;
  if (processing && brandingPercent !== null) $('saved-video-status').textContent = $('saved-processing-label').textContent;
  $('saved-processing').hidden = !processing;
  $('saved-player').hidden = processing;
  if (processing) {
    lastSavedToken = '';
    $('saved-preview-warning').hidden = true;
    const preview = $('saved-player');
    if (preview.hasAttribute('src')) { preview.pause(); preview.removeAttribute('src'); preview.load(); }
  } else if (lastSavedToken !== `${item.id}:${item.brandingState}:${item.bytes}`) {
    lastSavedToken = `${item.id}:${item.brandingState}:${item.bytes}`;
    $('saved-preview-warning').hidden = true;
    const preview = $('saved-player');
    preview.pause();
    preview.src = `https://appassets.androidplatform.net/saved-video/${encodeURIComponent(item.id)}.mp4?v=${encodeURIComponent(lastSavedToken)}`;
    preview.load();
  }
}
$('edit').onclick = () => show('form');
function renderEmails() {
  $('email-count').textContent = `Registered emails (${emails.length}/4) · At least 1 is required.`;
  $('add-email').disabled = emails.length >= 4 || !$('player-email').value.trim();
  $('email-list').replaceChildren(...emails.map(address => {
    const chip = node('div');
    const label = node('span', '', address);
    const remove = node('button', '', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${address}`);
    remove.onclick = () => { emails = emails.filter(value => value !== address); formError = ''; renderEmails(); };
    chip.append(label, remove);
    return chip;
  }));
}
function clearRecipientDraft() {
  emails = [];
  $('player-email').value = '';
  formError = '';
  renderEmails();
}
function unfinishedSession() {
  return !state.busy && !state.previousCaptureReleased && state.session && ['requested', 'starting', 'recording', 'finalizing'].includes(state.session.status);
}
function addEmail() {
  const value = $('player-email').value.trim().toLowerCase();
  if (emails.length >= 4) formError = 'You can add a maximum of 4 Gmail accounts.';
  else if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)) formError = 'Enter a valid Gmail address.';
  else if (emails.includes(value)) formError = 'That Gmail address is already added.';
  else {
    emails.push(value); $('player-email').value = ''; formError = ''; $('error').hidden = true; renderEmails(); return true;
  }
  $('error').hidden = false; $('error-message').textContent = formError;
  return false;
}
$('player-email').oninput = () => { formError = ''; renderEmails(); };
$('player-email').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addEmail(); } };
$('add-email').onclick = addEmail;
$('email-form').onsubmit = event => {
  event.preventDefault();
  if (!state.enabled || !state.tested || !state.cameraMode || state.busy) { show('welcome'); call('setup'); return; }
  if ($('player-email').value.trim() && !addEmail()) return;
  if (!emails.length) { formError = 'Add at least one valid Gmail address.'; $('error').hidden = false; $('error-message').textContent = formError; return; }
  formError = ''; $('error').hidden = true;
  $('confirmation').textContent = `${state.court || 'Your court'} · One replay for every registered email`;
  const card = node('div');
  card.append(node('strong', '', 'Replay recipients'));
  emails.forEach(value => card.append(node('span', '', value)));
  $('confirmation-recipients').replaceChildren(card);
  $('capture-note').textContent = state.audio
    ? 'Video and available camera microphone audio will be recorded. The same Google Drive replay will be emailed to each person.'
    : 'Video will be recorded. The same Google Drive replay will be emailed to each person.';
  show('confirm');
};
$('record').onclick = () => {
  if (startRequested) return;
  if (!state.enabled || !state.tested || !state.cameraMode || state.busy) { show('welcome'); call('setup'); return; }
  if (native) { startRequested = true; $('record').disabled = true; }
  call('start', JSON.stringify(emails));
  if (native) {
    try {
      const current = JSON.parse(native.state());
      startAccepted = !!current.busy && ['connecting', 'countdown', 'recording', 'finalizing'].includes(current.phase);
      if (!startAccepted && current.phase !== 'error') startRequested = false;
    } catch { /* The next state update resolves the request. */ }
    tick();
  }
};
$('stop').onclick = () => call('stop');
let playableTestToken = '';
function cameraConfirmationAllowed(current, selectedMode, playableToken) {
  return !current.busy && !!current.testConfirmable && !!current.testReady
    && !!current.testToken && playableToken === current.testToken
    && selectedMode === (current.selectedRecordingMode || 'auto');
}
$('camera-test-video').oncanplay = () => { playableTestToken = state.testToken || ''; };
$('camera-test-video').onerror = () => { playableTestToken = ''; $('camera-test-confirm').disabled = true; };
$('camera-test-confirm').onclick = () => {
  if (!$('camera-test-confirm').disabled) call('confirm-camera-test', JSON.stringify({mode:$('camera-quality').value,token:state.testToken}));
};
$('camera-test-retry').onclick = () => { $('camera-test-video').pause(); call('retry-camera-test', $('camera-quality').value); };
$('camera-quality').onchange = () => {
  $('camera-test-confirm').disabled = true;
  call('select-recording-mode', $('camera-quality').value);
};
$('reset').onclick = () => { call('reset'); show('welcome'); };
function formatRecordingTime(maxSeconds, elapsedMillis) {
  const elapsed = Math.max(0, Math.min(maxSeconds, Math.floor(elapsedMillis / 1000)));
  return String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
}
function drawRecordingTimer(now = performance.now()) {
  if (!recordingClock || state.phase !== 'recording') {
    timerAnimation = 0;
    return;
  }
  const elapsedMillis = recordingClock.elapsedMillis + Math.max(0, now - recordingClock.sampledAt);
  const text = formatRecordingTime(recordingClock.maxSeconds, elapsedMillis);
  if ($('timer').textContent !== text) $('timer').textContent = text;
  timerAnimation = requestAnimationFrame(drawRecordingTimer);
}
function syncRecordingTimer() {
  if (state.phase !== 'recording') {
    recordingClock = null;
    if (timerAnimation) cancelAnimationFrame(timerAnimation);
    timerAnimation = 0;
    return;
  }
  const now = performance.now();
  const reportedMillis = Math.max(0, Number(state.elapsedMs ?? Number(state.elapsed || 0) * 1000));
  const locallyElapsed = recordingClock
    ? recordingClock.elapsedMillis + Math.max(0, now - recordingClock.sampledAt)
    : 0;
  recordingClock = {
    elapsedMillis: Math.max(reportedMillis, locallyElapsed),
    sampledAt: now,
    maxSeconds: Math.max(1, Number(state.maxSeconds || 900)),
  };
  if (!timerAnimation) timerAnimation = requestAnimationFrame(drawRecordingTimer);
}
$('update-install').onclick = () => call('install-update');
$('update-check').onclick = () => { $('update-check').disabled = true; call('check-update'); };
$('connection-retry').onclick = event => { event.stopPropagation(); call('retry-connection'); };
function tick() {
  try { state = native ? JSON.parse(native.state()) : {enabled: true, enrolled: true, initialized: true, tested: true, cameraMode: 'device', court: 'Court 1', maxSeconds: 900}; }
  catch { return; }
  $('connection-notice').hidden = !state.connectionNotice;
  $('connection-retry').hidden = !state.connectionRetry;
  if ($('connection-text').textContent !== (state.connectionNotice || ''))
    $('connection-text').textContent = state.connectionNotice || '';
  const updateBlocked = !!(state.updateRequired || state.updateChecking) && !state.busy;
  $('required-update').hidden = !updateBlocked;
  document.querySelector('main').inert = updateBlocked;
  document.querySelector('.device-tools').inert = updateBlocked;
  if (updateBlocked) {
    if (isTextInput(document.activeElement)) document.activeElement.blur();
    hideModal();
    $('camera-test-video').pause();
    $('saved-player').pause();
    $('update-title').textContent = state.updateRequired ? 'Update DinkVision to continue' : 'Checking for updates';
    $('update-copy').textContent = state.updateRequired
      ? `Version ${state.update?.versionName || ''} is required. Download and install it, then reopen DinkVision. Your enrollment and saved videos stay in place when you install over this app. Do not uninstall it.`
      : 'Connect this device to the internet so DinkVision can check the approved app version.';
    $('update-install').hidden = !state.updateRequired || !state.update?.downloadUrl;
    $('update-error').hidden = !state.updateError;
    $('update-error').textContent = state.updateError || '';
    $('update-check').disabled = !!state.updateLoading;
    return;
  }
  if (state.enabled && $('modal').dataset.kind === 'saved-enrollment') hideModal();
  if (startRequested && (state.phase === 'recording' || (startAccepted && ['finalizing', 'complete'].includes(state.phase)))) {
    clearRecipientDraft();
    startRequested = false;
    startAccepted = false;
  } else if (startRequested && !state.busy && state.phase === 'error') {
    startRequested = false;
    startAccepted = false;
    // Retain the same group for an idempotent retry if its start response was
    // lost. A locally recoverable capture must be inspected before another start.
    show(state.startHasRecoverableFootage ? 'welcome' : 'confirm');
  } else if (startRequested && !state.busy && ['idle', 'review'].includes(state.phase)) {
    startRequested = false;
    startAccepted = false;
  }
  if (!state.busy && state.phase === 'error' && view === 'session') show('welcome');
  $('court').textContent = state.court || 'Not assigned';
  const cameraStatus = $('camera-status');
  const ready = !!(state.enabled && state.tested && state.cameraMode);
  cameraStatus.classList.toggle('ready', ready && !state.busy);
  cameraStatus.classList.toggle('active', state.phase === 'recording');
  cameraStatus.textContent = state.phase === 'recording' ? 'Recording'
    : state.busy ? 'Camera in use' : !state.enrolled ? 'Setup required'
    : !state.enabled ? 'Check connection' : ready ? 'Camera ready' : 'Camera check';
  $('header-court').hidden = !state.court;
  $('header-court').textContent = state.court || '';
  $('app-version').textContent = `Powered by WrenLabs${state.version ? ` · v${state.version}` : ''}`;
  const limitMinutes = Math.max(1, Math.round(Number(state.maxSeconds || 900) / 60));
  $('limit').textContent = `Recording limit: ${limitMinutes} minutes`;
  $('record').disabled = !!state.busy || startRequested;
  if (['form', 'confirm'].includes(view) && (!state.enabled || !state.tested || !state.cameraMode)) show('welcome');
  recordingModeOptions($('camera-quality'));
  $('camera-quality').disabled = !!state.busy;
  $('camera-test-confirm').disabled = !cameraConfirmationAllowed(state, $('camera-quality').value, playableTestToken);
  $('camera-test-retry').disabled = !!state.busy;
  const recoverable = view === 'welcome' && !!state.recoverable && !state.busy;
  const savedNotice = recoverable && (!state.error || state.startHasRecoverableFootage || /logo|upload|footage|saved video|saved recording/i.test(state.error));
  const recoveryMessage = 'Your recording is in Saved videos. Open it to check its status, save a device copy, or retry.';
  const currentError = savedNotice ? recoveryMessage : (state.error || (['form', 'confirm'].includes(view) ? formError : ''));
  if (currentError !== lastErrorNotice) {
    lastErrorNotice = currentError;
    errorNoticeExpiresAt = currentError ? performance.now() + 30_000 : 0;
  }
  $('error').hidden = !currentError || view === 'saved-videos' || performance.now() >= errorNoticeExpiresAt;
  $('error-message').textContent = currentError;
  $('recover').textContent = 'Saved videos';
  $('recover').hidden = !savedNotice;
  const count = state.countdown || 0;
  $('count-in').hidden = count < 1;
  $('count-number').textContent = String(count || 3);
  const recordingFlow = state.busy && ['connecting', 'countdown', 'recording', 'finalizing', 'testing'].includes(state.phase);
  if (state.testReady) {
    show('camera-test');
    if (lastTestToken !== state.testToken) {
      playableTestToken = '';
      $('camera-test-confirm').disabled = true;
      lastTestToken = state.testToken || String(Date.now());
      const preview = $('camera-test-video');
      preview.src = `https://appassets.androidplatform.net/camera-test/clip.mp4?v=${encodeURIComponent(lastTestToken)}`;
      preview.load();
    }
    $('camera-test-help').textContent = state.testHasAudio
      ? 'Play all three seconds with the volume on. Confirm if picture and sound are clear; otherwise record another test.'
      : 'Play all three seconds. Confirm if the picture is clear; otherwise record another test.';
    if (state.testHasAudio && state.testAudioInput) $('camera-test-help').textContent += ` Audio: ${state.testAudioInput}.`;
    if (state.recordingProfile) $('camera-test-help').textContent += ` Camera: ${state.recordingProfile}.`;
    if (innerHeight <= 600) $('camera-test-help').textContent = `Play with sound. ${state.testAudioInput?.startsWith('Camera microphone') ? 'Camera mic.' : 'Device mic.'} ${state.recordingProfile || ''}`;
    if (state.logoPipeline) $('camera-test-help').textContent += ` ${state.logoPipeline}.`;
    $('camera-test-confirm').textContent = state.testHasAudio ? 'I can see and hear the test' : 'The video looks clear';
  } else if (recordingFlow) {
    show('session');
    $('session-title').textContent = state.phase === 'recording' ? 'Stay in the game.' : state.phase === 'testing' ? 'Testing your camera' : 'Your match';
    $('progress').textContent = state.message || 'Preparing your match…';
    const loading = ['connecting', 'testing', 'finalizing'].includes(state.phase);
    $('loading').hidden = !loading;
    $('loading').querySelector('b').textContent = state.phase === 'testing' ? 'Checking camera…' : state.phase === 'finalizing' ? 'Preparing saved video…' : 'Connecting to camera…';
    $('timer').hidden = state.phase !== 'recording';
    syncRecordingTimer();
    $('stop').hidden = state.phase !== 'recording';
    $('reset').hidden = true;
  } else if (view === 'session' || view === 'camera-test') {
    if (view === 'camera-test') { const preview = $('camera-test-video'); preview.pause(); preview.removeAttribute('src'); preview.load(); lastTestToken = ''; }
    show('welcome');
  } else {
    syncRecordingTimer();
  }
  const completion = state.phase === 'complete' && view === 'welcome';
  $('notice').classList.toggle('complete', completion);
  const statusNotice = !state.enabled
    ? ''
    : unfinishedSession() ? 'Previous recording needs attention. Tap to check its status or open Saved videos.'
    : !state.cameraMode ? 'Camera setup is required.'
    : state.testReady ? 'Review the clip and confirm the camera test.'
    : !state.tested ? 'Camera test is required.'
    : view === 'welcome' ? (state.message || '') : '';
  if (statusNotice !== lastStatusNotice) {
    lastStatusNotice = statusNotice;
    statusNoticeExpiresAt = statusNotice ? performance.now() + 30_000 : 0;
  }
  $('notice').textContent = statusNotice;
  syncReenrollVisibility();
  renderSavedVideos();
  $('notice').hidden = !statusNotice || view === 'saved-videos' || !$('error').hidden || performance.now() >= statusNoticeExpiresAt;
  if (state.initialized && !state.enabled && !state.enrolled && !enrollmentPrompted) {
    enrollmentPrompted = true;
    call('setup');
  }
}
tick();
renderEmails();
setInterval(tick, 750);
