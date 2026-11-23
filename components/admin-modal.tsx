"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";

export function AdminModal({
  title, description, icon: Icon, tone = "default", busy = false, onDismiss, children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  tone?: "default" | "danger";
  busy?: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="admin-modal"
      data-tone={tone}
      closedby={busy ? "none" : "closerequest"}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onDismiss();
      }}
      onClose={(event) => {
        const dialog = event.currentTarget;
        if (busy && !dialog.open && dialog.isConnected) dialog.showModal();
      }}
      onClick={(event) => {
        if (busy || event.target !== event.currentTarget) return;
        const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
        if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom)
          onDismiss();
      }}
    >
      <div className="admin-modal-header">
        <span className="admin-modal-icon"><Icon size={21} aria-hidden="true" /></span>
        <button type="button" className="admin-modal-close" aria-label="Close dialog" disabled={busy} onClick={onDismiss}>
          <X size={19} aria-hidden="true" />
        </button>
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-description`}>{description}</p>
      </div>
      {children}
    </dialog>
  );
}
