/* Confirmations, alerts and toasts for the editor, all through SweetAlert2 (global `Swal`), with the editor's
   look and Portuguese texts. Exposes the global `Dialogs`.
   - Modals are queued: SweetAlert2 shows one popup at a time and a new `fire()` would silently dismiss the
     current one (resolving a pending confirmation as "cancelled").
   - Toasts never interrupt a modal; while one is open or queued the toast is dropped (the status line still
     carries the message).
   - The same title and text fired again while the first is still pending returns the first popup's promise.
   - A modal opened over an open <dialog> is mounted inside it, because the dialog's top layer would otherwise
     cover the popup and make it unclickable; Esc then closes only the popup, not the dialog underneath. */
(function (root) {
  "use strict";

  const Swal = root.Swal;
  let chain = Promise.resolve();
  let queued = 0;
  const pending = new Map();

  const BASE = {
    theme: "dark",
    buttonsStyling: false,
    reverseButtons: true,
    returnFocus: true,
    customClass: {
      popup: "ot-swal",
      confirmButton: "primary",
      denyButton: "danger",
      cancelButton: "",
      actions: "ot-swal-actions",
    },
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  /**
   * Escaped `<ul>` of at most `max` items, followed by "… e mais N" when the list is longer. `total` counts
   * items the caller did not receive (e.g. a server that returns only the first matches).
   */
  function list(items, max = 8, total = items.length) {
    const shown = items.slice(0, max).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    const hidden = total - Math.min(max, items.length);
    const rest = hidden > 0 ? `<li class="ot-swal-more">… e mais ${hidden}</li>` : "";
    return `<ul class="ot-swal-list">${shown}${rest}</ul>`;
  }

  function topDialog() {
    const open = [...document.querySelectorAll("dialog[open]")];
    return open.at(-1) ?? null;
  }

  function show(options) {
    if (!Swal) {
      console.error("SweetAlert2 não foi carregado:", options.title, options.text ?? "");
      return Promise.resolve({ isConfirmed: false, isDenied: false, isDismissed: true });
    }
    const dialog = topDialog();
    const keepDialogOpen = (event) => event.preventDefault();
    dialog?.addEventListener("cancel", keepDialogOpen);
    // A toast on screen leaves `swal2-toast-shown` on <html>/<body>, and SweetAlert2's
    // `body.swal2-toast-shown .swal2-container` rule then styles *every* container as a toast: 360px wide and
    // `pointer-events: none`. A modal mounted inside a <dialog> is not cleaned up by the toast's own close, so it
    // would let clicks fall through to the dialog underneath (e.g. toggling a property instead of "Cancelar").
    if (Swal.isVisible() && Swal.getPopup()?.classList.contains("swal2-toast")) Swal.close();
    clearToastState();
    return Swal.fire({
      ...BASE,
      ...options,
      target: dialog ?? document.body,
      customClass: { ...BASE.customClass, ...options.customClass },
      didOpen: clearToastState,
    }).finally(() => dialog?.removeEventListener("cancel", keepDialogOpen));
  }

  function clearToastState() {
    document.documentElement.classList.remove("swal2-toast-shown");
    document.body.classList.remove("swal2-toast-shown");
  }

  function fireModal(options) {
    const key = `${options.icon}|${options.title}|${options.text ?? options.html ?? ""}`;
    if (pending.has(key)) return pending.get(key);
    queued += 1;
    const result = chain.then(() => show(options));
    pending.set(key, result);
    chain = result.then(() => {}, () => {}).finally(() => {
      queued -= 1;
      pending.delete(key);
    });
    return result;
  }

  /**
   * Resolves true only when the user clicks the confirm button; Esc, the backdrop and "Cancelar" resolve false.
   * `danger` styles the confirm button as destructive and focuses "Cancelar" so Enter does not destroy data.
   */
  async function confirm({ title, text, html, confirmText = "Confirmar", cancelText = "Cancelar", icon = "warning", danger = false }) {
    const result = await fireModal({
      icon,
      title,
      ...(html === undefined ? { text } : { html }),
      showCancelButton: true,
      confirmButtonText: confirmText,
      cancelButtonText: cancelText,
      focusCancel: danger,
      customClass: danger ? { confirmButton: "danger" } : {},
    });
    return result.isConfirmed === true;
  }

  function alert(icon, title, { text, html, confirmText = "OK" } = {}) {
    return fireModal({ icon, title, ...(html === undefined ? { text } : { html }), confirmButtonText: confirmText }).then(() => undefined);
  }

  function toast(message, icon = "success") {
    if (!Swal || queued > 0) return;
    Swal.fire({
      ...BASE,
      toast: true,
      position: "top-end",
      icon,
      title: message,
      showConfirmButton: false,
      timer: 3200,
      timerProgressBar: true,
      customClass: { popup: "ot-swal ot-swal-toast" },
    });
  }

  root.Dialogs = {
    confirm,
    success: (title, options) => alert("success", title, options),
    error: (title, options) => alert("error", title, options),
    warning: (title, options) => alert("warning", title, options),
    info: (title, options) => alert("info", title, options),
    toast,
    list,
    escapeHtml,
    get busy() {
      return queued > 0;
    },
  };
})(globalThis);
