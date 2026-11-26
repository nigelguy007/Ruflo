import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, SyntheticEvent } from 'react';
import { setToken, useTokenRejected, useTokenRequired } from '../lib/auth';

/**
 * Appears when the server answers 401. The token is kept in sessionStorage
 * for this tab only and sent as a Bearer header; it never reaches a URL.
 */
export function TokenPrompt() {
  const required = useTokenRequired();
  const rejected = useTokenRejected();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');
  const inputId = useId();
  const hintId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (required && !dialog.open) dialog.showModal();
    if (!required && dialog.open) dialog.close();
  }, [required]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;
    setValue('');
    setToken(token);
  };

  // Without a token nothing behind the dialog can load, so Escape does not dismiss it.
  const keepOpen = (event: SyntheticEvent<HTMLDialogElement>): void => event.preventDefault();

  return (
    <dialog ref={dialogRef} className="dialog token-prompt" aria-labelledby={`${inputId}-title`} onCancel={keepOpen}>
      <form onSubmit={handleSubmit} className="dialog__body">
        <p className="eyebrow">Locked</p>
        <h2 id={`${inputId}-title`} className="dialog__title">
          This Switchyard needs an access token
        </h2>
        <p id={hintId} className="dialog__text">
          It is the value of <code className="mono">SWITCHYARD_TOKEN</code> on the server. It is kept for this
          browser tab only and forgotten when you close it.
        </p>
        {rejected && (
          <p className="notice notice--stop" role="alert">
            The server did not accept that token. Check it and try again.
          </p>
        )}
        <label className="field">
          <span className="field__label">Access token</span>
          <input
            id={inputId}
            className="input mono"
            type="password"
            name="token"
            autoComplete="off"
            spellCheck={false}
            required
            aria-describedby={hintId}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="dialog__actions">
          <button type="submit" className="btn btn--primary">
            Unlock
          </button>
        </div>
      </form>
    </dialog>
  );
}
