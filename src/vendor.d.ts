/**
 * Ambient declarations for optional runtime dependencies.
 *
 * `qrcode` is only used to render the login QR code. It is declared here with
 * the calls this plugin makes so the build never depends on `@types/qrcode`
 * being installed, and every import stays dynamic so a missing package degrades
 * to "show the URL instead of the QR image".
 */
declare module "qrcode" {
  interface RenderOptions {
    margin?: number;
    width?: number;
    small?: boolean;
    type?: "utf8" | "terminal" | "svg" | "png";
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }
  export function toDataURL(text: string, options?: RenderOptions): Promise<string>;
  export function toString(text: string, options?: RenderOptions): Promise<string>;
  export function toBuffer(text: string, options?: RenderOptions): Promise<Uint8Array>;
}

/** Optional SILK → WAV transcoder for inbound voice messages. */
declare module "silk-wasm" {
  export function decode(
    input: Uint8Array,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; duration: number }>;
}
