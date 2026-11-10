/**
 * Inline styles for the WeChat tab.
 *
 * Inline (not a stylesheet) on purpose: this bundle ships no CSS, so there is
 * nothing to inject on load or clean up on unload. Every colour comes from a DSH
 * theme alias token, so the tab follows the active skin and light/dark switching.
 * Each token carries a fallback from the same family this build defines: an unset
 * custom property would silently invalidate the whole declaration.
 */
import type { CSSProperties } from "react";

/** Theme aliases this view consumes. */
export const token = {
  surface: "var(--dsw-alias-bg-layer-1)",
  raised: "var(--dsw-alias-bg-layer-2)",
  border: "var(--dsw-alias-border-l2)",
  hairline: "var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))",
  text: "var(--dsw-alias-label-primary)",
  textSecondary: "var(--dsw-alias-label-secondary)",
  textTertiary: "var(--dsw-alias-label-tertiary)",
  accent: "var(--dsw-alias-state-business-primary)",
  accentFill: "var(--dsw-alias-button-primary-fill)",
  accentFillHover: "var(--dsw-alias-button-primary-hover)",
  success: "var(--dsw-alias-state-success-primary)",
  danger: "var(--dsw-alias-state-error-primary)",
  hover: "var(--dsw-alias-interactive-bg-hover)",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** Root panel: the sidebar page itself. */
export const panel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
  overflowY: "auto",
  background: token.surface,
  color: token.text,
  fontSize: 12,
  lineHeight: 1.55,
};

/** One bordered block. */
export const card: CSSProperties = {
  margin: "10px 12px 0",
  padding: 10,
  border: `1px solid ${token.hairline}`,
  borderRadius: 8,
  background: token.raised,
};

/** The last card keeps the bottom breathing room. */
export const cardLast: CSSProperties = { ...card, marginBottom: 14 };

/** Card heading row. */
export const cardHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: 8,
};

/** Heading text. */
export const title: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: token.text,
};

/** Secondary explanatory line. */
export const hint: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 11,
  color: token.textSecondary,
};

/** Faint metadata line. */
export const meta: CSSProperties = {
  fontSize: 11,
  color: token.textTertiary,
  fontFamily: token.mono,
  wordBreak: "break-all",
};

/** Primary button. */
export const primaryButton: CSSProperties = {
  font: "inherit",
  fontSize: 12,
  padding: "5px 12px",
  borderRadius: 6,
  border: `1px solid ${token.accentFill}`,
  background: token.accentFill,
  color: "#fff",
  cursor: "pointer",
};

/** Secondary button. */
export const secondaryButton: CSSProperties = {
  font: "inherit",
  fontSize: 12,
  padding: "5px 12px",
  borderRadius: 6,
  border: `1px solid ${token.border}`,
  background: "transparent",
  color: token.text,
  cursor: "pointer",
};

/** Disabled state shared by both buttons. */
export const disabled: CSSProperties = { opacity: 0.55, cursor: "default" };

/** Text input. */
export const input: CSSProperties = {
  font: "inherit",
  fontSize: 12,
  width: 96,
  padding: "5px 8px",
  borderRadius: 6,
  border: `1px solid ${token.border}`,
  background: token.surface,
  color: token.text,
};

/**
 * Select box.
 *
 * A fixed compact height, deliberately: this control sits in a **column** flex
 * box (`field`), where a `flex-basis` becomes a *height* — which is how the
 * preset pickers first rendered ~140px tall. `flex: none` keeps it at one line
 * however much room the card has.
 */
export const select: CSSProperties = {
  font: "inherit",
  fontSize: 12,
  lineHeight: "18px",
  height: 26,
  maxHeight: 26,
  boxSizing: "border-box",
  padding: "0 6px",
  borderRadius: 6,
  border: `1px solid ${token.border}`,
  background: token.surface,
  color: token.text,
  width: "100%",
  minWidth: 0,
  flex: "none",
};

/** One labelled control: caption above, control below, wrapping on narrow panes. */
export const field: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 4,
  marginBottom: 8,
};

/** Status pill. */
export function pill(color: string): CSSProperties {
  return {
    display: "inline-block",
    padding: "0 8px",
    borderRadius: 999,
    border: `1px solid ${color}`,
    color,
    fontSize: 11,
    lineHeight: "18px",
  };
}

/** The QR image frame. */
export const qrFrame: CSSProperties = {
  width: 196,
  height: 196,
  borderRadius: 8,
  border: `1px solid ${token.hairline}`,
  background: "#fff",
  objectFit: "contain",
  display: "block",
  margin: "0 auto",
};

/** Placeholder shown before a QR code exists. */
export const qrPlaceholder: CSSProperties = {
  ...qrFrame,
  background: token.surface,
  color: token.textTertiary,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  fontSize: 11,
  padding: 12,
};

/** Row of controls. */
export const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 8,
  flexWrap: "wrap",
};

/** Error line. */
export const errorText: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 11,
  color: token.danger,
};

/** A link that looks like one. */
export const link: CSSProperties = {
  color: token.accent,
  textDecoration: "none",
  fontSize: 11,
};

/** One row inside the directory picker (a button styled as a list line). */
export const pickerRow: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  font: "inherit",
  fontSize: 12,
  padding: "4px 8px",
  border: "none",
  background: "transparent",
  color: token.text,
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/**
 * Full-viewport backdrop behind the directory dialog.
 *
 * `position: fixed` (not `absolute`) so the dialog escapes the sidebar's own
 * scroll container; the high z-index puts it above DSH's panels without
 * touching any of their styles.
 */
export const modalBackdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 2147483000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "rgba(0, 0, 0, 0.42)",
};

/** The dialog surface. */
export const modalPanel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "min(560px, 100%)",
  maxHeight: "min(72vh, 640px)",
  minHeight: 280,
  border: `1px solid ${token.border}`,
  borderRadius: 10,
  background: token.raised,
  color: token.text,
  boxShadow: "0 18px 50px rgba(0, 0, 0, 0.28)",
  overflow: "hidden",
};

/** Dialog title row. */
export const modalHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "10px 12px",
  borderBottom: `1px solid ${token.hairline}`,
};

/** Scrollable middle section of the dialog. */
export const modalBody: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
  padding: "8px 6px",
};

/** Dialog footer with the primary actions. */
export const modalFooter: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "10px 12px",
  borderTop: `1px solid ${token.hairline}`,
};
