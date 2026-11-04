// /join#token=... Invite links carry the token in the fragment, which is never sent to the server.
// The token is moved to sessionStorage, the fragment is removed from history, and the person lands signed in
// (on `next` when the fragment names an app path, e.g. #token=…&next=/pair/ABCD2345).
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { safeNextPath } from '@/screens/connect/logic';
import { Page } from './Page';
import { useMock } from './store';
import { Standalone } from './Standalone';

export function JoinRoute() {
  const { signIn } = useMock();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // Read the fragment once; StrictMode may run the effect twice, so the token is captured in state.
  const [{ token, next }] = useState(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    // Optional `next` (an app path such as /pair/ABCD2345) continues there after signing in.
    return { token: params.get('token'), next: safeNextPath(params.get('next')) };
  });

  useEffect(() => {
    // Drop the fragment from history (the app is served under BASE_URL, /ui/).
    window.history.replaceState(null, '', `${import.meta.env.BASE_URL.replace(/\/$/, '')}/join`);
    if (!token) {
      setError('This invite link has no token in it. Ask the person who invited you to send it again.');
      return;
    }
    let cancelled = false;
    void signIn(token).then(result => {
      if (cancelled) return;
      if (result.ok) navigate(next ?? '/', { replace: true });
      else setError(result.reason);
    });
    return () => { cancelled = true; };
  }, [token, next, signIn, navigate]);

  return (
    <Standalone>
      <Page title={error ? 'This invite did not work' : 'Joining workspace'} width="narrow" notices={false}
        description={error ?? 'Checking your invite.'}>
        {error && <p><Link to="/signin">Sign in with a token instead</Link></p>}
      </Page>
    </Standalone>
  );
}
