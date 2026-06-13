(() => {
  const style = document.createElement('style');
  style.textContent = `
    #authDialog {
      border: none;
      border-radius: 14px;
      background: #1a1a1a;
      color: #f0f0f0;
      padding: 2rem 1.5rem;
      width: min(360px, calc(100vw - 2rem));
      box-shadow: 0 8px 40px rgba(0,0,0,0.7);
    }
    #authDialog::backdrop {
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(2px);
    }
    #authDialog h2 {
      font-size: 1.5rem;
      font-weight: 800;
      color: #e03131;
      margin-bottom: 0.2rem;
    }
    #authDialog .ad-subtitle {
      color: #888;
      font-size: 0.88rem;
      margin-bottom: 1.75rem;
    }
    #authDialog .ad-step { display: none; }
    #authDialog .ad-step.active { display: block; }
    #authDialog label {
      display: block;
      font-size: 0.75rem;
      font-weight: 600;
      color: #aaa;
      margin-bottom: 0.35rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    #authDialog input {
      width: 100%;
      padding: 0.7rem 0.9rem;
      background: #111;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      color: #f0f0f0;
      font-size: 1rem;
      outline: none;
      margin-bottom: 1rem;
      transition: border-color 0.15s;
      box-sizing: border-box;
    }
    #authDialog input:focus { border-color: #e03131; }
    #authDialog .ad-submit {
      width: 100%;
      padding: 0.75rem;
      background: #e03131;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    }
    #authDialog .ad-submit:hover { background: #c82a2a; }
    #authDialog .ad-submit:disabled { background: #555; cursor: not-allowed; }
    #authDialog .ad-error {
      color: #e03131;
      font-size: 0.82rem;
      margin-top: 0.65rem;
      min-height: 1.1em;
    }
    #authDialog .ad-hint {
      color: #666;
      font-size: 0.82rem;
      margin-top: 0.65rem;
    }
    #authDialog .ad-hint a { color: #e03131; text-decoration: none; }
    #authDialog .ad-uname-status {
      font-size: 0.78rem;
      margin-top: -0.75rem;
      margin-bottom: 1rem;
      min-height: 1em;
    }
    #authDialog .ad-uname-status.ok { color: #3a3; }
    #authDialog .ad-uname-status.bad { color: #e03131; }
  `;
  document.head.appendChild(style);

  const dlg = document.createElement('dialog');
  dlg.id = 'authDialog';
  dlg.innerHTML = `
    <h2>NavCook</h2>
    <p class="ad-subtitle" id="adSubtitle">Sign in or create an account</p>

    <div class="ad-step active" id="adStep1">
      <form id="adEmailForm">
        <label for="adEmail">Email address</label>
        <input id="adEmail" type="email" autocomplete="email" placeholder="you@example.com" required>
        <button type="submit" class="ad-submit" id="adSendBtn">Send code</button>
        <p class="ad-error" id="adEmailErr"></p>
      </form>
    </div>

    <div class="ad-step" id="adStep2">
      <form id="adCodeForm">
        <label for="adCode">6-digit code</label>
        <input id="adCode" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" autocomplete="one-time-code">
        <button type="submit" class="ad-submit" id="adVerifyBtn">Verify</button>
        <p class="ad-error" id="adCodeErr"></p>
        <p class="ad-hint"><a href="#" id="adResend">Resend code</a></p>
      </form>
    </div>

    <div class="ad-step" id="adStep3">
      <form id="adUnameForm">
        <label for="adUname">Choose a username</label>
        <input id="adUname" type="text" autocomplete="username" placeholder="coolchef" maxlength="30">
        <p class="ad-uname-status" id="adUnameStatus"></p>
        <button type="submit" class="ad-submit" id="adCreateBtn" disabled>Create account</button>
        <p class="ad-error" id="adUnameErr"></p>
      </form>
    </div>
  `;
  document.body.appendChild(dlg);

  let _email = '', _code = '', _onSuccess = null, _unameTimer = null;

  function adShowStep(n) {
    dlg.querySelectorAll('.ad-step').forEach((el, i) => el.classList.toggle('active', i + 1 === n));
  }

  function adReset() {
    _email = ''; _code = '';
    dlg.querySelector('#adSubtitle').textContent = 'Sign in or create an account';
    dlg.querySelector('#adEmail').value = '';
    dlg.querySelector('#adCode').value = '';
    dlg.querySelector('#adUname').value = '';
    dlg.querySelector('#adEmailErr').textContent = '';
    dlg.querySelector('#adCodeErr').textContent = '';
    dlg.querySelector('#adUnameErr').textContent = '';
    dlg.querySelector('#adUnameStatus').textContent = '';
    dlg.querySelector('#adCreateBtn').disabled = true;
    adShowStep(1);
  }

  // Close on backdrop click
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  // Step 1 — send code
  dlg.querySelector('#adEmailForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = dlg.querySelector('#adEmail').value.trim();
    const btn = dlg.querySelector('#adSendBtn');
    const err = dlg.querySelector('#adEmailErr');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) { err.textContent = data.error; return; }
      _email = email;
      dlg.querySelector('#adSubtitle').textContent = data.isNewUser
        ? `We'll create an account for ${email}`
        : `Check ${email} for your code`;
      adShowStep(2);
      dlg.querySelector('#adCode').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send code';
    }
  });

  // Resend
  dlg.querySelector('#adResend').addEventListener('click', async e => {
    e.preventDefault();
    const err = dlg.querySelector('#adCodeErr');
    err.style.color = '';
    err.textContent = '';
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: _email }),
      });
      if (res.ok) { err.style.color = '#3a3'; err.textContent = 'New code sent!'; }
      else { err.textContent = (await res.json()).error; }
    } catch { err.textContent = 'Network error'; }
  });

  // Step 2 — verify code
  dlg.querySelector('#adCodeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const code = dlg.querySelector('#adCode').value.trim();
    const btn = dlg.querySelector('#adVerifyBtn');
    const err = dlg.querySelector('#adCodeErr');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
      const res = await fetch('/api/auth/verify-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: _email, code }),
      });
      const data = await res.json();
      if (!res.ok) { err.textContent = data.error; return; }
      if (data.needsUsername) {
        _code = code;
        dlg.querySelector('#adSubtitle').textContent = 'One last step';
        adShowStep(3);
        dlg.querySelector('#adUname').focus();
      } else {
        dlg.close();
        if (_onSuccess) _onSuccess({ username: data.username });
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify';
    }
  });

  // Step 3 — username check
  dlg.querySelector('#adUname').addEventListener('input', e => {
    const val = e.target.value.trim();
    const status = dlg.querySelector('#adUnameStatus');
    const btn = dlg.querySelector('#adCreateBtn');
    clearTimeout(_unameTimer);
    btn.disabled = true;
    if (!val) { status.textContent = ''; return; }
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(val)) {
      status.className = 'ad-uname-status bad';
      status.textContent = '3–30 chars: letters, numbers, underscores only';
      return;
    }
    status.className = 'ad-uname-status';
    status.textContent = 'Checking…';
    _unameTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/auth/check-username?username=${encodeURIComponent(val)}`);
        const data = await res.json();
        if (data.available) {
          status.className = 'ad-uname-status ok';
          status.textContent = `${val} is available`;
          btn.disabled = false;
        } else {
          status.className = 'ad-uname-status bad';
          status.textContent = `${val} is taken`;
        }
      } catch { status.textContent = ''; }
    }, 350);
  });

  // Step 3 — create account
  dlg.querySelector('#adUnameForm').addEventListener('submit', async e => {
    e.preventDefault();
    const username = dlg.querySelector('#adUname').value.trim();
    const btn = dlg.querySelector('#adCreateBtn');
    const err = dlg.querySelector('#adUnameErr');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const res = await fetch('/api/auth/set-username', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: _email, code: _code, username }),
      });
      const data = await res.json();
      if (!res.ok) { err.textContent = data.error; btn.disabled = false; btn.textContent = 'Create account'; return; }
      dlg.close();
      if (_onSuccess) _onSuccess({ username: data.username });
    } catch { err.textContent = 'Network error'; btn.disabled = false; btn.textContent = 'Create account'; }
  });

  window.showAuthDialog = function(onSuccess) {
    _onSuccess = onSuccess || null;
    adReset();
    dlg.showModal();
    dlg.querySelector('#adEmail').focus();
  };
})();
