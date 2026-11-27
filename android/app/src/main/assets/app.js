const $ = id => document.getElementById(id);
let view = 'welcome', state = {}, emails = [], formError = '', enrollmentPrompted = false, lastTestToken = '';

const interruptionReasons = {
  camera_disconnected: 'The camera disconnected.',
  camera_failure: 'The camera stopped delivering usable video.',
  storage_full: 'The tablet was low on recording storage.',
  app_interrupted: 'The app restarted before it finished saving.',
  unknown: 'The recording ended unexpectedly.',
};
let recordingClock = null, timerAnimation = 0;
let savedSelection = '', lastSavedToken = '', reviewingOffline = false;
let startRequested = false, startAccepted = false;
let stopRequestedAttempt = '';
let qrEnrollmentSubmit = null;
let modalOpener = null;
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
  qrEnrollmentSubmit = null;
  $('modal').hidden = true;
  delete $('modal').dataset.kind;
  $('modal-content').replaceChildren();
  $('modal-actions').replaceChildren();
  $('modal-error').hidden = true;
  if (modalOpener?.isConnected && !modalOpener.closest('[hidden], [inert]'))
    modalOpener.focus({ preventScroll: true });
  modalOpener = null;
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
  if (['camera-ready', 'camera-ready-device'].includes(data.kind) &&
      (state.phase === 'testing' || state.testReady)) return;
  const modal = $('modal'), content = $('modal-content'), actions = $('modal-actions');
  if (modal.hidden) modalOpener = document.activeElement;
  qrEnrollmentSubmit = null;
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
    if (data.id && !state.updateChecking && data.localAvailable !== false) modalButton('Save another copy', () => { hideModal(); call('save-local-video', data.id); });
    modalButton('Close', hideModal, true);
  } else if (data.kind === 'remove-saved-video') {
    title('SAVED VIDEO', 'Remove the app copy?', 'This removes only the copy inside DinkVision. Your exported Gallery / Files copy and any uploaded cloud copy stay in place. This app cannot retry an upload after its copy is removed.');
    modalButton('Remove app copy', () => { hideModal(); $('saved-player').pause(); $('saved-player').removeAttribute('src'); lastSavedToken=''; call('remove-local-video', data.id); }, true);
    cancel('Keep app copy');
  } else if (data.kind === 'enrollment') {
    title('DEVICE SETUP', data.replace ? 'Re-enroll this device' : 'Register this Android device',
      state.enrollmentPending ? 'Check the previous enrollment attempt before requesting a new invitation.'
        : `In Admin${state.enrollmentOrigin ? ` at ${state.enrollmentOrigin}` : ''}, open Devices & cameras and create an enrollment invitation.`);
    modalButton('Scan enrollment QR', () => { hideModal(); call('scan-enrollment', data.replace ? 'replace' : 'new'); }, true);
    modalButton('Enter code instead', () => showNativeModal({kind:'enrollment-code', replace: !!data.replace}));
    if (data.scanError) window.setNativeModalError(data.scanError);
    if (state.enrollmentPending) modalButton('Check confirmation', () => showNativeModal({kind:'enrollment-check', replace: !!data.replace}));
    cancel();
  } else if (data.kind === 'enrollment-code') {
    title('DEVICE SETUP', 'Enter the enrollment code', 'Use the code shown below the QR in the Admin invitation.');
    const code = field('ENROLLMENT CODE', 'code', '', {max: 24, placeholder: 'Enter enrollment code', wide: true});
    code.autocapitalize = 'none';
    const submit = modalButton(data.replace ? 'Re-register device' : 'Register device', () => {
      const value = code.value.trim();
      if (!/^(?:[A-Za-z0-9_-]{12}|[A-Za-z0-9_-]{24})$/.test(value)) {
        window.setNativeModalError('Enter the full enrollment code from Admin.');
        code.focus();
        return;
      }
      clearRecipientDraft();
      code.blur();
      submit.disabled = true;
      submit.textContent = 'Registering…';
      $('modal-error').hidden = true;
      qrEnrollmentSubmit = submit;
      call('enroll', JSON.stringify({code: value, replace: !!data.replace}));
    }, true);
    modalButton('Back', () => showNativeModal({kind:'enrollment', replace: !!data.replace}));
  } else if (data.kind === 'enrollment-check') {
    title('DEVICE SETUP', 'Check enrollment', 'Check whether the server confirmed your previous attempt.');
    const check = modalButton('Check confirmation', () => {
      check.disabled = true;
      check.textContent = 'Checking…';
      $('modal-error').hidden = true;
      qrEnrollmentSubmit = check;
      call('retry-connection');
    }, true);
    modalButton('Back', () => showNativeModal({kind:'enrollment', replace: !!data.replace}));
  } else if (data.kind === 'enrollment-pairing') {
    enrollmentPrompted = true;
    title('DEVICE SETUP', data.replace ? 'Replace this registration?' : 'Pair this device?',
      data.replace ? 'Confirm to replace this tablet’s current registration with the scanned invitation.'
        : 'Confirm to register this tablet with the scanned invitation.');
    const submit = modalButton(data.replace ? 'Confirm replacement' : 'Confirm pairing', () => {
      submit.disabled = true;
      submit.textContent = 'Pairing…';
      $('modal-error').hidden = true;
      clearRecipientDraft();
      qrEnrollmentSubmit = submit;
      call('enroll', JSON.stringify({code: data.code, replace: !!data.replace}));
    }, true);
    cancel();
  } else if (data.kind === 'enrollment-pin') {
    enrollmentPrompted = true;
    title('DEVICE SETUP', data.replace ? 'Replace this registration?' : 'Verify enrollment',
      data.replace ? 'Enter the six-digit PIN shown next to the QR in Admin to replace this tablet’s registration.'
        : 'Enter the six-digit PIN shown next to the QR in Admin.');
    const pin = field('VERIFICATION PIN', 'pin', '', {max: 6, placeholder: '6 digits', inputmode: 'numeric', secret: true, wide: true});
    const submit = modalButton(data.replace ? 'Verify and replace' : 'Verify and register', () => {
      if (!/^[0-9]{6}$/.test(pin.value)) {
        window.setNativeModalError('Enter all six PIN digits from Admin.');
        pin.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Verifying…';
      $('modal-error').hidden = true;
      clearRecipientDraft();
      qrEnrollmentSubmit = submit;
      call('enroll-qr', JSON.stringify({invite: data.invite, pin: pin.value, replace: !!data.replace}));
    }, true);
    cancel();
  } else if (data.kind === 'saved-enrollment') {
    const inactive = state.registrationInactive;
    title('DEVICE SETUP', inactive ? 'Registration needs attention' : 'Enrollment saved', inactive
      ? 'Admin reports this registration is inactive or unrecognized. Ask Admin to check this device. Its saved videos have not been deleted. Re-register only when Admin intentionally replaces the registration.'
      : 'Enrollment is saved on this device. The server could not be reached to verify its assignment. Reconnect to the internet and check again; a new enrollment code is not needed for a connection outage.');
    modalButton('Check again', () => { hideModal(); call('retry-connection'); }, true);
    if (inactive) modalButton('Re-register', () => { hideModal(); call('setup-reenroll'); });
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
      'The tablet uses a compatible USB camera when one is connected. Otherwise, it uses the built-in rear camera.');
    const qualityLabel = node('label', 'modal-field wide', 'VIDEO QUALITY');
    const quality = node('select'); quality.value = state.selectedRecordingMode || 'auto';
    recordingModeOptions(quality);
    qualityLabel.append(quality); content.append(qualityLabel);
    modalButton('Record a 3-second test', () => { const mode = quality.value; hideModal(); call('sync-camera', mode); tick(); }, true);
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
    title('RECORDING IN PROGRESS', 'Leave the recorder?', 'Leaving cancels a recording that is still preparing. Active recordings and uploads continue.');
    modalButton('Leave app', () => { hideModal(); call('leave-confirmed'); }, true);
    cancel('Stay');
  } else return;
  modal.hidden = false;
  requestAnimationFrame(() => $('modal-title').focus({ preventScroll: true }));
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
  if (event.key !== 'Tab' || $('modal').hidden) return;
  const controls = [...$('modal').querySelectorAll('button, input, select')].filter(
    control => !control.disabled && control.getClientRects().length);
  if (!controls.length) return;
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && [first, $('modal-title')].includes(document.activeElement)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
});
const isTextInput = target => target instanceof Element && !!target.closest('input, textarea');
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && isTextInput(event.target) && !$('modal').hidden) {
    event.preventDefault(); event.target.blur();
  }
});
document.addEventListener('selectstart', event => { if (!isTextInput(event.target)) event.preventDefault(); });
document.addEventListener('contextmenu', event => { if (!isTextInput(event.target)) event.preventDefault(); });
const keepKioskAnchored = () => {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
};
window.addEventListener('scroll', keepKioskAnchored, {passive: true});
window.visualViewport?.addEventListener('scroll', keepKioskAnchored, {passive: true});
let recipientKeyboardInset = 0, keyboardInsetReported = false;
function layoutRecipientEntry() {
  const viewport = window.visualViewport;
  const viewportInset = viewport && document.activeElement === $('player-email')
    ? Math.max(0, innerHeight - viewport.height) : 0;
  const inset = keyboardInsetReported ? recipientKeyboardInset : viewportInset;
  const editing = view === 'form' && $('modal').hidden && inset > 40;
  document.body.classList.toggle('recipient-ime', editing);
  document.body.classList.toggle('recipient-ime-short', editing && innerHeight - inset < 160);
  if (editing) document.body.style.setProperty('--recipient-ime-bottom', `${inset}px`);
}
window.setRecipientKeyboardInset = pixels => {
  keyboardInsetReported = true;
  recipientKeyboardInset = pixels / window.devicePixelRatio;
  layoutRecipientEntry();
};
window.visualViewport?.addEventListener('resize', layoutRecipientEntry, {passive: true});
window.addEventListener('resize', layoutRecipientEntry, {passive: true});
document.addEventListener('focusin', () => {
  keepKioskAnchored();
  requestAnimationFrame(keepKioskAnchored);
  setTimeout(keepKioskAnchored, 100);
  setTimeout(keepKioskAnchored, 300);
});
function show(name) {
  const enteringForm = view !== 'form' && name === 'form';
  if (view === 'saved-videos' && name !== view) {
    reviewingOffline = false;
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
  layoutRecipientEntry();
  if (enteringForm) $('player-email').focus();
  syncReenrollVisibility();
}
const syncReenrollVisibility = () => {
  $('reenroll').hidden = view !== 'welcome' || !state.enrolled || !!state.busy;
  $('saved-open').hidden = view !== 'welcome' || !!state.busy ||
    !(state.enrolled || state.savedVideos?.length);
  $('saved-open').textContent = state.savedVideos?.length ? `Saved videos (${state.savedVideos.length})` : 'Saved videos';
  const tools = document.querySelector('.device-tools');
  tools.hidden = $('reenroll').hidden && $('saved-open').hidden;
  if (tools.hidden) closeSettings();
};
function closeSettings() {
  $('settings-actions').hidden = true;
  $('settings-toggle').setAttribute('aria-expanded', 'false');
}
$('settings-toggle').onclick = () => {
  const open = $('settings-actions').hidden;
  $('settings-actions').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
};
const beginFromWelcome = () => {
  if (state.busy || state.testReady || !$('modal').hidden || !$('required-update').hidden) return;
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
$('begin').onclick = beginFromWelcome;
document.addEventListener('click', event => {
  const target = event.target;
  if (target.closest('.device-tools')) return;
  if (!$('settings-actions').hidden) { closeSettings(); return; }
  if (view !== 'welcome' || target.closest('button, a, input, header, #notifications, #modal, #required-update')) return;
  const belowHeader = event.clientY >= document.querySelector('header').getBoundingClientRect().bottom;
  if (target.closest('#welcome, footer') || target.matches('main') || (belowHeader && target.matches('body, .backdrop')))
    beginFromWelcome();
});
function handlePlayerBack() {
  if (!$('modal').hidden) { hideModal(); return true; }
  if (!$('settings-actions').hidden) { closeSettings(); $('settings-toggle').focus(); return true; }
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
  closeSettings();
  call('setup-reenroll');
});
$('saved-open').onclick = event => { event.stopPropagation(); show('saved-videos'); renderSavedVideos(); };
$('saved-back').onclick = () => handlePlayerBack();
$('recover').addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  if (state.savedVideos?.length && !state.busy) {
    savedSelection = $('recover').dataset.id || '';
    show('saved-videos'); renderSavedVideos(); }
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
  const reason = interruptionReasons[item?.captureInterruptionCode];
  const detail = [`Recording ID: ${item?.id || ''}`, reason, item?.lastError].filter(Boolean).join('\n');
  showNativeModal({kind: 'saved-video-error', id:item?.id, localAvailable:item?.localAvailable, error: detail});
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
    : 'No videos are saved inside this app. Completed uploads may already be in cloud storage.';
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
  const duration = item.durationMs > 0 ? `${Math.round(item.durationMs / 1000)} seconds` : 'Duration not verified';
  const sizeMb = (Number(item.bytes || 0) / 1048576).toFixed(1);
  const transferredMb = (Number(item.uploadedBytes || 0) / 1048576).toFixed(1);
  const size = item.status === 'uploading' ? `${transferredMb} / ${sizeMb} MB uploaded` : `${sizeMb} MB`;
  $('saved-video-meta').textContent = `${date ? date + ' · ' : ''}${duration} · ${size}`;
  const waiting = item.brandingState === 'complete' ? 'Waiting to upload' : 'Waiting to add logo';
  const statuses = {pending: waiting, saved_locally: waiting, retrying: `${item.brandingState === 'failed' ? 'Logo processing' : 'Upload'} retry scheduled · ${item.retryCount || 0} retries`, uploading: item.verifyingUpload ? 'Verifying upload' : `Uploading ${Math.min(99, item.progress || 0)}%`, uploaded: item.localAvailable === false ? 'Uploaded' : 'Uploaded · app copy cleanup pending', local_only: 'Local only · under one minute'};
  const interrupted = !!item.captureInterruptionCode;
  const needsInspection = !!item.validationFailed;
  const missing = item.localAvailable === false;
  const status = missing ? 'No footage available'
    : item.status === 'failed'
    ? item.validationFailed ? 'Video needs inspection. Save the original for review.'
      : item.brandingState === 'failed' ? 'Logo processing failed. The original is still saved.'
        : `Upload paused · ${item.retryCount || 0} failed attempts. You can retry.`
    : item.validationPending ? 'Checking saved video'
      : item.brandingState === 'processing' ? 'Adding the DinkVision logo' : statuses[item.status] || 'Saved in this app';
  $('saved-video-status').textContent = interrupted ? `Interrupted recording · ${status}` : status;
  if (interrupted && item.durationMs > 0 && !item.validationPending && !needsInspection && !missing)
    $('saved-video-status').textContent = 'Partial recording saved · ' + duration + ' · ' + status;
  $('saved-save').hidden = missing;
  $('saved-details').hidden = false;
  $('saved-retry').hidden = missing || (interrupted && needsInspection) || !['failed','retrying'].includes(item.status);
  $('saved-retry').textContent = item.status === 'retrying' ? 'Retry now' : item.validationFailed || item.brandingState === 'failed' ? 'Retry processing' : 'Retry upload';
  $('saved-retry').disabled = !!state.updateChecking || !!state.busy;
  $('saved-save').disabled = !!state.updateChecking || !!state.exportingSession || (item.exported && !item.canRemove);
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
  const brandingPercent = processing && Number.isInteger(item.brandingProgress) && item.brandingProgress >= 0 ? Math.min(99, item.brandingProgress) : null;
  $('saved-processing-label').textContent = item.validationPending ? 'Checking saved video…'
    : brandingPercent === null ? 'Adding logo…'
    : brandingPercent >= 99 ? 'Checking saved video · 99%' : `Adding logo · ${brandingPercent}%`;
  if (brandingPercent === null) $('saved-processing-progress').removeAttribute('value');
  else $('saved-processing-progress').value = brandingPercent;
  if (processing && brandingPercent !== null) $('saved-video-status').textContent = $('saved-processing-label').textContent;
  $('saved-processing').hidden = !(processing || (item.validationPending && item.status !== 'failed'));
  $('saved-player').hidden = missing || needsInspection || processing || !!item.validationPending;
  if (missing || needsInspection || processing || item.validationPending) {
    lastSavedToken = '';
    $('saved-preview-warning').hidden = missing || !needsInspection;
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
function renderEmailFeedback() {
  const input = $('player-email');
  const feedback = $('email-count');
  feedback.textContent = formError || `${emails.length} of 4 emails added`;
  feedback.classList.toggle('invalid', !!formError);
  input.setAttribute('aria-invalid', String(!!formError));
  $('add-email').disabled = emails.length >= 4 || !input.value.trim();
}
function renderEmails() {
  renderEmailFeedback();
  $('email-list').replaceChildren(...emails.map(address => {
    const chip = node('div');
    const label = node('button', 'edit-address', address);
    label.type = 'button';
    label.setAttribute('aria-label', 'Edit ' + address);
    label.onclick = () => {
      const input = $('player-email');
      if (input.value.trim() && !addEmail()) return;
      emails = emails.filter(value => value !== address);
      input.value = address;
      formError = '';
      renderEmails();
      input.focus();
    };
    label.title = address;
    const remove = node('button', '', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${address}`);
    remove.onclick = () => {
      emails = emails.filter(value => value !== address);
      formError = '';
      renderEmails();
    };
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
  const input = $('player-email');
  const values = input.value.toLowerCase().split(/[,;\r\n]+/).map(value => value.trim()).filter(Boolean);
  const invalid = values.find(value => value.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(value)
    || /@example\.(com|net|org)$/.test(value));
  if (!values.length || invalid) formError = 'Check the email address and try again.';
  else if (new Set([...emails, ...values]).size !== emails.length + values.length)
    formError = 'This address is already on the list.';
  else if (emails.length + values.length > 4) formError = 'Choose up to four addresses for this replay.';
  else {
    emails.push(...values);
    input.value = '';
    formError = '';
    renderEmails();
    if (emails.length === 4) input.blur();
    return true;
  }
  renderEmailFeedback();
  return false;
}
$('player-email').oninput = () => {
  formError = '';
  renderEmailFeedback();
};
$('player-email').onpaste = event => {
  const pasted = event.clipboardData?.getData('text');
  if (!pasted || !/[,;\r\n]/.test(pasted)) return;
  event.preventDefault();
  document.execCommand('insertText', false, pasted.replace(/[;\r\n]+/g, ','));
};
$('player-email').onkeydown = event => {
  if (['Enter', ',', ';'].includes(event.key) && !event.isComposing) {
    event.preventDefault();
    if ($('player-email').value.trim()) addEmail();
  }
};
$('add-email').onpointerdown = event => {
  if (document.activeElement === $('player-email')) event.preventDefault();
};
$('add-email').onclick = addEmail;
$('email-form').onsubmit = event => {
  event.preventDefault();
  if (!state.enabled || !state.tested || !state.cameraMode || state.busy) { show('welcome'); call('setup'); return; }
  if ($('player-email').value.trim() && !addEmail()) return;
  if (!emails.length) {
    formError = 'Add at least one email address.';
    renderEmailFeedback();
    return;
  }
  formError = '';
  renderEmailFeedback();
  $('player-email').blur();
  $('confirmation').textContent = state.court || 'Your court';
  $('confirmation-recipients').replaceChildren(...emails.map(email => {
    const row = node('div', 'recipient-review-row');
    row.append(node('span', '', email));
    return row;
  }));
  $('capture-note').textContent = state.audio
    ? 'We’ll record video and available audio, then email the replay to these addresses.'
    : 'We’ll record video, then email the replay to these addresses.';
  show('confirm');
};
function watchRepeatedPress(id, action, argument) {
  const button = $(id);
  button.parentElement.addEventListener('pointerdown', event => {
    if (!button.disabled || button.hidden || !event.isPrimary || event.button !== 0) return;
    const bounds = button.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0 && event.clientX >= bounds.left && event.clientX < bounds.right &&
        event.clientY >= bounds.top && event.clientY < bounds.bottom) call(action, argument());
  });
}
watchRepeatedPress('record', 'repeat-start', () => '');
watchRepeatedPress('stop', 'repeat-stop', () => state.captureAttempt || '');
$('record').onclick = event => {
  if (startRequested) { call('repeat-start'); return; }
  if (!state.enabled || !state.tested || !state.cameraMode || state.busy) { show('welcome'); call('setup'); return; }
  if (native) { startRequested = true; $('record').disabled = true; }
  const request = {emails, tapDelayMs: Math.max(0, Math.min(5000, Math.round(performance.now() - event.timeStamp)))};
  call('start', JSON.stringify(request));
  if (native) {
    try {
      const current = JSON.parse(native.state());
      startAccepted = !!current.busy && ['connecting', 'countdown', 'recording', 'finalizing'].includes(current.phase);
      if (!startAccepted && current.phase !== 'error') startRequested = false;
    } catch { /* The next state update resolves the request. */ }
    tick();
  }
};
$('stop').onclick = () => {
  const attempt = state.captureAttempt;
  if (!attempt || stopRequestedAttempt === attempt || state.phase !== 'recording') return;
  stopRequestedAttempt = attempt;
  $('stop').disabled = true;
  call('stop', attempt);
  tick();
};
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
$('update-saved').onclick = () => {
  reviewingOffline = true;
  show('saved-videos');
  tick();
};
$('update-check').onclick = () => { $('update-check').disabled = true; call('check-update'); };
$('connection-retry').onclick = event => { event.stopPropagation(); call('retry-connection'); };
function tick() {
  const wasConfirmingEnrollment = !!state.enrollmentPending;
  try { state = native ? JSON.parse(native.state()) : {enabled: true, enrolled: true, initialized: true, tested: true, cameraMode: 'device', court: 'Court 1', maxSeconds: 900}; }
  catch { return; }
  $('connection-notice').hidden = !state.connectionNotice;
  $('connection-notice').dataset.tone = state.registrationInactive ? 'action'
    : state.enrollmentChecking || !state.initialized && !state.connectionRetry ? 'info' : 'waiting';
  $('connection-retry').hidden = !state.connectionRetry;
  $('connection-retry').textContent = state.enrollmentPending ? 'Check enrollment' : 'Retry connection';
  if ($('connection-text').textContent !== (state.connectionNotice || ''))
    $('connection-text').textContent = state.connectionNotice || '';
  const offlineLibrary = state.updateChecking && !state.updateRequired && state.localDeviceKnown && !!state.savedVideos?.length;
  $('update-saved').hidden = !offlineLibrary;
  const updateBlocked = (state.updateRequired || state.updateChecking) && !state.busy &&
    !(offlineLibrary && reviewingOffline && view === 'saved-videos');
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
  if (qrEnrollmentSubmit && !state.busy && !state.enrollmentChecking) {
    if (state.enrolled && !state.enrollmentPending && !state.error) {
      hideModal();
      call('setup');
    } else {
      qrEnrollmentSubmit.disabled = false;
      qrEnrollmentSubmit.textContent = 'Try again';
      window.setNativeModalError(state.error || 'Confirmation is still pending. Check the connection and retry the same invitation.');
      qrEnrollmentSubmit = null;
    }
  }
  if (state.enabled && wasConfirmingEnrollment && !state.enrollmentPending &&
      $('modal').dataset.kind === 'enrollment' && !document.querySelector('#modal-content input')?.value)
    hideModal();
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

  const cameraStatus = $('camera-status');
  const ready = !!(state.enabled && state.tested && state.cameraMode);
  cameraStatus.classList.toggle('ready', ready && !state.busy);
  cameraStatus.classList.toggle('active', state.phase === 'recording');
  cameraStatus.textContent = state.phase === 'recording' ? 'Recording'
    : state.phase === 'finalizing' ? 'Finalizing'
    : state.phase === 'countdown' ? 'Starting soon'
    : state.phase === 'connecting' ? 'Connecting camera'
    : state.phase === 'testing' ? 'Testing camera'
    : state.busy ? 'Camera in use'
    : !state.enrolled ? 'Setup required'
    : !state.enabled ? 'Check connection'
    : ready ? 'Camera ready' : 'Camera check';
  $('header-court').hidden = !state.court;
  $('header-court').textContent = state.court || '';
  $('app-version').textContent = `Powered by WrenLabs${state.version ? ` · v${state.version}` : ''}`;
  const limitMinutes = Math.max(1, Math.round(Number(state.maxSeconds || 900) / 60));
  $('limit').textContent = `Recording limit: ${limitMinutes} minutes`;
  $('record').disabled = !!state.busy || startRequested;
  if (stopRequestedAttempt !== state.captureAttempt) stopRequestedAttempt = '';
  $('stop').disabled = !!stopRequestedAttempt;
  if (['form', 'confirm'].includes(view) && (!state.enabled || !state.tested || !state.cameraMode)) {
    clearRecipientDraft();
    show('welcome');
  }
  recordingModeOptions($('camera-quality'));
  $('camera-quality').disabled = !!state.busy;
  $('camera-test-confirm').disabled = !cameraConfirmationAllowed(state, $('camera-quality').value, playableTestToken);
  $('camera-test-retry').disabled = !!state.busy;
  const interruptedItem = state.savedVideos?.find(item => (item.captureInterruptionCode || item.localAvailable === false) &&
    (item.id === state.latestSavedSession || item.id === state.session?.id));
  const recoverable = view === 'welcome' && (!!state.recoverable || !!interruptedItem) && !state.busy;
  const savedNotice = recoverable && (!!interruptedItem || !state.error || state.startHasRecoverableFootage || /logo|upload|footage|saved video|saved recording/i.test(state.error));
  const recoveryMessage = interruptedItem?.localAvailable === false ? 'Recording interrupted. No footage available. View details in Saved videos.'
    : interruptedItem?.validationPending ? 'Recording interrupted. Checking available footage…'
    : 'Your recording is in Saved videos. Open it to check its status, save a device copy, or retry.';
  const currentError = savedNotice ? recoveryMessage : (state.error || '');
  $('error').hidden = !currentError || view === 'saved-videos';
  $('error').dataset.tone = savedNotice && !interruptedItem?.validationFailed ? 'waiting' : 'action';
  $('error-message').textContent = currentError;
  $('recover').textContent = 'Saved videos';
  $('recover').dataset.id = interruptedItem?.id || '';
  $('recover').hidden = !savedNotice;
  const count = state.countdown || 0;
  $('count-in').hidden = count < 1;
  $('count-number').textContent = String(count || 3);
  const recordingFlow = state.busy && ['connecting', 'countdown', 'recording', 'finalizing', 'testing'].includes(state.phase);
  if ((state.phase === 'testing' || state.testReady) && ['camera-ready','camera-ready-device'].includes($('modal').dataset.kind)) hideModal();
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
    if (innerHeight <= 600) $('camera-test-help').textContent = [
      state.testHasAudio ? 'Play with sound.' : 'Check the picture.',
      state.testHasAudio && state.testAudioInput, state.recordingProfile
    ].filter(Boolean).join(' ');
    if (!state.testConfirmable || $('camera-quality').value !== (state.selectedRecordingMode || 'auto'))
      $('camera-test-help').textContent = 'Record another test with the selected settings before confirming.';
    if (state.logoPipeline) $('camera-test-help').textContent += ` ${state.logoPipeline}.`;
    if ($('camera-test-video').error)
      $('camera-test-help').textContent = 'The test clip could not play. Record another test to check this camera.';
    $('camera-test-confirm').textContent = state.testHasAudio ? 'I can see and hear the test' : 'The video looks clear';
  } else if (recordingFlow) {
    show('session');
    $('session-title').textContent = {
      connecting: 'Preparing camera', countdown: 'Starting recording', recording: 'Recording match',
      finalizing: 'Saving recording', testing: 'Testing your camera'
    }[state.phase];
    $('progress').textContent = state.phase === 'recording'
      ? (stopRequestedAttempt ? 'Stop requested…' : `Recording limit: ${limitMinutes} minutes`)
      : state.message || 'Preparing your match…';
    const loading = ['connecting', 'testing', 'finalizing'].includes(state.phase);
    const testing = state.phase === 'testing';
    $('test-progress').hidden = !testing;
    if (testing && state.cameraTestStage === 'capturing') $('test-progress').value = Math.min(3, state.elapsed || 0);
    else $('test-progress').removeAttribute('value');
    $('loading').hidden = !loading || testing;
    const loadingLabel = $('loading').querySelector('b');
    loadingLabel.hidden = state.phase === 'connecting';
    loadingLabel.textContent = state.phase === 'testing' ? 'Checking camera…' : 'Preparing saved video…';
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
  $('notice').dataset.tone = interruptedItem || unfinishedSession() ? 'waiting' : completion ? 'success' : 'info';
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
