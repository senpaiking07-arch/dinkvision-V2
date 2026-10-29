const $ = id => document.getElementById(id);
let view = 'welcome', state = {}, emails = [], formError = '', enrollmentPrompted = false, lastTestToken = '';
let recordingClock = null, timerAnimation = 0;
const native = window.CasaNative;
const call = (action, value = '') => {
  if (native) native.action(action, value);
  else {
    $('error').hidden = false;
    $('error').textContent = 'Design preview only. Install the APK to record.';
  }
};
const hideModal = () => {
  $('modal').hidden = true;
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
function showNativeModal(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return; }
  const modal = $('modal'), content = $('modal-content'), actions = $('modal-actions');
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

  if (data.kind === 'enrollment') {
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
    title('DEVICE SETUP', 'Enrollment saved', 'This Android device is still registered, but its assignment could not be retrieved. Check the connection and try again.');
    modalButton('Check again', () => { hideModal(); call('refresh'); }, true);
    modalButton('Re-register', () => { hideModal(); call('setup-reenroll'); });
    cancel('Close');
  } else if (data.kind === 'camera-ready' || data.kind === 'camera-ready-device') {
    title('CAMERA SETUP', 'USB / built-in camera',
      'The tablet uses an attached compatible USB camera such as EMEET when available, otherwise its rear camera.');
    modalButton('Record a 3-second test', () => { hideModal(); call('sync-camera'); }, true);
    modalButton('Reconnect camera', () => { hideModal(); call('choose-device'); });
    cancel('Close');
  } else if (data.kind === 'permission') {
    title('CAMERA PERMISSION', 'Camera access is needed', 'Allow camera and microphone access in Android settings, then return here and use the start circle to run the camera test again.');
    cancel('Close');
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
  view = name;
  for (const section of ['welcome', 'form', 'confirm', 'session', 'camera-test'])
    $(section).hidden = section !== name;
  syncReenrollVisibility();
}
const syncReenrollVisibility = () => {
  $('reenroll').hidden = view !== 'welcome' || !state.enrolled || !!state.busy;
};
const beginFromWelcome = () => {
  if (!state.enabled || !state.tested || !state.cameraMode) {
    call('setup');
    return;
  }
  show('form');
};
$('welcome').addEventListener('click', event => {
  if ($('modal').hidden && !event.composedPath().includes($('modal'))) beginFromWelcome();
});
function handlePlayerBack() {
  if (!$('modal').hidden) { hideModal(); return true; }
  if (view === 'confirm') { show('form'); return true; }
  if (view === 'form') {
    $('player-email').blur();
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
function addEmail() {
  const value = $('player-email').value.trim().toLowerCase();
  if (emails.length >= 4) formError = 'You can add a maximum of 4 Gmail accounts.';
  else if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)) formError = 'Enter a valid Gmail address.';
  else if (emails.includes(value)) formError = 'That Gmail address is already added.';
  else {
    emails.push(value); $('player-email').value = ''; formError = ''; $('error').hidden = true; renderEmails(); return true;
  }
  $('error').hidden = false; $('error').textContent = formError;
  return false;
}
$('player-email').oninput = () => { formError = ''; renderEmails(); };
$('player-email').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addEmail(); } };
$('add-email').onclick = addEmail;
$('email-form').onsubmit = event => {
  event.preventDefault();
  if ($('player-email').value.trim() && !addEmail()) return;
  if (!emails.length) { formError = 'Add at least one valid Gmail address.'; $('error').hidden = false; $('error').textContent = formError; return; }
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
  call('start', JSON.stringify(emails));
  $('player-email').value = ''; emails = []; formError = ''; renderEmails();
};
$('stop').onclick = () => call('stop');
$('camera-test-confirm').onclick = () => call('confirm-camera-test');
$('camera-test-retry').onclick = () => { $('camera-test-video').pause(); call('retry-camera-test'); };
$('reset').onclick = () => { call('reset'); show('welcome'); };
function formatRemainingTime(maxSeconds, elapsedMillis) {
  const remaining = Math.max(0, Math.ceil((maxSeconds * 1000 - elapsedMillis) / 1000));
  return String(Math.floor(remaining / 60)).padStart(2, '0') + ':' + String(remaining % 60).padStart(2, '0');
}
function drawRecordingTimer(now = performance.now()) {
  if (!recordingClock || state.phase !== 'recording') {
    timerAnimation = 0;
    return;
  }
  const elapsedMillis = recordingClock.elapsedMillis + Math.max(0, now - recordingClock.sampledAt);
  const text = formatRemainingTime(recordingClock.maxSeconds, elapsedMillis);
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
function tick() {
  try { state = native ? JSON.parse(native.state()) : {enabled: true, enrolled: true, initialized: true, tested: true, cameraMode: 'device', court: 'Court 1', maxSeconds: 900}; }
  catch { return; }
  $('court').textContent = state.court || 'Not assigned';
  $('app-version').textContent = `Android recorder · ${state.version || 'preview'}`;
  const limitMinutes = Math.max(1, Math.round(Number(state.maxSeconds || 900) / 60));
  $('limit').textContent = `Recording limit: ${limitMinutes} minutes`;
  $('record').disabled = !!state.busy;
  $('camera-test-confirm').disabled = !!state.busy;
  $('camera-test-retry').disabled = !!state.busy;
  const currentError = state.error || formError;
  $('error').hidden = !currentError;
  $('error').textContent = currentError;
  const count = state.countdown || 0;
  $('count-in').hidden = count < 1;
  $('count-number').textContent = String(count || 3);
  const session = state.session;
  const activeServerSession = session && ['requested', 'starting', 'recording', 'finalizing'].includes(session.status);
  const recordingFlow = state.busy && ['connecting', 'countdown', 'recording', 'finalizing', 'testing'].includes(state.phase);
  if (state.testReady) {
    show('camera-test');
    if (lastTestToken !== state.testToken) {
      lastTestToken = state.testToken || String(Date.now());
      const preview = $('camera-test-video');
      preview.src = `https://appassets.androidplatform.net/camera-test/clip.mp4?v=${encodeURIComponent(lastTestToken)}`;
      preview.load();
    }
    $('camera-test-help').textContent = state.testHasAudio
      ? 'Turn the tablet volume up and confirm court sounds are clear. This test clip is not muted.'
      : 'This configuration is video-only. Confirm that the picture is clear.';
    $('camera-test-confirm').textContent = state.testHasAudio ? 'I can see and hear the test' : 'The video looks clear';
  } else if (recordingFlow || (activeServerSession && state.phase !== 'complete')) {
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
  $('notice').textContent = !state.enabled
    ? state.enrolled ? 'Connection unavailable.' : ''
    : !state.cameraMode ? 'Camera setup is required.'
    : !state.tested ? 'Camera test is required.'
    : view === 'welcome' ? (state.message || '') : '';
  syncReenrollVisibility();
  if (state.initialized && !state.enabled && !state.enrolled && !enrollmentPrompted) {
    enrollmentPrompted = true;
    call('setup');
  }
}
tick();
renderEmails();
setInterval(tick, 750);
