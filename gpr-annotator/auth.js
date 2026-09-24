/* Google sign-in for GPR Annotator (Firebase Auth, shared RAK project).

   A classic script, loaded before app.js, so window.GprAuth exists as soon as
   the app starts. The Firebase SDK itself is pulled in with dynamic import().

   The sign-in screen only controls the UI. What protects the Gemini key is the
   server, which checks the ID token on every API call and asks Firestore
   whether the rules approve the user (server-auth.js). Pages opened from
   file:// skip the screen: Firebase cannot sign in there, and without a server
   there is nothing server-side to protect. */

(function (root) {
  'use strict';

  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

  // Public client identifiers, not secrets. Access is enforced by the server's
  // token check and by the Firestore rules, never by keeping these hidden.
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBrJn0ro_UUrMpsfgo4hrqsddFdaWJDJUg',
    authDomain: 'gprportal-49b88.firebaseapp.com',
    projectId: 'gprportal-49b88',
    storageBucket: 'gprportal-49b88.firebasestorage.app',
    messagingSenderId: '359657743094',
    appId: '1:359657743094:web:e77d934f5179084bb202d7',
    measurementId: 'G-M5BDEYSZN2',
  };

  const bypass = location.protocol === 'file:';

  let auth = null;
  let sdk = null;
  let currentUser = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  /* ── Sign-in screen ─────────────────────────────────── */

  const gate = document.createElement('div');
  gate.className = 'auth-gate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.setAttribute('aria-labelledby', 'auth-title');
  gate.innerHTML = `
    <div class="auth-card">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M6 14c2-9 10-9 12 0M9 14c1-4 5-4 6 0"/></svg></span>
      <h2 id="auth-title">Sign in to GPR Annotator</h2>
      <p class="auth-msg">Checking your sign-in…</p>
      <p class="auth-detail" hidden></p>
      <div class="auth-actions">
        <button type="button" class="btn primary auth-signin" hidden>Sign in with Google</button>
        <button type="button" class="btn ghost auth-signout" hidden>Use a different account</button>
      </div>
    </div>`;

  const $msg = gate.querySelector('.auth-msg');
  const $detail = gate.querySelector('.auth-detail');
  const $signIn = gate.querySelector('.auth-signin');
  const $signOut = gate.querySelector('.auth-signout');

  function showGate({ msg, detail = '', signIn = false, signOut = false }) {
    $msg.textContent = msg;
    $detail.textContent = detail;
    $detail.hidden = !detail;
    $signIn.hidden = !signIn;
    $signOut.hidden = !signOut;
    gate.hidden = false;
    document.documentElement.classList.add('auth-locked');
    (signIn ? $signIn : signOut ? $signOut : null)?.focus();
  }

  function hideGate() {
    gate.hidden = true;
    document.documentElement.classList.remove('auth-locked');
  }

  /* Account button in the top bar: shows who is signed in, click to sign out. */
  function renderAccount(user) {
    const bar = document.querySelector('.topbar-actions');
    if (!bar) return;
    let btn = document.getElementById('btn-account');
    if (!user) { btn?.remove(); return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btn-account';
      btn.type = 'button';
      btn.className = 'btn ghost icon-btn account-btn';
      btn.addEventListener('click', signOut);
      bar.prepend(btn);
    }
    const who = user.email || user.displayName || user.uid;
    btn.textContent = (user.displayName || user.email || '?').trim().charAt(0).toUpperCase();
    btn.title = `Signed in as ${who}. Click to sign out.`;
    btn.setAttribute('aria-label', `Signed in as ${who}. Sign out`);
  }

  /* ── Firebase ───────────────────────────────────────── */

  async function start() {
    try {
      const [app, authMod] = await Promise.all([
        import(`${FIREBASE_SDK}/firebase-app.js`),
        import(`${FIREBASE_SDK}/firebase-auth.js`),
      ]);
      sdk = authMod;
      auth = sdk.getAuth(app.initializeApp(FIREBASE_CONFIG));
    } catch (err) {
      showGate({
        msg: 'Could not load Google sign-in.',
        detail: `Check your connection, then reload. (${err.message})`,
      });
      return;
    }

    sdk.onAuthStateChanged(auth, onUser);
  }

  async function onUser(user) {
    currentUser = user;
    renderAccount(user);

    if (!user) {
      showGate({ msg: 'Use your RAK Google account. Access is limited to approved users.', signIn: true });
      return;
    }

    showGate({ msg: `Checking access for ${user.email || 'your account'}…` });

    let res;
    try {
      res = await authFetch('/api/me', { cache: 'no-store' });
    } catch {
      res = null;
    }

    // No API server on this origin (e.g. a plain static preview): nothing to gate.
    if (!res || res.status === 404) {
      hideGate();
      resolveReady(user);
      return;
    }

    const me = await res.json().catch(() => ({}));

    if (res.ok && me.allowed) {
      hideGate();
      resolveReady(user);
      root.dispatchEvent(new CustomEvent('gpr-auth', { detail: { user } }));
      return;
    }

    if (res.ok) {
      showGate({
        msg: `${me.email || user.email || 'This account'} is not approved for GPR Annotator.`,
        detail: `Ask an admin to add this UID to isAllowedUser() in the Firestore rules: ${me.uid || user.uid}`,
        signOut: true,
      });
      return;
    }

    showGate({
      msg: 'Your sign-in could not be verified.',
      detail: me.error || `HTTP ${res.status}`,
      signIn: true,
      signOut: true,
    });
  }

  async function signIn() {
    if (!auth) return;
    const provider = new sdk.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await sdk.signInWithPopup(auth, provider);
    } catch (err) {
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
      showGate({
        msg: 'Sign-in failed.',
        detail: err.code === 'auth/unauthorized-domain'
          ? `${location.hostname} is not an authorized domain for this Firebase project. Add it under Authentication → Settings → Authorized domains.`
          : err.code === 'auth/popup-blocked'
            ? 'The browser blocked the sign-in popup. Allow popups for this site and try again.'
            : (err.message || String(err)),
        signIn: true,
      });
    }
  }

  async function signOut() {
    if (auth) await sdk.signOut(auth);
  }

  /* Current ID token. Firebase refreshes it before it expires (after an hour). */
  async function token() {
    return currentUser ? currentUser.getIdToken() : null;
  }

  /* fetch() with the signed-in user's token attached. */
  async function authFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    const t = await token();
    if (t) headers.set('Authorization', `Bearer ${t}`);
    return fetch(url, { ...options, headers });
  }

  $signIn.addEventListener('click', signIn);
  $signOut.addEventListener('click', signOut);

  root.GprAuth = { ready, token, fetch: authFetch, signOut, bypassed: bypass };

  if (bypass) {
    resolveReady(null);
  } else {
    document.body.appendChild(gate);
    showGate({ msg: 'Checking your sign-in…' });
    start();
  }
})(window);
