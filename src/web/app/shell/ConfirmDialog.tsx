import { useEffect, useId, useRef } from 'react';
import type { MouseEvent, ReactNode, SyntheticEvent } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** True while the confirmed action is in flight. */
  busy?: boolean;
  /** Shown inside the dialog when the action failed. */
  problem?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A native modal dialog: focus is trapped and returned by the browser, Escape cancels. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel,
  busy = false,
  problem = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const handleNativeCancel = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.preventDefault();
    if (!busy) onCancel();
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>): void => {
    if (event.target === dialogRef.current && !busy) onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={handleNativeCancel}
      onClick={handleBackdropClick}
    >
      <div className="dialog__body">
        <h2 id={titleId} className="dialog__title">
          {title}
        </h2>
        <div className="dialog__text">{children}</div>
        {problem && (
          <p className="notice notice--stop" role="alert">
            {problem}
          </p>
        )}
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy} autoFocus>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
